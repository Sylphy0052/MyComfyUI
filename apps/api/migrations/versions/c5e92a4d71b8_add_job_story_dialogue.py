"""add generation_job story dialogue link

Revision ID: c5e92a4d71b8
Revises: a4c8e17b92d3
Create Date: 2026-10-08 18:00:00.000000

台詞1行の音声Jobが、どの台詞の行かを記録する (#573)。追加だけを行い、既存の列と行は
変えない。参照先の台詞を消すと列はNULLへ戻る。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c5e92a4d71b8"
down_revision: str | Sequence[str] | None = "a4c8e17b92d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("generation_job") as batch_op:
        batch_op.add_column(
            sa.Column(
                "story_dialogue_id",
                sa.String(length=36),
                sa.ForeignKey(
                    "story_scene_dialogue.id",
                    name="fk_generation_job_story_dialogue",
                    ondelete="SET NULL",
                ),
                nullable=True,
            )
        )


def downgrade() -> None:
    """足した列を消す。台詞の行の記録は失われる。"""
    with op.batch_alter_table("generation_job") as batch_op:
        batch_op.drop_constraint("fk_generation_job_story_dialogue", type_="foreignkey")
        batch_op.drop_column("story_dialogue_id")
