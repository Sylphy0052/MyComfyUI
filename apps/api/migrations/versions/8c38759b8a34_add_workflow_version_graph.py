"""add workflow version graph

Revision ID: 8c38759b8a34
Revises: 71e4b8c20f65
Create Date: 2026-09-23 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "8c38759b8a34"
down_revision: str | Sequence[str] | None = "71e4b8c20f65"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("workflow_version") as batch_op:
        batch_op.add_column(sa.Column("graph", sa.JSON(), nullable=True))
        batch_op.add_column(
            sa.Column("graph_sha256", sa.String(length=64), nullable=True)
        )
        batch_op.add_column(
            sa.Column("based_on_version_id", sa.String(length=36), nullable=True)
        )
        batch_op.create_foreign_key(
            "fk_workflow_version_based_on_version_id",
            "workflow_version",
            ["based_on_version_id"],
            ["id"],
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("workflow_version") as batch_op:
        batch_op.drop_constraint(
            "fk_workflow_version_based_on_version_id", type_="foreignkey"
        )
        batch_op.drop_column("based_on_version_id")
        batch_op.drop_column("graph_sha256")
        batch_op.drop_column("graph")
