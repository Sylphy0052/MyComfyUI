"""add story costume image memo

Revision ID: 634c0a5e7b19
Revises: c4e8a1b6d273
Create Date: 2026-10-09 12:00:00.000000

アップロードした衣装の参照画像 (`input:<path>`) にメモを付けられるようにする。
生成物の参照 (`artifact:<id>`) は生成物のメモを使うため、この列は使わない。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "634c0a5e7b19"
down_revision: str | Sequence[str] | None = "c4e8a1b6d273"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """衣装の参照画像へメモ列を追加する。"""
    op.add_column(
        "story_costume_image", sa.Column("memo", sa.Text(), nullable=True)
    )


def downgrade() -> None:
    """衣装の参照画像のメモ列を削除する。"""
    with op.batch_alter_table("story_costume_image") as batch_op:
        batch_op.drop_column("memo")
