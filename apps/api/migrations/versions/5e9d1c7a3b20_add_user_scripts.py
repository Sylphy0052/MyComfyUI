"""add user scripts

Revision ID: 5e9d1c7a3b20
Revises: 8c38759b8a34
Create Date: 2026-09-23 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5e9d1c7a3b20"
down_revision: str | Sequence[str] | None = "8c38759b8a34"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RUN_STATUSES = (
    "pending_approval",
    "approved",
    "running",
    "succeeded",
    "failed",
    "cancelled",
)


def upgrade() -> None:
    op.create_table(
        "user_script",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("capabilities", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "user_script_run",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("script_id", sa.String(length=36), nullable=False),
        sa.Column("script_sha256", sa.String(length=64), nullable=False),
        sa.Column("interpreter", sa.Text(), nullable=False),
        sa.Column("arguments", sa.JSON(), nullable=False),
        sa.Column("inputs", sa.JSON(), nullable=False),
        sa.Column("capabilities", sa.JSON(), nullable=False),
        sa.Column("output_destination", sa.Text(), nullable=False),
        sa.Column("digest", sa.String(length=64), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("approval_expires_at", sa.Text(), nullable=False),
        sa.Column("approval_token", sa.Text(), nullable=True),
        sa.Column("approved_at", sa.Text(), nullable=True),
        sa.Column("started_at", sa.Text(), nullable=True),
        sa.Column("finished_at", sa.Text(), nullable=True),
        sa.Column("exit_code", sa.Integer(), nullable=True),
        sa.Column("failure_reason", sa.Text(), nullable=True),
        sa.Column("stdout", sa.Text(), nullable=True),
        sa.Column("stderr", sa.Text(), nullable=True),
        sa.Column("output_artifact_ids", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "status in (" + ",".join(f"'{status}'" for status in RUN_STATUSES) + ")",
            name="ck_user_script_run_status",
        ),
        sa.ForeignKeyConstraint(["script_id"], ["user_script.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_user_script_run_script_id", "user_script_run", ["script_id"])
    op.create_index("ix_user_script_run_status", "user_script_run", ["status"])
    op.create_table(
        "user_script_audit_event",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("script_id", sa.String(length=36), nullable=True),
        sa.Column("run_id", sa.String(length=36), nullable=True),
        sa.Column("digest", sa.String(length=64), nullable=True),
        sa.Column("detail", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_user_script_audit_event_run_id", "user_script_audit_event", ["run_id"]
    )
    op.create_index(
        "ix_user_script_audit_event_script_id", "user_script_audit_event", ["script_id"]
    )
    # 登録済みの本文と能力を書き換えられないようにする。承認済みrunが指す内容を
    # 後から差し替える経路を、アプリの外からの更新も含めて塞ぐ。
    op.execute(
        "CREATE TRIGGER trg_user_script_immutable "
        "BEFORE UPDATE OF source, sha256, capabilities ON user_script "
        "BEGIN SELECT RAISE(ABORT, 'user_script is immutable'); END"
    )
    # 監査記録は追記だけを許す。
    op.execute(
        "CREATE TRIGGER trg_user_script_audit_no_update "
        "BEFORE UPDATE ON user_script_audit_event "
        "BEGIN SELECT RAISE(ABORT, 'user_script_audit_event is append-only'); END"
    )
    op.execute(
        "CREATE TRIGGER trg_user_script_audit_no_delete "
        "BEFORE DELETE ON user_script_audit_event "
        "BEGIN SELECT RAISE(ABORT, 'user_script_audit_event is append-only'); END"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_user_script_audit_no_delete")
    op.execute("DROP TRIGGER IF EXISTS trg_user_script_audit_no_update")
    op.execute("DROP TRIGGER IF EXISTS trg_user_script_immutable")
    op.drop_index(
        "ix_user_script_audit_event_script_id", table_name="user_script_audit_event"
    )
    op.drop_index(
        "ix_user_script_audit_event_run_id", table_name="user_script_audit_event"
    )
    op.drop_table("user_script_audit_event")
    op.drop_index("ix_user_script_run_status", table_name="user_script_run")
    op.drop_index("ix_user_script_run_script_id", table_name="user_script_run")
    op.drop_table("user_script_run")
    op.drop_table("user_script")
