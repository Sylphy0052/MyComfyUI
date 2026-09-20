"""voice-runner HTTP APIクライアント。

runnerのEndpoint仕様と応答形状の知識はこのモジュールへ閉じ込め、上位層へは
`base`の例外型とデータ構造だけを返す。秘密情報は扱わない。ログへ残すのは操作名、
engine、結果だけとする。
"""

import base64
import binascii
import logging
from typing import Any

import httpx

from mycomfyui_api.adapters.voice.base import (
    EngineInfo,
    RunnerHealth,
    SpeechRequest,
    SpeechResult,
    TranscribeResult,
    VoiceExecutionFailed,
    VoicePayloadTooLarge,
    VoiceTimeout,
    VoiceUnavailable,
)
from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

#: 疎通確認は生成本体より短い時間で打ち切る。
HEALTH_TIMEOUT_SECONDS = 10.0


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) else None


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


class VoiceRunnerClient:
    """voice-runnerへHTTPで問い合わせる。

    `transport`はテストでhttpxのMockTransportを差し込むための拡張点であり、通常利用
    では指定しない。
    """

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._base_url = self._settings.voice_runner_base_url.rstrip("/")
        self._timeout = self._settings.voice_runner_timeout_seconds
        self._max_bytes = self._settings.voice_max_audio_bytes
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(self._timeout),
            transport=transport,
        )

    @property
    def base_url(self) -> str:
        return self._base_url

    async def aclose(self) -> None:
        await self._client.aclose()

    async def health(self) -> RunnerHealth:
        payload = await self._get("/v1/health", timeout=HEALTH_TIMEOUT_SECONDS)
        raw_engines = payload.get("engines")
        engines: list[EngineInfo] = []
        if isinstance(raw_engines, list):
            for item in raw_engines:
                if not isinstance(item, dict):
                    continue
                engine_id = _text(item.get("id"))
                if engine_id is None:
                    continue
                sample_rate = item.get("sample_rate")
                engines.append(
                    EngineInfo(
                        id=engine_id,
                        available=bool(item.get("available")),
                        model=_text(item.get("model")),
                        revision=_text(item.get("revision")),
                        sample_rate=(
                            int(sample_rate) if isinstance(sample_rate, int) else None
                        ),
                        needs_katakana=bool(item.get("needs_katakana")),
                        detail=_text(item.get("detail")),
                    )
                )
        return RunnerHealth(base_url=self._base_url, engines=tuple(engines))

    async def speech(self, request: SpeechRequest) -> SpeechResult:
        self._guard_size(len(request.reference_audio), "参照音声")
        body: dict[str, Any] = {
            "engine": request.engine,
            "text": request.text,
            "reading": request.reading,
            "language": request.language,
            "reference_audio": base64.b64encode(request.reference_audio).decode(
                "ascii"
            ),
            "reference_transcript": request.reference_transcript,
            "seed": request.seed,
            "timeout_sec": request.timeout_sec or self._timeout,
        }
        payload = await self._post("/v1/speech", body)
        wav = self._decode_audio(payload.get("wav"))
        sample_rate = payload.get("sample_rate")
        if not isinstance(sample_rate, int) or sample_rate <= 0:
            raise VoiceUnavailable("runnerの応答にsample_rateがありません。")
        seed = payload.get("seed")
        return SpeechResult(
            wav=wav,
            sample_rate=sample_rate,
            audio_sec=_number(payload.get("audio_sec")) or 0.0,
            seed=seed if isinstance(seed, int) else request.seed,
            model=_text(payload.get("model")),
            revision=_text(payload.get("revision")),
            elapsed_sec=_number(payload.get("elapsed_sec")),
            vram_peak_mb=_number(payload.get("vram_peak_mb")),
        )

    async def transcribe(self, wav: bytes, language: str = "ja") -> TranscribeResult:
        self._guard_size(len(wav), "生成音声")
        body = {
            "wav": base64.b64encode(wav).decode("ascii"),
            "language": language,
        }
        payload = await self._post("/v1/transcribe", body)
        text = payload.get("text")
        if not isinstance(text, str):
            raise VoiceUnavailable("runnerの応答に書き起こしがありません。")
        return TranscribeResult(
            text=text,
            duration_sec=_number(payload.get("duration_sec")),
            model=_text(payload.get("model")),
        )

    def _guard_size(self, size: int, label: str) -> None:
        if size > self._max_bytes:
            raise VoicePayloadTooLarge(
                f"{label}が上限({self._max_bytes}バイト)を超えています: {size}バイト"
            )

    def _decode_audio(self, raw: Any) -> bytes:
        if not isinstance(raw, str):
            raise VoiceUnavailable("runnerの応答にwavがありません。")
        try:
            wav = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError) as error:
            raise VoiceUnavailable("runnerが返したwavを復号できません。") from error
        self._guard_size(len(wav), "生成音声")
        return wav

    async def _get(self, path: str, *, timeout: float | None = None) -> dict[str, Any]:
        try:
            response = await self._client.get(path, timeout=timeout)
        except httpx.TimeoutException as error:
            raise VoiceTimeout(f"voice-runnerが応答しません: {path}") from error
        except httpx.HTTPError as error:
            raise VoiceUnavailable(
                f"voice-runnerへ接続できません: {self._base_url}"
            ) from error
        return self._payload(response, path)

    async def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            response = await self._client.post(path, json=body)
        except httpx.TimeoutException as error:
            raise VoiceTimeout(
                f"voice-runnerが制限時間内に応答しませんでした: {path}"
            ) from error
        except httpx.HTTPError as error:
            raise VoiceUnavailable(
                f"voice-runnerへ接続できません: {self._base_url}"
            ) from error
        return self._payload(response, path)

    def _payload(self, response: httpx.Response, path: str) -> dict[str, Any]:
        """runnerの応答を共通の例外へ翻訳する。

        Backendの実行失敗(4xx/5xxのうちrunnerが理由を返したもの)と、runner自体へ
        届かない障害を混ぜない。別Backendへの自動fallbackはどちらの場合も行わない。
        """
        if response.status_code >= httpx.codes.BAD_REQUEST:
            detail = _detail(response)
            if response.status_code == httpx.codes.GATEWAY_TIMEOUT:
                raise VoiceTimeout(f"voice-runnerが実行を打ち切りました: {detail}")
            if response.status_code < httpx.codes.INTERNAL_SERVER_ERROR:
                raise VoiceExecutionFailed(
                    f"voice-runnerが要求を拒否しました(HTTP "
                    f"{response.status_code}): {detail}"
                )
            raise VoiceExecutionFailed(
                f"voice-runnerで実行が失敗しました(HTTP "
                f"{response.status_code}): {detail}"
            )
        try:
            payload = response.json()
        except ValueError as error:
            raise VoiceUnavailable(
                f"voice-runnerの応答を解釈できません: {path}"
            ) from error
        if not isinstance(payload, dict):
            raise VoiceUnavailable(f"voice-runnerの応答形式が想定外です: {path}")
        return payload


def _detail(response: httpx.Response) -> str:
    """runnerが返した理由を1行へまとめる。本文全体はログにも応答にも載せない。"""
    try:
        payload = response.json()
    except ValueError:
        return response.reason_phrase or "理由不明"
    if isinstance(payload, dict):
        for key in ("detail", "message", "error"):
            value = payload.get(key)
            if isinstance(value, str) and value:
                return value[:200]
    return response.reason_phrase or "理由不明"
