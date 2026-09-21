"""add project local overrides

Revision ID: 4a23c7f019d8
Revises: f17a2c8e90b4
Create Date: 2026-09-22 22:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4a23c7f019d8"
down_revision: str | Sequence[str] | None = "f17a2c8e90b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("project") as batch_op:
        batch_op.add_column(
            sa.Column(
                "local_overrides",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'{}'"),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("project") as batch_op:
        batch_op.drop_column("local_overrides")
