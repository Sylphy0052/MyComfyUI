"""add media_role_tag reference_transcript

Revision ID: e6b1d4a79c25
Revises: c5e2a8f14b67
Create Date: 2026-10-07 12:00:00.000000

声質参照(`voice_reference`)の書き起こしを保持する`reference_transcript`を足す (#433)。
既存の行はNULLのまま読める。

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e6b1d4a79c25"
down_revision: str | Sequence[str] | None = "c5e2a8f14b67"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("media_role_tag") as batch_op:
        batch_op.add_column(sa.Column("reference_transcript", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("media_role_tag") as batch_op:
        batch_op.drop_column("reference_transcript")
