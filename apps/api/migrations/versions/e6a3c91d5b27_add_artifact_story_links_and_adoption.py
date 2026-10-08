"""add artifact story links and scene adoption

Revision ID: e6a3c91d5b27
Revises: b7d41f9a2c63
Create Date: 2026-10-08 15:00:00.000000

WebUI v2で生成物をキャラクター・衣装・シーンへ紐づけ、シーン×枠ごとの採用を持つ (#530)。
追加だけを行い、既存の列と行は変えない。

- `artifact`と`generation_job`にv2のキャラクター・衣装・シーンの列を足す。
  設計文書とIssueの`outfit_id`は、#529の命名に揃えて`story_costume_id`とする。
- `artifact`に`memo`を足す。
- `story_scene_adoption`を作る。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e6a3c91d5b27"
down_revision: str | Sequence[str] | None = "b7d41f9a2c63"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_LINKS = (
    ("story_character_id", "story_character"),
    ("story_costume_id", "story_costume"),
    ("story_scene_id", "story_scene"),
)


def upgrade() -> None:
    """列と表を足す。参照先を消すと列はNULLへ戻る。"""
    for table in ("artifact", "generation_job"):
        with op.batch_alter_table(table) as batch_op:
            for column, target in _LINKS:
                batch_op.add_column(
                    sa.Column(
                        column,
                        sa.String(length=36),
                        sa.ForeignKey(
                            f"{target}.id",
                            name=f"fk_{table}_{target}",
                            ondelete="SET NULL",
                        ),
                        nullable=True,
                    )
                )
    with op.batch_alter_table("artifact") as batch_op:
        batch_op.add_column(sa.Column("memo", sa.Text(), nullable=True))
    for column, target in _LINKS:
        op.create_index(f"ix_artifact_{target}", "artifact", [column])

    op.create_table(
        "story_scene_adoption",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scene_id", sa.String(length=36), nullable=False),
        sa.Column("slot", sa.Text(), nullable=False),
        sa.Column("dialogue_id", sa.String(length=36), nullable=True),
        sa.Column("artifact_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "slot in ('scene_image','voice','bgm','video','compose')",
            name="ck_story_scene_adoption_slot",
        ),
        sa.CheckConstraint(
            "(slot = 'voice') = (dialogue_id IS NOT NULL)",
            name="ck_story_scene_adoption_dialogue",
        ),
        sa.ForeignKeyConstraint(["scene_id"], ["story_scene.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["dialogue_id"], ["story_scene_dialogue.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["artifact_id"], ["artifact.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ux_story_scene_adoption_slot",
        "story_scene_adoption",
        ["scene_id", "slot"],
        unique=True,
        sqlite_where=sa.text("dialogue_id IS NULL"),
    )
    op.create_index(
        "ux_story_scene_adoption_dialogue",
        "story_scene_adoption",
        ["dialogue_id"],
        unique=True,
        sqlite_where=sa.text("dialogue_id IS NOT NULL"),
    )
    op.create_index(
        "ix_story_scene_adoption_artifact", "story_scene_adoption", ["artifact_id"]
    )


def downgrade() -> None:
    """足した表と列を消す。v2の紐づけとメモ、採用は失われる。"""
    op.drop_index("ix_story_scene_adoption_artifact", table_name="story_scene_adoption")
    op.drop_index("ux_story_scene_adoption_dialogue", table_name="story_scene_adoption")
    op.drop_index("ux_story_scene_adoption_slot", table_name="story_scene_adoption")
    op.drop_table("story_scene_adoption")
    for _, target in _LINKS:
        op.drop_index(f"ix_artifact_{target}", table_name="artifact")
    with op.batch_alter_table("artifact") as batch_op:
        batch_op.drop_column("memo")
    for table in ("generation_job", "artifact"):
        with op.batch_alter_table(table) as batch_op:
            for column, target in reversed(_LINKS):
                batch_op.drop_constraint(f"fk_{table}_{target}", type_="foreignkey")
                batch_op.drop_column(column)
