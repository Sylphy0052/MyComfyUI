from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

UUID_LENGTH = 36
SHA256_LENGTH = 64


class Base(DeclarativeBase):
    pass


def _uuid_column(*, primary_key: bool = False):
    return mapped_column(String(UUID_LENGTH), primary_key=primary_key)


class Recipe(Base):
    """Reusable generation template. Immutable once created; superseded by a new row."""

    __tablename__ = "recipe"

    id: Mapped[str] = _uuid_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    engine: Mapped[str] = mapped_column(Text, nullable=False)
    workflow_template_ref: Mapped[dict] = mapped_column(JSON, nullable=False)
    input_schema: Mapped[dict] = mapped_column(JSON, nullable=False)
    defaults: Mapped[dict] = mapped_column(JSON, nullable=False)
    supersedes_recipe_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("recipe.id"), nullable=True
    )
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class GenerationJob(Base):
    """Execution request. State transitions are enforced by the API layer, not the DB."""

    __tablename__ = "generation_job"
    __table_args__ = (
        CheckConstraint(
            "kind in ('image','video','voice','music','compose')",
            name="ck_generation_job_kind",
        ),
        CheckConstraint(
            "state in ('queued','running','cancelling','succeeded','failed','cancelled')",
            name="ck_generation_job_state",
        ),
        CheckConstraint(
            "failure_stage is null or failure_stage in "
            "('backend_start','execution','response_disconnect','timeout')",
            name="ck_generation_job_failure_stage",
        ),
        ForeignKeyConstraint(
            ["manifest_id"],
            ["generation_manifest.id"],
            name="fk_generation_job_manifest_id",
            deferrable=True,
            initially="DEFERRED",
        ),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    scene_ref: Mapped[dict] = mapped_column(JSON, nullable=False)
    shot_ref: Mapped[dict] = mapped_column(JSON, nullable=False)
    recipe_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("recipe.id"), nullable=False
    )
    manifest_id: Mapped[str] = mapped_column(String(UUID_LENGTH), nullable=False)
    parent_job_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("generation_job.id"), nullable=True
    )
    queue_sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    cancel_requested_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    finished_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_stage: Mapped[str | None] = mapped_column(Text, nullable=True)
    retryable: Mapped[bool | None] = mapped_column(Boolean, nullable=True)


class GenerationManifest(Base):
    """Resolved execution snapshot for exactly one GenerationJob. Immutable once created."""

    __tablename__ = "generation_manifest"
    __table_args__ = (
        ForeignKeyConstraint(
            ["job_id"],
            ["generation_job.id"],
            name="fk_generation_manifest_job_id",
            deferrable=True,
            initially="DEFERRED",
        ),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    job_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), nullable=False, unique=True
    )
    engine: Mapped[str] = mapped_column(Text, nullable=False)
    engine_version: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[dict] = mapped_column(JSON, nullable=False)
    seed: Mapped[int] = mapped_column(Integer, nullable=False)
    resolved_prompt: Mapped[str] = mapped_column(Text, nullable=False)
    parameters: Mapped[dict] = mapped_column(JSON, nullable=False)
    input_refs: Mapped[list] = mapped_column(JSON, nullable=False)
    workflow_artifact_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("artifact.id"), nullable=False
    )
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class Artifact(Base):
    """Stored file reference produced by (or diagnostic to) a GenerationJob."""

    __tablename__ = "artifact"
    __table_args__ = (
        CheckConstraint(
            "availability in ('complete','incomplete')", name="ck_artifact_availability"
        ),
        CheckConstraint(
            "decision in ('undecided','accepted','rejected')",
            name="ck_artifact_decision",
        ),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    job_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("generation_job.id"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    relative_path: Mapped[str] = mapped_column(Text, nullable=False)
    sha256: Mapped[str] = mapped_column(String(SHA256_LENGTH), nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    media_type: Mapped[str] = mapped_column(Text, nullable=False)
    availability: Mapped[str] = mapped_column(Text, nullable=False)
    parent_artifact_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("artifact.id"), nullable=True
    )
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    decision: Mapped[str] = mapped_column(Text, nullable=False, default="undecided")
    decision_at: Mapped[str | None] = mapped_column(Text, nullable=True)


class ApprovalLog(Base):
    """Append-only record of a proposed operation and its decision."""

    __tablename__ = "approval_log"
    __table_args__ = (
        CheckConstraint(
            "decision in ('approved','rejected','expired')",
            name="ck_approval_log_decision",
        ),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    subject_type: Mapped[str] = mapped_column(Text, nullable=False)
    subject_id: Mapped[str] = mapped_column(Text, nullable=False)
    requested_operation: Mapped[dict] = mapped_column(JSON, nullable=False)
    decision: Mapped[str] = mapped_column(Text, nullable=False)
    actor_type: Mapped[str] = mapped_column(Text, nullable=False)
    actor_id: Mapped[str] = mapped_column(Text, nullable=False)
    decided_at: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[str | None] = mapped_column(Text, nullable=True)
