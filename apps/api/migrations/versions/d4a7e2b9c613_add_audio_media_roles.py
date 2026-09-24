"""add audio media roles

Revision ID: d4a7e2b9c613
Revises: c3e8a1f5d207
Create Date: 2026-09-24 12:00:00.000000

音声取込に役割を付けられるよう、`media_role_tag.role`へ`voice_reference`(声質参照)と
`guide_audio`(ガイド音声)を足す (#249)。

downgradeは新しい役割の行を`other`へ戻してから制約を戻す。戻した先のCHECK制約では
扱えない値のためで、行そのものとキャラクター・割当ての紐付けは残す。

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d4a7e2b9c613"
down_revision: str | Sequence[str] | None = "c3e8a1f5d207"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLD_ROLES = "'appearance_reference','pose','background','costume','other'"
_NEW_ROLES = (
    "'appearance_reference','pose','background','costume',"
    "'voice_reference','guide_audio','other'"
)


def _media_role_tag_table(roles: str) -> sa.Table:
    """CHECK制約を差し替えるためのmedia_role_tagの定義。

    SQLiteはCHECK制約を後から付け替えられないため、batch modeで表を作り直す。
    作り直す側はSQLiteから読み取れない制約を復元できないので、現在の定義を
    `copy_from`へ明示的に渡す。索引も作り直しで失われるため、ここに含める。
    """
    return sa.Table(
        "media_role_tag",
        sa.MetaData(),
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
        sa.CheckConstraint(f"role in ({roles})", name="ck_media_role_tag_role"),
        sa.CheckConstraint(
            "(artifact_id IS NOT NULL) != (relative_path IS NOT NULL)",
            name="ck_media_role_tag_target_xor",
        ),
        sa.UniqueConstraint("artifact_id", name="uq_media_role_tag_artifact_id"),
        sa.UniqueConstraint("relative_path", name="uq_media_role_tag_relative_path"),
        sa.Index(
            "ix_media_role_tag_assignment", "assigned_project_id", "assigned_scene_id"
        ),
    )


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table(
        "media_role_tag",
        copy_from=_media_role_tag_table(_OLD_ROLES),
        recreate="always",
    ) as batch_op:
        batch_op.drop_constraint("ck_media_role_tag_role", type_="check")
        batch_op.create_check_constraint(
            "ck_media_role_tag_role", f"role in ({_NEW_ROLES})"
        )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute(
        "update media_role_tag set role = 'other' "
        "where role in ('voice_reference','guide_audio')"
    )
    with op.batch_alter_table(
        "media_role_tag",
        copy_from=_media_role_tag_table(_NEW_ROLES),
        recreate="always",
    ) as batch_op:
        batch_op.drop_constraint("ck_media_role_tag_role", type_="check")
        batch_op.create_check_constraint(
            "ck_media_role_tag_role", f"role in ({_OLD_ROLES})"
        )
