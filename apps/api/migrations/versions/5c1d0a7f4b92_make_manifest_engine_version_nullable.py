"""make manifest engine_version nullable

Revision ID: 5c1d0a7f4b92
Revises: 00820f6b1610
Create Date: 2026-09-20 00:41:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "5c1d0a7f4b92"
down_revision: str | Sequence[str] | None = "00820f6b1610"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    # 実行基盤の版はJob作成時点では確定できず、Executorが実行開始直後に設定する。
    with op.batch_alter_table("generation_manifest") as batch_op:
        batch_op.alter_column("engine_version", existing_type=sa.Text(), nullable=True)


def downgrade() -> None:
    """Downgrade schema."""
    op.execute(
        "update generation_manifest set engine_version = 'unknown' "
        "where engine_version is null"
    )
    with op.batch_alter_table("generation_manifest") as batch_op:
        batch_op.alter_column("engine_version", existing_type=sa.Text(), nullable=False)
