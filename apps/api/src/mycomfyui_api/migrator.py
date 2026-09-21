"""起動時にAlembicのmigrationを適用する。

`alembic upgrade head`をCLIから打つ運用はリポジトリの`alembic.ini`に依存する。
配布用の実行ファイルには`alembic.ini`もリポジトリも無いため、
Configをコード側で組んでmigrationの置き場だけを渡す。接続先は`migrations/env.py`
が`Settings`から解決するため、ここでは指定しない。
"""

import sys
from pathlib import Path

from alembic import command
from alembic.config import Config


def _script_location() -> Path:
    """migrationの置き場を返す。

    PyInstallerで固めた実行ファイルでは、同梱した`migrations`が展開先へ置かれる。
    ソースから動かすときは`apps/api/migrations`を指す。
    """
    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root is not None:
        return Path(bundle_root) / "migrations"
    return Path(__file__).resolve().parents[2] / "migrations"


def build_alembic_config() -> Config:
    config = Config()
    config.set_main_option("script_location", str(_script_location()))
    return config


def upgrade_to_head() -> None:
    """schemaを最新まで進める。適用済みなら何もしない。"""
    command.upgrade(build_alembic_config(), "head")
