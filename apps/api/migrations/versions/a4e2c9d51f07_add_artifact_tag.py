"""add artifact tag

Revision ID: a4e2c9d51f07
Revises: 7d61b4e0a2c8
Create Date: 2026-09-20 06:10:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a4e2c9d51f07"
down_revision: str | Sequence[str] | None = "7d61b4e0a2c8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "artifact_tag",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("artifact_id", sa.String(length=36), nullable=False),
        sa.Column("tag", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["artifact_id"],
            ["artifact.id"],
            name="fk_artifact_tag_artifact_id",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_artifact_tag"),
        sa.UniqueConstraint(
            "artifact_id", "tag", name="uq_artifact_tag_artifact_id_tag"
        ),
    )
    op.create_index("ix_artifact_tag_artifact_id", "artifact_tag", ["artifact_id"])
    op.create_index("ix_artifact_tag_tag", "artifact_tag", ["tag"])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_artifact_tag_tag", table_name="artifact_tag")
    op.drop_index("ix_artifact_tag_artifact_id", table_name="artifact_tag")
    op.drop_table("artifact_tag")
