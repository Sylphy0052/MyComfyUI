from functools import lru_cache
from pathlib import Path

from platformdirs import user_data_path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


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

    @property
    def database_path(self) -> Path:
        return self.data_root / "db" / "mycomfyui.sqlite3"

    @property
    def database_url(self) -> str:
        return f"sqlite+aiosqlite:///{self.database_path}"

    @property
    def artifacts_root(self) -> Path:
        return self.data_root / "artifacts"


@lru_cache
def get_settings() -> Settings:
    return Settings()
