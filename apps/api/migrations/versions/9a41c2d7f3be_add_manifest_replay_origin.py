"""add manifest replay origin

Revision ID: 9a41c2d7f3be
Revises: 5c1d0a7f4b92
Create Date: 2026-09-20 02:20:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9a41c2d7f3be"
down_revision: str | Sequence[str] | None = "5c1d0a7f4b92"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("generation_manifest") as batch_op:
        batch_op.add_column(
            sa.Column("replay_of_manifest_id", sa.String(length=36), nullable=True)
        )
        batch_op.create_foreign_key(
            "fk_generation_manifest_replay_of_manifest_id",
            "generation_manifest",
            ["replay_of_manifest_id"],
            ["id"],
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("generation_manifest") as batch_op:
        batch_op.drop_constraint(
            "fk_generation_manifest_replay_of_manifest_id", type_="foreignkey"
        )
        batch_op.drop_column("replay_of_manifest_id")
