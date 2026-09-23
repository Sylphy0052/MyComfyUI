"""ユーザースクリプトの登録、実行、監査の記録(ADR 0003)。

`models.py`と同じ`Base`へ載せる。表の定義だけを分けたのは、scriptの実行経路を
他の生成機能から切り離して読めるようにするためである。
"""

from sqlalchemy import (
    JSON,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from mycomfyui_api.models import SHA256_LENGTH, UUID_LENGTH, Base

#: runの状態。承認待ちから始まり、承認、実行を経て終端のいずれかへ進む。
RUN_STATUSES = (
    "pending_approval",
    "approved",
    "running",
    "succeeded",
    "failed",
    "cancelled",
)
#: これ以上状態が変わらないrunの状態。
TERMINAL_RUN_STATUSES = ("succeeded", "failed", "cancelled")


#: 実行中のrunを1件に限る部分unique index。違反の判別にも使う。
SINGLE_RUNNING_INDEX = "ux_user_script_run_single_running"


class UserScript(Base):
    """登録したscript。本文とSHA-256と能力manifestは登録後に変えない。

    変更はtriggerで拒否する(migration参照)。内容を変えたいときは別のscriptとして
    登録し直す。承認済みのrunが指す本文を後から差し替えられないようにするためである。
    """

    __tablename__ = "user_script"

    id: Mapped[str] = mapped_column(String(UUID_LENGTH), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    sha256: Mapped[str] = mapped_column(String(SHA256_LENGTH), nullable=False)
    capabilities: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class UserScriptRun(Base):
    """1回の実行要求。previewで作り、承認と実行の結果を同じ行へ記録する。"""

    __tablename__ = "user_script_run"
    __table_args__ = (
        CheckConstraint(
            "status in (" + ",".join(f"'{status}'" for status in RUN_STATUSES) + ")",
            name="ck_user_script_run_status",
        ),
        Index("ix_user_script_run_script_id", "script_id"),
        Index("ix_user_script_run_status", "status"),
        # 実行中のrunを、APIのプロセスの数に関わらずDBで1件に限る。
        Index(
            SINGLE_RUNNING_INDEX,
            "status",
            unique=True,
            sqlite_where=text("status = 'running'"),
        ),
    )

    id: Mapped[str] = mapped_column(String(UUID_LENGTH), primary_key=True)
    script_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("user_script.id"), nullable=False
    )
    script_sha256: Mapped[str] = mapped_column(String(SHA256_LENGTH), nullable=False)
    interpreter: Mapped[str] = mapped_column(Text, nullable=False)
    arguments: Mapped[list] = mapped_column(JSON, nullable=False)
    inputs: Mapped[list] = mapped_column(JSON, nullable=False)
    capabilities: Mapped[dict] = mapped_column(JSON, nullable=False)
    output_destination: Mapped[str] = mapped_column(Text, nullable=False)
    digest: Mapped[str] = mapped_column(String(SHA256_LENGTH), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    approval_expires_at: Mapped[str] = mapped_column(Text, nullable=False)
    approval_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    approved_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    finished_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    stdout: Mapped[str | None] = mapped_column(Text, nullable=True)
    stderr: Mapped[str | None] = mapped_column(Text, nullable=True)
    output_artifact_ids: Mapped[list] = mapped_column(JSON, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class UserScriptAuditEvent(Base):
    """登録から終了までの出来事。追記だけを許し、更新と削除はtriggerで拒否する。"""

    __tablename__ = "user_script_audit_event"
    __table_args__ = (
        Index("ix_user_script_audit_event_run_id", "run_id"),
        Index("ix_user_script_audit_event_script_id", "script_id"),
    )

    id: Mapped[str] = mapped_column(String(UUID_LENGTH), primary_key=True)
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    script_id: Mapped[str | None] = mapped_column(String(UUID_LENGTH), nullable=True)
    run_id: Mapped[str | None] = mapped_column(String(UUID_LENGTH), nullable=True)
    digest: Mapped[str | None] = mapped_column(String(SHA256_LENGTH), nullable=True)
    detail: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
