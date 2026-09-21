"""add local scene and shot

Revision ID: a71ce48d925f
Revises: f6b8d32a7e51
Create Date: 2026-09-22 12:00:00.000000

ローカルProject内のSceneとShotを、外部参照データとは分離して永続化する。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a71ce48d925f"
down_revision: str | Sequence[str] | None = "f6b8d32a7e51"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

PRODUCTION_STATUS_CHECK = (
    "production_status in "
    "('not_started','in_progress','has_candidates','accepted','completed')"
)


def upgrade() -> None:
    op.create_table(
        "project_scene",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=128), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("production_status", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.Column("deleted_at", sa.Text(), nullable=True),
        sa.CheckConstraint(
            PRODUCTION_STATUS_CHECK, name="ck_project_scene_production_status"
        ),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_project_scene_project",
        "project_scene",
        ["project_id", "deleted_at", "sequence"],
        unique=False,
    )
    op.create_table(
        "project_shot",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=128), nullable=False),
        sa.Column("scene_id", sa.String(length=36), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("duration_sec", sa.Float(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("production_status", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.Column("deleted_at", sa.Text(), nullable=True),
        sa.CheckConstraint(
            PRODUCTION_STATUS_CHECK, name="ck_project_shot_production_status"
        ),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.ForeignKeyConstraint(["scene_id"], ["project_scene.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_project_shot_scene",
        "project_shot",
        ["scene_id", "deleted_at", "sequence"],
        unique=False,
    )
    op.create_index(
        "ix_project_shot_project",
        "project_shot",
        ["project_id", "deleted_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_project_shot_project", table_name="project_shot")
    op.drop_index("ix_project_shot_scene", table_name="project_shot")
    op.drop_table("project_shot")
    op.drop_index("ix_project_scene_project", table_name="project_scene")
    op.drop_table("project_scene")
