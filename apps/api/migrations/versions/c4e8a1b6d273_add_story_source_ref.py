"""add story source_ref

Revision ID: c4e8a1b6d273
Revises: a9d3c7f1b852
Create Date: 2026-10-09 10:00:00.000000

novel-writerのsnapshotや旧キャラ設定から取り込んだキャラとシーンの元idを持つ列を足す (#630)。
列とindexの追加だけで、既存の行は変えない。NULLは一意制約の対象外。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c4e8a1b6d273"
down_revision: str | Sequence[str] | None = "a9d3c7f1b852"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """story_characterとstory_sceneへsource_refと、Project内で一意のindexを追加する。"""
    op.add_column("story_character", sa.Column("source_ref", sa.Text(), nullable=True))
    op.create_index(
        "uq_story_character_source_ref",
        "story_character",
        ["project_id", "source_ref"],
        unique=True,
    )
    op.add_column("story_scene", sa.Column("source_ref", sa.Text(), nullable=True))
    op.create_index(
        "uq_story_scene_source_ref",
        "story_scene",
        ["project_id", "source_ref"],
        unique=True,
    )


def downgrade() -> None:
    """source_refとindexを削除する。"""
    op.drop_index("uq_story_scene_source_ref", table_name="story_scene")
    op.drop_column("story_scene", "source_ref")
    op.drop_index("uq_story_character_source_ref", table_name="story_character")
    op.drop_column("story_character", "source_ref")
