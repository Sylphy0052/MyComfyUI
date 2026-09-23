"""add look profile production choices

Revision ID: c3e8a1f5d207
Revises: 9b1f2d6c4a71
Create Date: 2026-09-23 12:00:00.000000

Presetに「モードBで使用者に選ばせる入力」を定義できるようにする (#161)。
batch modeはSQLiteでテーブルを作り直し、`trg_look_profile_limit`トリガーを
消してしまうため使わない。SQLiteのALTER TABLEで列を直接足し引きする。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3e8a1f5d207"
down_revision: str | Sequence[str] | None = "9b1f2d6c4a71"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """LookProfileへモードBで選ばせる入力名の配列を追加する。"""
    op.add_column(
        "look_profile",
        sa.Column(
            "production_choice_inputs",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'"),
        ),
    )


def downgrade() -> None:
    """LookProfileからモードBで選ばせる入力名の配列を削除する。"""
    op.drop_column("look_profile", "production_choice_inputs")
