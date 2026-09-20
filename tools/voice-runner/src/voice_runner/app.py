"""voice-runner の HTTP API。

音声とASRのBackendを、この単一のサービスの背後へ置く。Application APIからは常に
HTTPで呼び、ローカル構成とリモート構成の差を接続先URLだけに閉じ込める。

wavと参照音声はbodyのJSONへbase64で載せる。リモート構成ではrunner側のファイル
システムに参照音声が存在せず、パスでは渡せないためである。
"""

import base64
import binascii
import logging
import tempfile
import wave
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette import status

from voice_runner import config as config_module
from voice_runner.process import WorkerFailed, WorkerTimeout, run_worker

logger = logging.getLogger(__name__)

TTS_WORKER = "tts_worker.py"
ASR_WORKER = "asr_worker.py"

#: 受け取るwavの上限。Application API側の上限と揃える。
MAX_AUDIO_BYTES = 32 * 1024 * 1024


class RunnerModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SpeechRequest(RunnerModel):
    engine: str = Field(min_length=1)
    text: str = Field(min_length=1)
    reading: str | None = None
    language: str = "ja"
    #: 参照音声のwav(base64)。
    reference_audio: str = Field(min_length=1)
    reference_transcript: str = Field(min_length=1)
    seed: int = Field(ge=0)
    timeout_sec: float | None = Field(default=None, gt=0)


class SpeechResponse(RunnerModel):
    wav: str
    sample_rate: int
    audio_sec: float
    elapsed_sec: float | None = None
    vram_peak_mb: float | None = None
    model: str | None = None
    revision: str | None = None
    seed: int


class TranscribeRequest(RunnerModel):
    wav: str = Field(min_length=1)
    language: str = "ja"


class TranscribeResponse(RunnerModel):
    text: str
    duration_sec: float | None = None
    model: str | None = None


class EngineHealth(RunnerModel):
    id: str
    available: bool
    model: str | None = None
    revision: str | None = None
    sample_rate: int | None = None
    needs_katakana: bool = False
    detail: str | None = None


class HealthResponse(RunnerModel):
    engines: list[EngineHealth]
    asr_available: bool
    asr_model: str | None = None


def _decode(raw: str, label: str) -> bytes:
    # 復号の前に文字数で弾く。要求本文そのものは受信した時点でメモリに載っているが、
    # 復号を通すと上限を超える分の複製がもう1つ増える。base64は3バイトを4文字で表す
    # ため、文字数から上限を逆算する。
    if len(raw) > (MAX_AUDIO_BYTES + 2) // 3 * 4:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"{label}が上限({MAX_AUDIO_BYTES}バイト)を超えています。",
        )
    try:
        data = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"{label}を復号できません。"
        ) from error
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"{label}が上限({MAX_AUDIO_BYTES}バイト)を超えています。",
        )
    return data


def _audio_seconds(path: Path) -> tuple[float, int]:
    """生成されたwavの尺とsample rateを読む。"""
    with wave.open(str(path), "rb") as source:
        frames = source.getnframes()
        rate = source.getframerate()
    return (frames / rate if rate else 0.0), rate


#: 受け付ける要求本文の上限。base64の膨らみと、他の項目ぶんの余裕を足す。
MAX_REQUEST_BYTES = (MAX_AUDIO_BYTES + 2) // 3 * 4 + 64 * 1024


def create_app() -> FastAPI:
    app = FastAPI(title="MyComfyUI voice-runner", version="0.1.0")

    @app.middleware("http")
    async def limit_request_body(request: Request, call_next):
        """`Content-Length`が上限を超える要求は本文を読まずに断る。

        ここを通すと、上限を超える本文でも丸ごとメモリへ載ってからでないと
        断れない。長さを申告しない要求(chunked)は測れないため、`_decode`の
        長さ判定に委ねる。
        """
        declared = request.headers.get("Content-Length")
        if (
            declared is not None
            and declared.isdigit()
            and int(declared) > MAX_REQUEST_BYTES
        ):
            return JSONResponse(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                content={"detail": "要求本文が大きすぎます。"},
            )
        return await call_next(request)

    @app.get("/v1/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        """engineの一覧と利用可否を返す。モデルはロードしない。"""
        settings = config_module.get_config()
        return HealthResponse(
            engines=[
                EngineHealth(
                    id=engine.id,
                    available=engine.available,
                    model=engine.model_id,
                    revision=engine.model_revision,
                    sample_rate=engine.sample_rate,
                    needs_katakana=engine.needs_katakana,
                    detail=engine.detail,
                )
                for engine in settings.engines.values()
            ],
            asr_available=settings.asr.available,
            asr_model=settings.asr.model_id,
        )

    @app.post("/v1/speech", response_model=SpeechResponse)
    async def speech(payload: SpeechRequest) -> SpeechResponse:
        settings = config_module.get_config()
        try:
            engine = settings.engine(payload.engine)
        except config_module.ConfigError as error:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(error)) from error
        if not engine.available:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                engine.detail or "engineが使えません。",
            )
        reference = _decode(payload.reference_audio, "参照音声")
        timeout = payload.timeout_sec or engine.timeout_sec
        with tempfile.TemporaryDirectory(prefix="voice-runner-") as raw_dir:
            workdir = Path(raw_dir)
            reference_path = workdir / "reference.wav"
            reference_path.write_bytes(reference)
            output_path = workdir / "out.wav"
            request: dict[str, Any] = {
                "engine": engine.id,
                "model_id": engine.model_id,
                "model_revision": engine.model_revision,
                "sample_rate": engine.sample_rate,
                "needs_katakana": engine.needs_katakana,
                "katakana_home": str(engine.home) if engine.home else None,
                "mode": engine.mode,
                "text": payload.text,
                "reading": payload.reading,
                "language": payload.language,
                "reference_audio": str(reference_path),
                "reference_transcript": payload.reference_transcript,
                "seed": payload.seed,
                "output": str(output_path),
            }
            result = await _invoke(engine.python, TTS_WORKER, request, workdir, timeout)
            if not output_path.is_file():
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY, "Backendがwavを出力しませんでした。"
                )
            wav = output_path.read_bytes()
            try:
                audio_sec, sample_rate = _audio_seconds(output_path)
            except (wave.Error, OSError) as error:
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY,
                    "Backendが出力したwavを読めませんでした。",
                ) from error
        return SpeechResponse(
            wav=base64.b64encode(wav).decode("ascii"),
            sample_rate=int(result.get("sample_rate") or sample_rate),
            audio_sec=float(result.get("audio_sec") or audio_sec),
            elapsed_sec=_number(result.get("elapsed_sec")),
            vram_peak_mb=_number(result.get("vram_peak_mb")),
            model=result.get("model") or engine.model_id,
            revision=result.get("revision") or engine.model_revision,
            seed=int(result.get("seed", payload.seed)),
        )

    @app.post("/v1/transcribe", response_model=TranscribeResponse)
    async def transcribe(payload: TranscribeRequest) -> TranscribeResponse:
        settings = config_module.get_config()
        if not settings.asr.available:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE, "ASRのPythonがありません。"
            )
        wav = _decode(payload.wav, "音声")
        with tempfile.TemporaryDirectory(prefix="voice-runner-") as raw_dir:
            workdir = Path(raw_dir)
            audio_path = workdir / "input.wav"
            audio_path.write_bytes(wav)
            request = {
                "model_id": settings.asr.model_id,
                "language": payload.language or settings.asr.language,
                "audio": str(audio_path),
            }
            result = await _invoke(
                settings.asr.python,
                ASR_WORKER,
                request,
                workdir,
                settings.asr.timeout_sec,
            )
        text = result.get("text")
        if not isinstance(text, str):
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "ASRが書き起こしを返しませんでした。"
            )
        return TranscribeResponse(
            text=text,
            duration_sec=_number(result.get("duration_sec")),
            model=result.get("model") or settings.asr.model_id,
        )

    return app


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) else None


async def _invoke(
    python: Path,
    script: str,
    request: dict[str, Any],
    workdir: Path,
    timeout: float,
) -> dict[str, Any]:
    """worker実行の失敗を、呼び出し側が種別で判定できるHTTPへ翻訳する。"""
    try:
        return await run_worker(python, script, request, workdir, timeout)
    except WorkerTimeout as error:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, str(error)) from error
    except WorkerFailed as error:
        logger.info("Backendの実行が失敗しました。script=%s", script, exc_info=error)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(error)) from error


app = create_app()
