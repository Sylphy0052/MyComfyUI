from functools import lru_cache
from pathlib import Path
from typing import Literal

from platformdirs import user_data_path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

#: 提案Providerの識別子。`claude_code`はCLIをsubprocessで呼び、`stub`は同梱fixtureを返す。
AgentProviderId = Literal["claude_code", "stub"]


class Settings(BaseSettings):
    """Runtime settings that never include Backend credentials."""

    model_config = SettingsConfigDict(
        env_prefix="MYCOMFYUI_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    data_root: Path = user_data_path("MyComfyUI", appauthor=False)
    comfyui_base_url: str = "http://127.0.0.1:8188"
    comfyui_timeout_seconds: float = Field(default=600.0, gt=0)
    #: ai-media参照APIの接続先。未設定の間は同梱fixtureを参照する。
    aimedia_base_url: str | None = None
    #: 参照fixtureの差し替え先。上流が未実装の間、Canonが更新された状態を再現して
    #: 更新警告と再実行の判定を確かめるために使う。未設定なら同梱fixtureを読む。
    aimedia_fixture_path: Path | None = None
    #: 提案取得に使うProvider。APIキーを設定へ持たず、CLIの既存認証を使う。
    agent_provider: AgentProviderId = "claude_code"
    #: Claude Code CLIの実行ファイル。PATH上の名前でも絶対パスでもよい。
    agent_cli_path: str = "claude"
    agent_model: str = "sonnet"
    agent_timeout_seconds: float = Field(default=120.0, gt=0)
    #: 1回の提案取得で許す上限額。CLIへ渡し、超過はCLI側で打ち切らせる。
    agent_max_budget_usd: float = Field(default=0.5, gt=0)
    #: 承認の有効期限。超過した承認では副作用のある操作を実行しない。
    agent_approval_ttl_seconds: int = Field(default=1800, gt=0)
    #: stub Providerを常に失敗させる。Provider障害が他機能を止めないことの確認に使う。
    agent_stub_failure: bool = False
    #: 音声とASRのBackendを束ねるvoice-runnerの接続先。ローカル構成でもリモート構成でも
    #: この値だけが変わり、実行経路は分岐しない。
    voice_runner_base_url: str = "http://127.0.0.1:8770"
    #: voice-runnerへの1リクエストの上限。`ai-media/docs/tts-backends.md`の既定に合わせる。
    voice_runner_timeout_seconds: float = Field(default=300.0, gt=0)
    #: base64で受け渡すwavのサイズ上限。参照音声と生成音声の両方に適用する。
    voice_max_audio_bytes: int = Field(default=32 * 1024 * 1024, gt=0)
    #: 実GPU Backendの代わりにスタブを使う。UIと履歴の経路を手元で確かめるために使う。
    voice_stub: bool = False
    #: スタブBackendを常に失敗させる。Backend障害時にJobがfailedへ落ちることの確認に使う。
    voice_stub_failure: bool = False
    #: 実ComfyUIの代わりに内蔵stubで実行する。到達できる実機が無い間、画像・動画・音楽の
    #: 投入から保存までの経路を手元で確かめるために使う。
    comfyui_stub: bool = False
    #: ComfyUI stubの生成を常に失敗させる。疎通(`/system_stats`相当)には効かせない。
    comfyui_stub_failure: bool = False
    #: 合成に使うffmpegの実行ファイル。PATH上の名前でも絶対パスでもよい。
    ffmpeg_path: str = "ffmpeg"
    #: 尺の確認に使うffprobeの実行ファイル。
    ffprobe_path: str = "ffprobe"
    #: 合成1件の実行上限。
    compose_timeout_seconds: float = Field(default=600.0, gt=0)
    #: 取り込む参照画像とガイド音声の上限バイト数。
    max_image_bytes: int = Field(default=32 * 1024 * 1024, gt=0)

    @property
    def database_path(self) -> Path:
        return self.data_root / "db" / "mycomfyui.sqlite3"

    @property
    def database_url(self) -> str:
        return f"sqlite+aiosqlite:///{self.database_path}"

    @property
    def artifacts_root(self) -> Path:
        return self.data_root / "artifacts"

    @property
    def agent_workspace_root(self) -> Path:
        """提案Providerを起動する作業ディレクトリの親。

        リポジトリを読ませないため、提案ごとに空のディレクトリを作ってcwdにする。
        `tmp/`配下のため、終端後に消しても他の記録へ影響しない。
        """
        return self.data_root / "tmp" / "agent"


@lru_cache
def get_settings() -> Settings:
    return Settings()
