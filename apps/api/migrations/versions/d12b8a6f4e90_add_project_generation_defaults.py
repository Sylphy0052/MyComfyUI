"""add project generation defaults

Revision ID: d12b8a6f4e90
Revises: c84e9a1d2f30
Create Date: 2026-09-22 15:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d12b8a6f4e90"
down_revision: str | Sequence[str] | None = "c84e9a1d2f30"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("project") as batch_op:
        batch_op.add_column(
            sa.Column(
                "generation_defaults",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'{}'"),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("project") as batch_op:
        batch_op.drop_column("generation_defaults")
