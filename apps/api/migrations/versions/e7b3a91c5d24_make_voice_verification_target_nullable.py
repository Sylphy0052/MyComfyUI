"""make voice_verification target_duration_sec nullable

Revision ID: e7b3a91c5d24
Revises: c5e92a4d71b8
Create Date: 2026-10-08 20:00:00.000000

Shot無しの音声Jobは目標尺を持たない。0.0を入れると「尺超過」の判定が常に真になるため、
目標尺が無いことをNULLで表す (#573)。既存の行は変えない。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e7b3a91c5d24"
down_revision: str | Sequence[str] | None = "c5e92a4d71b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("voice_verification") as batch_op:
        batch_op.alter_column(
            "target_duration_sec", existing_type=sa.Float(), nullable=True
        )


def downgrade() -> None:
    """NOT NULLへ戻す。目標尺が無かった行は0.0にする。"""
    op.execute(
        "update voice_verification set target_duration_sec = 0.0 "
        "where target_duration_sec is null"
    )
    with op.batch_alter_table("voice_verification") as batch_op:
        batch_op.alter_column(
            "target_duration_sec", existing_type=sa.Float(), nullable=False
        )
