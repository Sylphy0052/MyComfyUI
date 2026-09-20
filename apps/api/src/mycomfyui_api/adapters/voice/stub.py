"""実GPU Backendを持たない環境で使うスタブ。

音声Backendは現PCのVRAMに載らないため、実機を用意するまでの間、Job投入から履歴と
ASR検証までの経路をこのスタブで確かめる。外部へは一切送信しない。

書き起こしは、生成時に受け取った台詞を覚えておいて返す。`MISHEARD`に載せた語だけは
別語へ置き換えて返し、正規化後も一致しない場合を再現できるようにする。値は
`ai-media/docs/tts-backends.md`が実測として挙げている誤読例に合わせた。
"""

import hashlib
import io
import logging
import math
import struct
import wave

from mycomfyui_api.adapters.voice.base import (
    VOICE_ENGINES,
    EngineInfo,
    RunnerHealth,
    SpeechRequest,
    SpeechResult,
    TranscribeResult,
    VoiceExecutionFailed,
    VoiceUnavailable,
)
from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

STUB_BASE_URL = "stub://voice-runner"

#: engineごとの出力sample rate。`ai-media/config/local-tools.yaml`の実測に合わせる。
SAMPLE_RATES = {
    "qwen3-tts-clone": 24000,
    "voxcpm2-prompt": 48000,
    "cosyvoice3": 24000,
}

#: 1文字あたりの発話時間。日本語の朗読の実測(おおよそ4文字/秒)に寄せた概算値。
SECONDS_PER_CHARACTER = 0.25

#: Whisperが別語へ化けた既知の例。スタブではこの置換だけを再現する。
MISHEARD = {"女子": "温座子", "放課後": "降下後"}

STUB_MODEL = "stub-voice"
STUB_REVISION = "stub"
STUB_ASR_MODEL = "stub-asr"


def _misheard(text: str) -> str:
    for source, replacement in MISHEARD.items():
        text = text.replace(source, replacement)
    return text


def _tone(sample_rate: int, seconds: float, seed: int, text: str) -> bytes:
    """seedと台詞から決まる16bit PCM wavを作る。

    同じseedと同じ台詞なら同じ波形になる。実Backendでの「seedを固定すれば波形が
    再現する」性質をスタブでも保ち、再実行の確認に使えるようにする。
    """
    frames = max(round(sample_rate * seconds), 1)
    digest = int.from_bytes(hashlib.sha256(text.encode("utf-8")).digest()[:4], "big")
    frequency = 110.0 + float((digest ^ (seed & 0xFFFFFFFF)) % 330)
    step = 2.0 * math.pi * frequency / sample_rate
    samples = bytearray()
    for index in range(frames):
        value = int(12000 * math.sin(step * index))
        samples += struct.pack("<h", value)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as sink:
        sink.setnchannels(1)
        sink.setsampwidth(2)
        sink.setframerate(sample_rate)
        sink.writeframes(bytes(samples))
    return buffer.getvalue()


class StubVoiceBackend:
    """固定の合成音声と、生成時の台詞を返すASRを提供する。"""

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()
        # 生成したwavと、その台詞の対応。ASRはここから引く。
        self._spoken: dict[str, str] = {}

    @property
    def base_url(self) -> str:
        return STUB_BASE_URL

    async def aclose(self) -> None:
        """保持する接続は無い。Protocolを満たすために用意する。"""

    async def health(self) -> RunnerHealth:
        """疎通は`voice_stub_failure`の影響を受けない。

        障害注入を疎通にも効かせると、Jobが投入前の確認で止まり、生成の失敗を
        扱う経路まで届かない。runnerへ接続できない場合は接続先を実在しないURLへ
        向ければ再現できるため、この切り替えは生成の失敗だけに当てる。
        """
        detail = (
            "生成は失敗するよう設定されています。"
            if self._settings.voice_stub_failure
            else None
        )
        return RunnerHealth(
            base_url=STUB_BASE_URL,
            engines=tuple(
                EngineInfo(
                    id=engine,
                    available=True,
                    model=STUB_MODEL,
                    revision=STUB_REVISION,
                    sample_rate=SAMPLE_RATES.get(engine),
                    needs_katakana=False,
                    detail=detail,
                )
                for engine in VOICE_ENGINES
            ),
        )

    async def speech(self, request: SpeechRequest) -> SpeechResult:
        if self._settings.voice_stub_failure:
            # 障害試験用。Jobはfailedになり、別engineへ自動fallbackしない。
            raise VoiceExecutionFailed("スタブBackendは失敗するよう設定されています。")
        sample_rate = SAMPLE_RATES.get(request.engine)
        if sample_rate is None:
            raise VoiceUnavailable(f"スタブが知らないengineです: {request.engine}")
        spoken = request.reading or request.text
        seconds = max(len(request.text) * SECONDS_PER_CHARACTER, 0.25)
        wav = _tone(sample_rate, seconds, request.seed, spoken)
        self._spoken[hashlib.sha256(wav).hexdigest()] = request.text
        return SpeechResult(
            wav=wav,
            sample_rate=sample_rate,
            audio_sec=round(seconds, 4),
            seed=request.seed,
            model=STUB_MODEL,
            revision=STUB_REVISION,
            elapsed_sec=0.0,
            vram_peak_mb=0.0,
        )

    async def transcribe(self, wav: bytes, language: str = "ja") -> TranscribeResult:
        if self._settings.voice_stub_failure:
            raise VoiceExecutionFailed("スタブBackendは失敗するよう設定されています。")
        spoken = self._spoken.get(hashlib.sha256(wav).hexdigest())
        if spoken is None:
            # スタブが生成していないwavは書き起こせない。生成と検証の対応が崩れた
            # ことを一致判定へ持ち込まず、取得できなかったこととして扱う。
            raise VoiceUnavailable("スタブが生成していない音声は書き起こせません。")
        return TranscribeResult(
            text=_misheard(spoken),
            duration_sec=None,
            model=STUB_ASR_MODEL,
        )
