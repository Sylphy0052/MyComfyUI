"""drop scene due_date priority

Revision ID: a4c7e2d95b18
Revises: e6b1d4a79c25
Create Date: 2026-10-08 12:00:00.000000

Sceneの期限(`due_date`)と優先度(`priority`)を使わなくなったため列を削除する (#478)。
Shotの期限と優先度は残す。

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a4c7e2d95b18"
down_revision: str | Sequence[str] | None = "e6b1d4a79c25"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("project_scene") as batch_op:
        batch_op.drop_column("priority")
        batch_op.drop_column("due_date")


def downgrade() -> None:
    with op.batch_alter_table("project_scene") as batch_op:
        batch_op.add_column(sa.Column("due_date", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("priority", sa.Text(), nullable=True))
