from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

from mycomfyui_api.storage import ARTIFACTS_DIR_NAME

GenerationKind = Literal["image", "video", "voice", "music", "compose"]
ArtifactKind = Literal["image", "video", "audio", "workflow", "log"]
Availability = Literal["complete", "incomplete"]
ArtifactDecision = Literal["undecided", "accepted", "rejected"]
ApprovalDecision = Literal["approved", "rejected", "expired"]
JobState = Literal[
    "queued", "running", "cancelling", "succeeded", "failed", "cancelled"
]
FailureStage = Literal["backend_start", "execution", "response_disconnect", "timeout"]

# hashは大文字小文字を問わず受け取り、小文字へ正規化して保存する。
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-fA-F]{64}$"), AfterValidator(str.lower)]
ResourceId = Annotated[str, Field(min_length=1, max_length=36)]

#: Artifactとして受け付けるmedia_type。配信時のContent-Typeになるため、
#: `text/html`のようにブラウザが解釈する型を混ぜない。
ALLOWED_MEDIA_TYPE_PREFIXES = ("image/", "video/", "audio/")
ALLOWED_MEDIA_TYPES = frozenset({"application/json", "text/plain"})


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


class GenerationJobCreate(ApiModel):
    """Jobと実行時Manifestを同一トランザクションで作成する要求。

    Workflow JSONはApplication APIがRecipeと`inputs`から組み立てる。呼び出し元は
    Manifestの中身もComfyUIのノードも組み立てない。
    """

    kind: GenerationKind
    scene_ref: dict[str, Any]
    shot_ref: dict[str, Any]
    recipe_id: ResourceId
    parent_job_id: ResourceId | None = None
    #: 未指定ならApplication APIが現在の最大値の次を採番する。
    queue_sequence: int | None = Field(default=None, ge=0)
    inputs: dict[str, Any] = Field(default_factory=dict)
    input_refs: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("input_refs")
    @classmethod
    def _validate_input_refs(cls, value: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """入力cache参照の`relative_path`も`data_root`基準に限定する。

        Manifestへそのまま保存され、後からファイル解決に使われる値のため、保存する
        時点で絶対パスと親ディレクトリ参照を弾く。
        """
        for ref in value:
            relative_path = ref.get("relative_path")
            if isinstance(relative_path, str):
                _reject_unsafe_path(relative_path)
        return value


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
    failure_stage: str | None
    retryable: bool | None


class GenerationManifestRead(ApiModel):
    id: str
    job_id: str
    engine: str
    engine_version: str | None
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
        """Artifact storeの外にあるファイルをArtifactとして登録させない。

        登録した`relative_path`は`GET /artifacts/{id}/content`でそのまま配信される。
        `data_root`配下であることだけを条件にすると、DBファイルのような生成物以外を
        指すレコードを作り、配信経路から読み出せてしまう。
        """
        candidate = _reject_unsafe_path(value)
        normalized = candidate.replace("\\", "/")
        if not normalized.startswith(f"{ARTIFACTS_DIR_NAME}/"):
            raise ValueError(
                f"relative_pathは{ARTIFACTS_DIR_NAME}/配下を指す必要があります。"
            )
        return candidate

    @field_validator("media_type")
    @classmethod
    def _validate_media_type(cls, value: str) -> str:
        """配信時のContent-Typeになるため、生成物として扱う型だけを受け付ける。"""
        media_type = value.split(";", 1)[0].strip().lower()
        if media_type in ALLOWED_MEDIA_TYPES:
            return value
        if media_type.startswith(ALLOWED_MEDIA_TYPE_PREFIXES):
            return value
        raise ValueError(f"扱えないmedia_typeです: {value}")


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


class ArtifactDecisionUpdate(ApiModel):
    """候補比較での採否。`undecided`へ戻すこともできる。"""

    decision: ArtifactDecision


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
