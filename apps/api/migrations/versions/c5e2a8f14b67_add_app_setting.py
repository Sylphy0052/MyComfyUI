"""add app_setting

Revision ID: c5e2a8f14b67
Revises: a3c7e9d2f418
Create Date: 2026-09-25 10:00:00.000000

Web UIから変更した設定を保存する`app_setting`を追加する (#337)。keyは`Settings`の
属性名で、行が無い項目は環境変数の値を使う。

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c5e2a8f14b67"
down_revision: str | Sequence[str] | None = "a3c7e9d2f418"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "app_setting",
        sa.Column("key", sa.String(length=128), nullable=False),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )


def downgrade() -> None:
    op.drop_table("app_setting")
