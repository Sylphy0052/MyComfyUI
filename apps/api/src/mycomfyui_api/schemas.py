from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from mycomfyui_api import provenance
from mycomfyui_api.adapters.agent.base import AgentProposalKind
from mycomfyui_api.adapters.agent.proposals import MAX_INSTRUCTION_LENGTH
from mycomfyui_api.approvals import OperationEffect
from mycomfyui_api.settings import AgentProviderId
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

#: タグの最大長。表示と絞り込みに使う短いラベルだけを想定する。
MAX_TAG_LENGTH = 64


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


def normalize_tag(value: str) -> str:
    """タグとして受け付ける値だけを通す。

    前後の空白だけを落とし、大文字小文字と表記の揺れはそのまま残す。正規化は同義語の
    管理にあたり、Issue #42の対象外である。

    制御文字と`/`は拒否する。タグはパスセグメント(`DELETE /artifacts/{id}/tags/{tag}`)
    としてURLに載るため、区切り文字を値に許すと削除対象を一意に指せない。
    """
    candidate = value.strip()
    if not candidate:
        raise ValueError("タグを空にできません。")
    if len(candidate) > MAX_TAG_LENGTH:
        raise ValueError(f"タグは{MAX_TAG_LENGTH}文字以内で指定してください。")
    if "/" in candidate:
        raise ValueError("タグに/を含められません。")
    if any(character.isspace() and character != " " for character in candidate):
        raise ValueError("タグに改行とタブを含められません。")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in candidate):
        raise ValueError("タグに制御文字を含められません。")
    return candidate


#: Artifactへ付けるタグ。前後の空白を落とした値を保存し、完全一致で絞り込む。
ArtifactTagValue = Annotated[
    str, Field(min_length=1, max_length=MAX_TAG_LENGTH), AfterValidator(normalize_tag)
]


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class WorkflowVersionRead(ApiModel):
    """Workflowの1版。変数定義、対応モデル、入出力をそのまま返す。"""

    id: str
    workflow_id: str
    version: str
    template_sha256: str | None
    variables: dict[str, Any]
    model_slots: list[dict[str, Any]]
    inputs: list[dict[str, Any]]
    outputs: list[dict[str, Any]]
    created_at: str


class WorkflowRead(ApiModel):
    id: str
    name: str
    kind: str
    engines: list[str]
    created_at: str


class RecipeCreate(ApiModel):
    name: str = Field(min_length=1)
    kind: GenerationKind
    engine: str = Field(min_length=1)
    workflow_template_ref: dict[str, Any]
    input_schema: dict[str, Any]
    defaults: dict[str, Any]
    #: 参照するWorkflow版。省略した場合は`workflow_template_ref`から解決する。
    workflow_version_id: ResourceId | None = None
    supersedes_recipe_id: ResourceId | None = None


class RecipeRead(ApiModel):
    id: str
    name: str
    kind: str
    engine: str
    workflow_template_ref: dict[str, Any]
    input_schema: dict[str, Any]
    defaults: dict[str, Any]
    workflow_version_id: str | None
    supersedes_recipe_id: str | None
    created_at: str


class GenerationPreviewCreate(ApiModel):
    """投入せずに、解決済みの入力とWorkflow差分だけを確かめる要求。

    項目はJobの作成要求からキュー順の指定を除いたものとする。プレビューはキューへ
    積まないため、順番を受け取らない。
    """

    kind: GenerationKind
    project_id: AiMediaId
    scene_id: AiMediaId
    shot_id: AiMediaId
    recipe_id: ResourceId
    parent_job_id: ResourceId | None = None
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


class GenerationJobCreate(GenerationPreviewCreate):
    """Jobと実行時Manifestを同一トランザクションで作成する要求。

    Workflow JSONはApplication APIがRecipeと`inputs`から組み立てる。Scene、Shot、
    Canonの不変参照も参照APIから解決して固定する。呼び出し元はManifestの中身も
    ComfyUIのノードも参照の中身も組み立てない。
    """

    #: 未指定ならApplication APIが現在の最大値の次を採番する。
    queue_sequence: int | None = Field(default=None, ge=0)


class GenerationPreviewDiff(ApiModel):
    """1変数について、Workflowの既定値と今回確定する値の対比。"""

    name: str
    #: Workflowテンプレートのノード入力に書かれている値。テンプレートファイルを持た
    #: ないWorkflow(音声・合成)ではNoneになる。
    workflow_default: Any
    #: Recipeの`defaults`の値。指定が無ければNone。
    recipe_default: Any
    #: 今回の入力で確定する値。
    value: Any
    #: 基準となる既定値と`value`が異なるか。基準は`workflow_default`とし、それを
    #: 持たないWorkflowでは`recipe_default`を使う。どちらも無ければ偽とする。
    changed: bool
    #: 値の出所。
    origin: Literal["input", "recipe_default", "workflow_default", "adapter"]


class GenerationPreviewRead(ApiModel):
    """投入前に確認する、解決済みの実行内容とWorkflow差分。

    実行スナップショット本体は返さない。Workflow JSONの差分表示は対象外のため、
    確定した値と既定値との対比だけを示す。
    """

    scene_ref: dict[str, Any]
    shot_ref: dict[str, Any]
    canon_refs: list[dict[str, Any]]
    engine: str
    resolved_prompt: str
    model: dict[str, Any]
    seed: int
    #: seedを自動採番したか。真のとき、投入時のseedはこの値と一致しない。
    seed_auto: bool
    parameters: dict[str, Any]
    resolved_inputs: dict[str, Any]
    input_refs: list[dict[str, Any]]
    workflow_name: str | None
    workflow_version_id: str | None
    version: str | None
    template_sha256: str | None
    diff: list[GenerationPreviewDiff]
    parent_job_id: str | None


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
    """Artifact 1件。`tags`は付けた順ではなくタグの昇順で返す。

    `tags`はArtifactを返すすべての経路で埋める。経路によって入ったり入らなかったり
    すると、空配列が「タグ無し」なのか「この経路では返していない」のか区別できない。
    """

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
    tags: list[str] = Field(default_factory=list)


class ArtifactDecisionUpdate(ApiModel):
    """候補比較での採否。`undecided`へ戻すこともできる。"""

    decision: ArtifactDecision


class ArtifactTagCreate(ApiModel):
    """Artifactへ付けるタグ。"""

    tag: ArtifactTagValue


#: 整合性一覧が返す理由。1件のArtifactへ複数付きうる。
ArtifactIntegrityReason = Literal[
    "file_missing", "hash_mismatch", "reference_broken", "canon_updated"
]


class ArtifactIntegrityFinding(ApiModel):
    """1件の理由と、その根拠。"""

    reason: ArtifactIntegrityReason
    message: str


class ArtifactIntegrityEntry(ApiModel):
    """整合性を欠いたArtifact 1件。理由が1つも無いArtifactは一覧へ出さない。"""

    artifact: ArtifactRead
    findings: list[ArtifactIntegrityFinding]


class ArtifactIntegrityRead(ApiModel):
    """整合性一覧。判定は読み取りのみで、ManifestとArtifactの記録値を更新しない。

    `checked`は判定したArtifactの件数、`truncated`は上限で打ち切ったかどうかを表す。
    `items`の件数だけでは全件を見たのか途中で止めたのかが判らないため応答へ出す。

    `canon_available`が`False`のとき、`canon_updated`の判定ができていない。参照APIを
    引けなかった場合と、`include_canon=false`で判定を求められなかった場合の両方が
    あり、理由は`canon_reason`に入る。ファイル側の判定はそのまま続けるため、`items`は
    `canon_updated`以外の理由だけを含む。
    """

    items: list[ArtifactIntegrityEntry]
    checked: int
    truncated: bool
    canon_available: bool
    canon_reason: str | None


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


AgentProposalState = Literal["proposed", "approved", "rejected", "applied", "failed"]
#: 画面から記録できる判断。`expired`は期限切れの検出結果であり、画面からは送らない。
AgentDecision = Literal["approved", "rejected"]


class AgentProviderRead(ApiModel):
    """利用可能なProvider。接続先と認証情報は返さない。"""

    id: str
    label: str
    available: bool


class AgentProposalCreate(ApiModel):
    """提案の取得要求。Jobは作らない。

    入力コンテキストはApplication APIが参照APIから解決して組み立てる。呼び出し元から
    Providerへ渡す本文を指定させない。
    """

    kind: AgentProposalKind
    #: 未指定なら設定の既定Providerを使う。
    provider_id: AgentProviderId | None = None
    project_id: AiMediaId
    scene_id: AiMediaId
    shot_id: AiMediaId | None = None
    #: `image_prompt`では承認後のJob投入先を決めるため必須とする。
    recipe_id: ResourceId | None = None
    instruction: str = Field(default="", max_length=MAX_INSTRUCTION_LENGTH)

    @model_validator(mode="after")
    def _require_targets(self) -> "AgentProposalCreate":
        if self.kind == "image_prompt" and (self.shot_id is None or not self.recipe_id):
            raise ValueError("image_promptの提案にはshot_idとrecipe_idが必要です。")
        return self


class PlannedOperation(ApiModel):
    """提案を承認したときに実行する操作。

    `digest`は操作内容から算出する。承認したあとに対象や内容が変わると値が変わり、
    古い承認では実行できない。
    """

    type: str
    effect: OperationEffect
    target: dict[str, Any]
    payload: dict[str, Any]
    digest: str


class AgentProposalRead(ApiModel):
    id: str
    provider_id: str
    kind: str
    state: str
    project_id: str
    scene_id: str
    shot_id: str | None
    recipe_id: str | None
    instruction: str
    request_context: dict[str, Any]
    output: dict[str, Any] | None
    usage: dict[str, Any] | None
    model: str | None
    failure_code: str | None
    failure_message: str | None
    applied_job_id: str | None
    created_at: str
    decided_at: str | None
    #: 副作用のある操作を伴わない提案ではNoneになる。
    planned_operation: PlannedOperation | None = None


class AgentProposalDecision(ApiModel):
    """提案への判断。承認しても、適用は別の要求で明示的に行う。"""

    decision: AgentDecision
    actor_id: str = Field(default="local-user", min_length=1, max_length=200)


#: 読み検証の実施状況。`verified`以外では`match`がNoneになる。
VoiceVerificationStatus = Literal[
    "verified", "skipped", "asr_failed", "kana_unavailable"
]


class VoiceVerificationRead(ApiModel):
    """1台詞ぶんの読み検証と尺の記録。

    `match`はカタカナへ正規化したうえでの完全一致可否とする。表記のまま比べると、
    Whisperが返す同音の別表記(朝比奈 → 朝日菜)で、読めているのに不一致になる。
    """

    id: str
    job_id: str
    artifact_id: str
    dialogue_index: int
    expected_text: str
    expected_reading: str | None
    asr_text: str | None
    normalized_expected: str | None
    normalized_asr: str | None
    match: bool | None
    diff_ratio: float | None
    audio_sec: float
    padded_sec: float
    target_duration_sec: float
    status: str
    created_at: str


class VoiceEngineHealthRead(ApiModel):
    """voice-runnerが公開する1engineの状態。"""

    id: str
    available: bool
    model: str | None = None
    revision: str | None = None
    sample_rate: int | None = None
    needs_katakana: bool = False
    detail: str | None = None


class VoiceBackendHealthRead(ApiModel):
    """voice-runnerの疎通確認。認証情報は扱わないため返さない。"""

    base_url: str
    reachable: bool
    reason: str | None = None
    engines: list[VoiceEngineHealthRead] = Field(default_factory=list)


class VoiceReferenceCreate(ApiModel):
    """参照音声の取り込み要求。

    参照APIはVoice Canonの`source_audio`(作成者環境の絶対path)を公開しないため、
    参照音声そのものを参照APIから取得する経路は無い。利用者が手元の音源を取り込み、
    入力cacheとして保持する。
    """

    file_name: str = Field(min_length=1, max_length=255)
    #: wavのbase64。JSONで受け取り、multipartの依存を増やさない。
    content_base64: str = Field(min_length=1)


class VoiceReferenceRead(ApiModel):
    """取り込んだ参照音声。`sha256`をVoice Canonの`source_sha256`と突き合わせる。"""

    relative_path: str
    sha256: str
    byte_size: int
    media_type: str
    sample_rate: int
    channels: int
    duration_sec: float


class ComfyUIBackendHealthRead(ApiModel):
    """ComfyUIの疎通確認。認証情報は扱わないため返さない。"""

    base_url: str
    reachable: bool
    reason: str | None = None
    version: str | None = None
    devices: list[str] = Field(default_factory=list)


class ImageReferenceCreate(ApiModel):
    """参照画像とガイド音声の取り込み要求。

    H3の`LoadImage`と`LoadAudio`はComfyUI側のinputにあるファイルしか参照できない。
    手元の素材を入力cacheへ取り込み、Job投入時にその参照を指定する。
    """

    file_name: str = Field(min_length=1, max_length=255)
    #: 素材のbase64。JSONで受け取り、multipartの依存を増やさない。
    content_base64: str = Field(min_length=1)
    #: 取り込むファイルのmedia_type。画像と音声だけを受け付ける。
    media_type: str = Field(min_length=1)

    @field_validator("media_type")
    @classmethod
    def _validate_media_type(cls, value: str) -> str:
        media_type = value.split(";", 1)[0].strip().lower()
        if media_type in REJECTED_MEDIA_TYPES:
            raise ValueError(f"扱えないmedia_typeです: {value}")
        if not media_type.startswith(("image/", "audio/")):
            raise ValueError(f"扱えないmedia_typeです: {value}")
        return media_type


class ImageReferenceRead(ApiModel):
    """取り込んだ素材。`sha256`はManifestへ記録する参照と同じ値になる。"""

    relative_path: str
    sha256: str
    byte_size: int
    media_type: str
