from functools import lru_cache
from pathlib import Path

from platformdirs import user_data_path
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

    @property
    def database_path(self) -> Path:
        return self.data_root / "db" / "mycomfyui.sqlite3"

    @property
    def database_url(self) -> str:
        return f"sqlite+aiosqlite:///{self.database_path}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
