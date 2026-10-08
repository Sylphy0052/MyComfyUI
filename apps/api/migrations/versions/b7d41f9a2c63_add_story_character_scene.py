"""add story character scene

Revision ID: b7d41f9a2c63
Revises: a4c7e2d95b18
Create Date: 2026-10-08 10:00:00.000000

WebUI v2のキャラクター・衣装・シーンを持つ表を足す (#529)。旧UIが使う既存の表と
Project設定は変えず、表の追加だけを行う。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7d41f9a2c63"
down_revision: str | Sequence[str] | None = "a4c7e2d95b18"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """キャラクター・衣装・シーンと、その従属表を作る。"""
    op.create_table(
        "story_character",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=128), nullable=False),
        sa.Column("name", sa.Text(collation="NOCASE"), nullable=False),
        sa.Column("fixed_tags", sa.JSON(), nullable=False),
        sa.Column("negative_tags", sa.JSON(), nullable=False),
        sa.Column("profile", sa.Text(), nullable=False),
        sa.Column("portrait_media_key", sa.Text(), nullable=True),
        sa.Column("voice_media_key", sa.Text(), nullable=True),
        sa.Column("voice_transcript", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "name", name="uq_story_character_name"),
    )
    op.create_index(
        "ix_story_character_project", "story_character", ["project_id", "created_at"]
    )
    op.create_table(
        "story_costume",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("character_id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.Text(collation="NOCASE"), nullable=False),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("negative_tags", sa.JSON(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["character_id"], ["story_character.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("character_id", "name", name="uq_story_costume_name"),
    )
    op.create_index(
        "ix_story_costume_character", "story_costume", ["character_id", "created_at"]
    )
    op.create_table(
        "story_costume_image",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("costume_id", sa.String(length=36), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("media_key", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["costume_id"], ["story_costume.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "costume_id", "position", name="uq_story_costume_image_position"
        ),
    )
    op.create_table(
        "story_scene",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=128), nullable=False),
        sa.Column("parent_scene_id", sa.String(length=36), nullable=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("background_text", sa.Text(), nullable=False),
        sa.Column("background_tags", sa.JSON(), nullable=False),
        sa.Column("time_of_day", sa.Text(), nullable=True),
        sa.Column("bgm_mood", sa.Text(), nullable=False),
        sa.Column("video_motion", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "time_of_day IS NULL OR time_of_day in ('morning','day','sunset','night')",
            name="ck_story_scene_time_of_day",
        ),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.ForeignKeyConstraint(["parent_scene_id"], ["story_scene.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_story_scene_project", "story_scene", ["project_id", "sequence"])
    op.create_table(
        "story_scene_cast",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scene_id", sa.String(length=36), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("character_id", sa.String(length=36), nullable=False),
        sa.Column("costume_id", sa.String(length=36), nullable=True),
        sa.Column("pose_text", sa.Text(), nullable=False),
        sa.Column("pose_tags", sa.JSON(), nullable=False),
        sa.Column("expression_text", sa.Text(), nullable=False),
        sa.Column("expression_tags", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["scene_id"], ["story_scene.id"]),
        sa.ForeignKeyConstraint(["character_id"], ["story_character.id"]),
        sa.ForeignKeyConstraint(["costume_id"], ["story_costume.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "scene_id", "character_id", name="uq_story_scene_cast_character"
        ),
        sa.UniqueConstraint("scene_id", "position", name="uq_story_scene_cast_position"),
    )
    op.create_index(
        "ix_story_scene_cast_character", "story_scene_cast", ["character_id"]
    )
    op.create_index("ix_story_scene_cast_costume", "story_scene_cast", ["costume_id"])
    op.create_table(
        "story_scene_dialogue",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scene_id", sa.String(length=36), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("speaker_character_id", sa.String(length=36), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("direction", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["scene_id"], ["story_scene.id"]),
        sa.ForeignKeyConstraint(["speaker_character_id"], ["story_character.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "scene_id", "position", name="uq_story_scene_dialogue_position"
        ),
    )
    op.create_index(
        "ix_story_scene_dialogue_speaker",
        "story_scene_dialogue",
        ["speaker_character_id"],
    )


def downgrade() -> None:
    """v2のキャラクター・衣装・シーンの表を削除する。"""
    op.drop_index(
        "ix_story_scene_dialogue_speaker", table_name="story_scene_dialogue"
    )
    op.drop_table("story_scene_dialogue")
    op.drop_index("ix_story_scene_cast_costume", table_name="story_scene_cast")
    op.drop_index("ix_story_scene_cast_character", table_name="story_scene_cast")
    op.drop_table("story_scene_cast")
    op.drop_index("ix_story_scene_project", table_name="story_scene")
    op.drop_table("story_scene")
    op.drop_table("story_costume_image")
    op.drop_index("ix_story_costume_character", table_name="story_costume")
    op.drop_table("story_costume")
    op.drop_index("ix_story_character_project", table_name="story_character")
    op.drop_table("story_character")
