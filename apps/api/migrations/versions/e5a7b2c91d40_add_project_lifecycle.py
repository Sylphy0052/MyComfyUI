"""add project lifecycle

Revision ID: e5a7b2c91d40
Revises: d4c92e1b7f30
Create Date: 2026-09-22 10:30:00.000000

Projectを外部fixtureの一覧から独立した永続データにする。既存の`hirohito`は同じIDと
外部参照情報で登録し、SceneとShotが引き続き既存参照APIを利用できるようにする。

downgradeではProjectのメタデータとライフサイクル履歴が失われる。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e5a7b2c91d40"
down_revision: str | Sequence[str] | None = "d4c92e1b7f30"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Project表を追加し、既存Projectを移行する。"""
    op.create_table(
        "project",
        sa.Column("id", sa.String(length=128), nullable=False),
        sa.Column("name", sa.Text(collation="NOCASE"), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("lifecycle", sa.Text(), nullable=False),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("thumbnail_artifact_id", sa.String(length=36), nullable=True),
        sa.Column("source_type", sa.Text(), nullable=False),
        sa.Column("source_locator", sa.Text(), nullable=True),
        sa.Column("source_revision", sa.Text(), nullable=True),
        sa.Column("external_id", sa.String(length=128), nullable=True),
        sa.Column("scene_count", sa.Integer(), nullable=False),
        sa.Column("shot_count", sa.Integer(), nullable=False),
        sa.Column("canon_count", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.Column("last_used_at", sa.Text(), nullable=True),
        sa.Column("archived_at", sa.Text(), nullable=True),
        sa.Column("deleted_at", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "status in ('planning','active','on_hold','completed')",
            name="ck_project_status",
        ),
        sa.CheckConstraint(
            "lifecycle in ('active','archived','trashed')",
            name="ck_project_lifecycle",
        ),
        sa.CheckConstraint(
            "source_type in ('local','external')", name="ck_project_source_type"
        ),
        sa.ForeignKeyConstraint(
            ["thumbnail_artifact_id"], ["artifact.id"], name="fk_project_thumbnail"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", name="uq_project_name"),
    )
    op.create_index(
        "ix_project_lifecycle_last_used",
        "project",
        ["lifecycle", "last_used_at"],
        unique=False,
    )

    timestamp = "2026-09-22T10:30:00+09:00"
    project = sa.table(
        "project",
        sa.column("id", sa.String()),
        sa.column("name", sa.Text()),
        sa.column("description", sa.Text()),
        sa.column("status", sa.Text()),
        sa.column("lifecycle", sa.Text()),
        sa.column("tags", sa.JSON()),
        sa.column("thumbnail_artifact_id", sa.String()),
        sa.column("source_type", sa.Text()),
        sa.column("source_locator", sa.Text()),
        sa.column("source_revision", sa.Text()),
        sa.column("external_id", sa.String()),
        sa.column("scene_count", sa.Integer()),
        sa.column("shot_count", sa.Integer()),
        sa.column("canon_count", sa.Integer()),
        sa.column("created_at", sa.Text()),
        sa.column("updated_at", sa.Text()),
        sa.column("last_used_at", sa.Text()),
        sa.column("archived_at", sa.Text()),
        sa.column("deleted_at", sa.Text()),
    )
    op.bulk_insert(
        project,
        [
            {
                "id": "hirohito",
                "name": "hirohito",
                "description": None,
                "status": "active",
                "lifecycle": "active",
                "tags": [],
                "thumbnail_artifact_id": None,
                "source_type": "external",
                "source_locator": "https://github.com/Sylphy0052/novel-writer",
                "source_revision": "6a3d861b6119d17050f4b4ebeefce77314b9d970",
                "external_id": "hirohito",
                "scene_count": 1,
                "shot_count": 1,
                "canon_count": 5,
                "created_at": timestamp,
                "updated_at": timestamp,
                "last_used_at": None,
                "archived_at": None,
                "deleted_at": None,
            }
        ],
    )


def downgrade() -> None:
    """Project表を削除する。"""
    op.drop_index("ix_project_lifecycle_last_used", table_name="project")
    op.drop_table("project")
