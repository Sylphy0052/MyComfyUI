"""voice-runnerクライアントの共通入出力。

HTTP実装とスタブ実装が同じProtocolを満たす。`ReferenceSource`と同じ流儀で、
接続先の知識を呼び出し側へ出さない。

wavと参照音声はHTTP bodyのJSONへbase64で載せる。リモート構成ではrunner側の
ファイルシステムに参照音声が存在せず、パスでは渡せないためである。
"""

import unicodedata
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

#: 音声Backendのengine識別子。Recipeの`engine`にそのまま入る。
ENGINE_IRODORI = "irodori"

VOICE_ENGINES: tuple[str, ...] = (ENGINE_IRODORI,)

#: `caption` (声質の文章指定) の最大文字数。声の特徴を1文で述べる欄で、数百字あれば
#: 足りる。Snapshot・`parameters.captions`・`resolved_inputs`の3か所へ複製されるため
#: 上限を置く。voice-runnerの`SpeechRequest.caption`の`max_length`と同じ値にする。
MAX_CAPTION_CHARS = 500


def caption_problem(caption: str) -> str | None:
    """captionが不正なら理由を、問題が無ければNoneを返す。

    Snapshotを作る`plan.py`と、実行時に読み直すexecutorが同じ判定を使う。voice-runnerは
    別パッケージで、同じ条件を自分のschemaに持つ。

    制御文字はUnicodeカテゴリ`Cc` (改行・タブを含む) を拒む。U+2028/U+2029
    (カテゴリ`Zl`/`Zp`) は通す。ここで拒む対象を変えるときは、runner側も揃える。
    """
    if not caption.strip():
        return "空白だけにはできません"
    if len(caption) > MAX_CAPTION_CHARS:
        return f"{MAX_CAPTION_CHARS}文字以内で指定します"
    if any(unicodedata.category(char) == "Cc" for char in caption):
        return "改行などの制御文字は使えません"
    return None

#: 参照音声の書き起こしを生成に使うengine。ここに含むengineでは、参照音声と書き起こしを
#: 組で必須にする。Irodoriは参照音声とcaptionだけで声質を決め、書き起こしを使わない。
#: engineを足すときは、voice-runnerの`engines.yaml`の`uses_reference_transcript`と
#: Webの`VoicePanel.tsx`の同名の集合も同時に更新する。
REFERENCE_TRANSCRIPT_ENGINES: frozenset[str] = frozenset()


def uses_reference_transcript(engine: str) -> bool:
    """engineが参照音声の書き起こしを生成に使うかを返す。"""
    return engine in REFERENCE_TRANSCRIPT_ENGINES


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
    """1台詞ぶんの生成要求。

    声質は参照音声か`caption`の少なくとも一方で決める。両方あれば両方を使う。
    `reference_transcript`は書き起こしを使うengineでだけ参照音声と組で必須になる。

    この型は値を検査しない。「参照は組で空でない」「参照もcaptionも無ければ不正」
    「captionが空白だけでなく、`MAX_CAPTION_CHARS`以内で、制御文字を含まない」の保証は、
    Snapshotを作る`plan.py`の`_binding`と、実行時に読み直すexecutorの`_load_binding`が
    持つ。captionの判定は`caption_problem`に集約している。runnerも同じ条件を自分の
    schemaで検査するため、ここで重ねて検査しない。
    """

    engine: str
    text: str
    seed: int
    reference_audio: bytes | None = None
    reference_transcript: str | None = None
    caption: str | None = None
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
