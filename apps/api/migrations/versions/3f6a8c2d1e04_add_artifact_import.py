"""add artifact import provenance

Revision ID: 3f6a8c2d1e04
Revises: f17a2c8e90b4
Create Date: 2026-09-22 22:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3f6a8c2d1e04"
down_revision: str | Sequence[str] | None = "f17a2c8e90b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "artifact_import",
        sa.Column("artifact_id", sa.String(length=36), nullable=False),
        sa.Column("original_file_name", sa.Text(), nullable=False),
        sa.Column("source_format", sa.Text(), nullable=False),
        sa.Column("raw_metadata", sa.JSON(), nullable=False),
        sa.Column("recipe_draft", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["artifact_id"], ["artifact.id"]),
        sa.PrimaryKeyConstraint("artifact_id"),
    )
    op.create_table(
        "image_import_preview",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("file_name", sa.Text(), nullable=False),
        sa.Column("media_type", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.Text(), nullable=False),
        sa.Column("consumed_at", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("image_import_preview")
    op.drop_table("artifact_import")
