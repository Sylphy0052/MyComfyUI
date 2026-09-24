"""add artifact deleted_at

Revision ID: a3c7e9d2f418
Revises: e8b3f6a1c952
Create Date: 2026-09-24 15:00:00.000000

Artifactをゴミ箱へ移す論理削除のため、`artifact.deleted_at`を追加する (#288)。

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a3c7e9d2f418"
down_revision: str | Sequence[str] | None = "e8b3f6a1c952"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("artifact") as batch_op:
        batch_op.add_column(sa.Column("deleted_at", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("artifact") as batch_op:
        batch_op.drop_column("deleted_at")
