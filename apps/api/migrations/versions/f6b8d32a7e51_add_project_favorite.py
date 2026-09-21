"""add project favorite

Revision ID: f6b8d32a7e51
Revises: e5a7b2c91d40
Create Date: 2026-09-22 11:15:00.000000

Project一覧で繰り返し使うProjectを優先表示するため、お気に入り状態を永続化する。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f6b8d32a7e51"
down_revision: str | Sequence[str] | None = "e5a7b2c91d40"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Projectへお気に入り状態を追加する。"""
    op.add_column(
        "project",
        sa.Column(
            "favorite", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )


def downgrade() -> None:
    """Projectのお気に入り状態を削除する。"""
    op.drop_column("project", "favorite")
