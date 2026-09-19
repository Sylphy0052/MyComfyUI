from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

from mycomfyui_api import provenance
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

#: ai-media参照APIのIDの書式。契約のIDは英数字とハイフンだけで、ドットもスラッシュも
#: 含まない。上流URLのパスセグメントへ埋め込む値のため、ここで書式を固定する。
REFERENCE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
#: Canon descriptorのIDは参照契約で小文字16進数64桁と決まっている。
CANON_ID_PATTERN = r"^[0-9a-f]{64}$"

AiMediaId = Annotated[str, Field(pattern=REFERENCE_ID_PATTERN)]

#: Artifactとして受け付けるmedia_type。配信時のContent-Typeになるため、
#: `text/html`のようにブラウザが解釈する型を混ぜない。
ALLOWED_MEDIA_TYPE_PREFIXES = ("image/", "video/", "audio/")
ALLOWED_MEDIA_TYPES = frozenset({"application/json", "text/plain"})

#: 画像だがスクリプトを埋め込める形式。生成物として扱わない。
REJECTED_MEDIA_TYPES = frozenset({"image/svg+xml", "image/svg"})


def new_id() -> str:
    return str(uuid4())


def now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _reject_unsafe_path(value: str) -> str:
    """data_root基準の相対パスだけを受け付ける。

    空セグメント(`a//b`)と`.`セグメント(`a/./b`)も拒否する。同じ場所を指すのに文字列
    としては別物になり、記録した値をそのまま突き合わせる再現判定がずれるためである。
    """
    candidate = value.strip()
    if not candidate:
        raise ValueError("relative_pathを空にできません。")
    if candidate.startswith(("/", "\\")):
        raise ValueError("relative_pathに絶対パスを指定できません。")
    if len(candidate) > 1 and candidate[1] == ":":
        raise ValueError("relative_pathに絶対パスを指定できません。")
    parts = candidate.replace("\\", "/").split("/")
    if ".." in parts:
        raise ValueError("relative_pathに親ディレクトリ参照を指定できません。")
    if any(part in ("", ".") for part in parts):
        raise ValueError("relative_pathを正規化した形で指定してください。")
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

    Workflow JSONはApplication APIがRecipeと`inputs`から組み立てる。Scene、Shot、
    Canonの不変参照も参照APIから解決して固定する。呼び出し元はManifestの中身も
    ComfyUIのノードも参照の中身も組み立てない。
    """

    kind: GenerationKind
    project_id: AiMediaId
    scene_id: AiMediaId
    shot_id: AiMediaId
    recipe_id: ResourceId
    parent_job_id: ResourceId | None = None
    #: 未指定ならApplication APIが現在の最大値の次を採番する。
    queue_sequence: int | None = Field(default=None, ge=0)
    inputs: dict[str, Any] = Field(default_factory=dict)
    #: 利用者素材のcache参照だけを受け取る。Scene/Shot/Canonの参照は解決結果が正本の
    #: ため、ここから渡された同種の参照は受け付けない。
    input_refs: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("input_refs")
    @classmethod
    def _validate_input_refs(cls, value: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """入力cache参照だけを受け付け、`relative_path`を`data_root`基準に限定する。

        Manifestへそのまま保存され、後からファイル解決に使われる値のため、保存する
        時点で絶対パスと親ディレクトリ参照を弾く。参照APIから解決する種別を呼び出し元
        から渡せると、記録済みのCanon参照を外から差し替えられてしまうため拒否する。

        拒否したい種別を並べるのではなく`cached_input`だけを許可する。表記を変えた
        `Scene`のような値が拒否をすり抜け、解決していない参照が来歴として残るのを
        防ぐためである。
        """
        for ref in value:
            kind = ref.get("kind")
            if kind != provenance.KIND_CACHED_INPUT:
                raise ValueError(
                    f"input_refsには{provenance.KIND_CACHED_INPUT}の参照だけを"
                    f"指定できます: {kind!r}"
                )
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
    replay_of_manifest_id: str | None
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
        if media_type in REJECTED_MEDIA_TYPES:
            raise ValueError(f"扱えないmedia_typeです: {value}")
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


#: 記録済み参照と現在の参照を突き合わせた結果。
ReferenceChange = Literal["unchanged", "updated", "missing", "added"]
#: Canon更新警告のまとめ。`unavailable`は参照APIを引けず比較できなかったことを表す。
CanonStatusValue = Literal["unchanged", "changed", "unavailable"]


class ReferenceChangeEntry(ApiModel):
    """1件の参照について、記録時と現在を並べた比較結果。

    `reason`は参照APIでは解決せず、実ファイルを読んで判定した場合にだけ理由が入る。
    """

    kind: str
    change: ReferenceChange
    path: str | None
    anchor: str | None
    note: str | None
    reason: str | None = None
    recorded: dict[str, Any] | None
    current: dict[str, Any] | None


class CanonStatusRead(ApiModel):
    """Canon更新警告と、Exact Replayの可否。

    記録済みのManifestとArtifactは更新しない。`replayable`が`False`のとき、
    `blocking`に当時条件を再現できない参照が入る。
    """

    job_id: str
    manifest_id: str
    status: CanonStatusValue
    replayable: bool
    reason: str | None
    entries: list[ReferenceChangeEntry]
    blocking: list[ReferenceChangeEntry]


class JobLineageRead(ApiModel):
    """親子Jobと、それぞれのArtifact。

    `ancestors`は親から順に、`descendants`は世代の浅い順に並べる。`artifacts`は
    `parent_artifact_id`で派生関係を辿れるよう、lineageに含まれる全Jobの分を返す。
    `truncated`は探索を上限で打ち切ったことを表す。全件と取り違えないよう応答へ出す。
    """

    job: GenerationJobRead
    ancestors: list[GenerationJobRead]
    descendants: list[GenerationJobRead]
    artifacts: list[ArtifactRead]
    truncated: bool
