"""voice-runnerクライアントの共通入出力。

HTTP実装とスタブ実装が同じProtocolを満たす。`ReferenceSource`と同じ流儀で、
接続先の知識を呼び出し側へ出さない。

wavと参照音声はHTTP bodyのJSONへbase64で載せる。リモート構成ではrunner側の
ファイルシステムに参照音声が存在せず、パスでは渡せないためである。
"""

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

#: 音声Backendのengine識別子。Recipeの`engine`にそのまま入る。
ENGINE_QWEN3_TTS = "qwen3-tts-clone"
ENGINE_VOXCPM2 = "voxcpm2-prompt"
ENGINE_COSYVOICE3 = "cosyvoice3"

VOICE_ENGINES: tuple[str, ...] = (
    ENGINE_QWEN3_TTS,
    ENGINE_VOXCPM2,
    ENGINE_COSYVOICE3,
)


class VoiceError(Exception):
    """voice-runner Adapterが返す例外の基底。"""


class VoiceUnavailable(VoiceError):
    """runnerへ接続できない、または応答を解釈できない。"""


class VoiceExecutionFailed(VoiceError):
    """runner上でのBackend実行が失敗した。"""


class VoiceTimeout(VoiceError):
    """制限時間内に応答が返らなかった。"""


class VoicePayloadTooLarge(VoiceError):
    """受け渡すwavが設定した上限を超えた。"""


@dataclass(frozen=True)
class EngineInfo:
    """runnerが公開する1engineの状態。"""

    id: str
    available: bool
    model: str | None = None
    revision: str | None = None
    sample_rate: int | None = None
    needs_katakana: bool = False
    detail: str | None = None


@dataclass(frozen=True)
class RunnerHealth:
    """runnerの疎通確認の結果。接続先URLは含めるが認証情報は扱わない。"""

    base_url: str
    engines: tuple[EngineInfo, ...] = ()

    def engine(self, engine_id: str) -> EngineInfo | None:
        for item in self.engines:
            if item.id == engine_id:
                return item
        return None


@dataclass(frozen=True)
class SpeechRequest:
    """1台詞ぶんの生成要求。"""

    engine: str
    text: str
    reference_audio: bytes
    reference_transcript: str
    seed: int
    reading: str | None = None
    language: str = "ja"
    timeout_sec: float | None = None


@dataclass(frozen=True)
class SpeechResult:
    """生成結果。wavは実体を、それ以外は実測値だけを持つ。"""

    wav: bytes
    sample_rate: int
    audio_sec: float
    seed: int
    model: str | None = None
    revision: str | None = None
    elapsed_sec: float | None = None
    vram_peak_mb: float | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TranscribeResult:
    """ASRの書き起こし結果。"""

    text: str
    duration_sec: float | None = None
    model: str | None = None


@runtime_checkable
class VoiceBackend(Protocol):
    """音声生成とASRだけを提供する。更新系のメソッドは持たない。"""

    @property
    def base_url(self) -> str: ...

    async def health(self) -> RunnerHealth: ...

    async def speech(self, request: SpeechRequest) -> SpeechResult: ...

    async def transcribe(
        self, wav: bytes, language: str = "ja"
    ) -> TranscribeResult: ...

    async def aclose(self) -> None: ...
