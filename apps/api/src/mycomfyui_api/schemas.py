from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

GenerationKind = Literal["image", "video", "voice", "music", "compose"]
ArtifactKind = Literal["image", "video", "audio", "workflow", "log"]
Availability = Literal["complete", "incomplete"]
ArtifactDecision = Literal["undecided", "accepted", "rejected"]
ApprovalDecision = Literal["approved", "rejected", "expired"]
JobState = Literal[
    "queued", "running", "cancelling", "succeeded", "failed", "cancelled"
]

# hashは大文字小文字を問わず受け取り、小文字へ正規化して保存する。
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-fA-F]{64}$"), AfterValidator(str.lower)]
ResourceId = Annotated[str, Field(min_length=1, max_length=36)]


def new_id() -> str:
    return str(uuid4())


def now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _reject_unsafe_path(value: str) -> str:
    """data_root基準の相対パスだけを受け付ける。"""
    candidate = value.strip()
    if not candidate:
        raise ValueError("relative_pathを空にできません。")
    if candidate.startswith("/") or candidate.startswith("\\"):
        raise ValueError("relative_pathに絶対パスを指定できません。")
    if len(candidate) > 1 and candidate[1] == ":":
        raise ValueError("relative_pathに絶対パスを指定できません。")
    parts = candidate.replace("\\", "/").split("/")
    if ".." in parts:
        raise ValueError("relative_pathに親ディレクトリ参照を指定できません。")
    return candidate


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class RecipeCreate(ApiModel):
    name: str = Field(min_length=1)
    kind: GenerationKind
    engine: str = Field(min_length=1)
    workflow_template_ref: dict[str, Any]
    input_schema: dict[str, Any]
    defaults: dict[str, Any]
    supersedes_recipe_id: ResourceId | None = None


class RecipeRead(ApiModel):
    id: str
    name: str
    kind: str
    engine: str
    workflow_template_ref: dict[str, Any]
    input_schema: dict[str, Any]
    defaults: dict[str, Any]
    supersedes_recipe_id: str | None
    created_at: str


class WorkflowArtifactCreate(ApiModel):
    """Manifestが参照する実行時Workflow JSONのArtifact。"""

    relative_path: str
    sha256: Sha256
    byte_size: int = Field(ge=0)
    media_type: str = Field(min_length=1)

    @field_validator("relative_path")
    @classmethod
    def _validate_relative_path(cls, value: str) -> str:
        return _reject_unsafe_path(value)


class ManifestCreate(ApiModel):
    engine: str = Field(min_length=1)
    engine_version: str = Field(min_length=1)
    model: dict[str, Any]
    seed: int
    resolved_prompt: str
    parameters: dict[str, Any]
    input_refs: list[dict[str, Any]]
    workflow_artifact: WorkflowArtifactCreate


class GenerationJobCreate(ApiModel):
    """Jobと実行時Manifestを同一トランザクションで作成する要求。"""

    kind: GenerationKind
    scene_ref: dict[str, Any]
    shot_ref: dict[str, Any]
    recipe_id: ResourceId
    parent_job_id: ResourceId | None = None
    queue_sequence: int = Field(ge=0)
    manifest: ManifestCreate


class GenerationJobRead(ApiModel):
    id: str
    kind: str
    state: str
    scene_ref: dict[str, Any]
    shot_ref: dict[str, Any]
    recipe_id: str
    manifest_id: str
    parent_job_id: str | None
    queue_sequence: int
    cancel_requested_at: str | None
    started_at: str | None
    finished_at: str | None
    failure_code: str | None
    failure_message: str | None


class GenerationManifestRead(ApiModel):
    id: str
    job_id: str
    engine: str
    engine_version: str
    model: dict[str, Any]
    seed: int
    resolved_prompt: str
    parameters: dict[str, Any]
    input_refs: list[dict[str, Any]]
    workflow_artifact_id: str
    created_at: str


class ArtifactCreate(ApiModel):
    job_id: ResourceId
    kind: ArtifactKind
    relative_path: str
    sha256: Sha256
    byte_size: int = Field(ge=0)
    media_type: str = Field(min_length=1)
    availability: Availability
    parent_artifact_id: ResourceId | None = None

    @field_validator("relative_path")
    @classmethod
    def _validate_relative_path(cls, value: str) -> str:
        return _reject_unsafe_path(value)


class ArtifactRead(ApiModel):
    id: str
    job_id: str
    kind: str
    relative_path: str
    sha256: str
    byte_size: int
    media_type: str
    availability: str
    parent_artifact_id: str | None
    created_at: str
    decision: str
    decision_at: str | None


class ApprovalLogCreate(ApiModel):
    subject_type: str = Field(min_length=1)
    subject_id: str = Field(min_length=1)
    requested_operation: dict[str, Any]
    decision: ApprovalDecision
    actor_type: str = Field(min_length=1)
    actor_id: str = Field(min_length=1)
    expires_at: str | None = None


class ApprovalLogRead(ApiModel):
    id: str
    subject_type: str
    subject_id: str
    requested_operation: dict[str, Any]
    decision: str
    actor_type: str
    actor_id: str
    decided_at: str
    expires_at: str | None
