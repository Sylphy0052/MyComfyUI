"""add look profiles

Revision ID: 6b72c4d91e30
Revises: 3f6a8c2d1e04
Create Date: 2026-09-22 10:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "6b72c4d91e30"
down_revision: str | Sequence[str] | None = "3f6a8c2d1e04"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "look_profile",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("category", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("recipe_id", sa.String(length=36), nullable=True),
        sa.Column("inputs", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "kind in ('image','video','voice','music','compose')",
            name="ck_look_profile_kind",
        ),
        sa.CheckConstraint(
            "category in ('general','style','character','background')",
            name="ck_look_profile_category",
        ),
        sa.ForeignKeyConstraint(["recipe_id"], ["recipe.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("kind", "name", name="uq_look_profile_kind_name"),
    )
    op.execute(
        "CREATE TRIGGER trg_look_profile_limit "
        "BEFORE INSERT ON look_profile "
        "WHEN (SELECT COUNT(*) FROM look_profile) >= 200 "
        "BEGIN SELECT RAISE(ABORT, 'look_profile limit reached'); END"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_look_profile_limit")
    op.drop_table("look_profile")
