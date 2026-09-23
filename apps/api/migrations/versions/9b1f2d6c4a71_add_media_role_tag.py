"""add media role tag

Revision ID: 9b1f2d6c4a71
Revises: 5e9d1c7a3b20
Create Date: 2026-09-23 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "9b1f2d6c4a71"
down_revision: str | Sequence[str] | None = "5e9d1c7a3b20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "media_role_tag",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("artifact_id", sa.String(length=36), nullable=True),
        sa.Column("relative_path", sa.Text(), nullable=True),
        sa.Column("sha256", sa.String(length=64), nullable=True),
        sa.Column("file_name", sa.Text(), nullable=True),
        sa.Column("byte_size", sa.Integer(), nullable=True),
        sa.Column("media_type", sa.Text(), nullable=True),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("character_ids", sa.JSON(), nullable=False),
        sa.Column("assigned_project_id", sa.String(length=128), nullable=True),
        sa.Column("assigned_scene_id", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["artifact_id"], ["artifact.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "role in ('appearance_reference','pose','background','costume','other')",
            name="ck_media_role_tag_role",
        ),
        sa.CheckConstraint(
            "(artifact_id IS NOT NULL) != (relative_path IS NOT NULL)",
            name="ck_media_role_tag_target_xor",
        ),
        sa.UniqueConstraint("artifact_id", name="uq_media_role_tag_artifact_id"),
        sa.UniqueConstraint("relative_path", name="uq_media_role_tag_relative_path"),
    )
    op.create_index(
        "ix_media_role_tag_assignment",
        "media_role_tag",
        ["assigned_project_id", "assigned_scene_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_media_role_tag_assignment", table_name="media_role_tag")
    op.drop_table("media_role_tag")
