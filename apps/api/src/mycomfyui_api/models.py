from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

UUID_LENGTH = 36
SHA256_LENGTH = 64
PROJECT_ID_LENGTH = 128


class Base(DeclarativeBase):
    pass


def _uuid_column(*, primary_key: bool = False):
    return mapped_column(String(UUID_LENGTH), primary_key=primary_key)


class Project(Base):
    """制作物をまとめる永続Project。

    `id`とsource情報は作成後に変更しない。削除要求は`lifecycle`を`trashed`へ進め、
    関連するJobやArtifactを消さない。
    """

    __tablename__ = "project"
    __table_args__ = (
        CheckConstraint(
            "status in ('planning','active','on_hold','completed')",
            name="ck_project_status",
        ),
        CheckConstraint(
            "lifecycle in ('active','archived','trashed')",
            name="ck_project_lifecycle",
        ),
        CheckConstraint(
            "source_type in ('local','external')", name="ck_project_source_type"
        ),
        UniqueConstraint("name", name="uq_project_name"),
        Index("ix_project_lifecycle_last_used", "lifecycle", "last_used_at"),
    )

    id: Mapped[str] = mapped_column(String(PROJECT_ID_LENGTH), primary_key=True)
    name: Mapped[str] = mapped_column(Text(collation="NOCASE"), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    lifecycle: Mapped[str] = mapped_column(Text, nullable=False)
    tags: Mapped[list] = mapped_column(JSON, nullable=False)
    favorite: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    thumbnail_artifact_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("artifact.id"), nullable=True
    )
    generation_defaults: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    source_type: Mapped[str] = mapped_column(Text, nullable=False)
    source_locator: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_revision: Mapped[str | None] = mapped_column(Text, nullable=True)
    external_id: Mapped[str | None] = mapped_column(
        String(PROJECT_ID_LENGTH), nullable=True
    )
    scene_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    shot_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    canon_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)
    last_used_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    archived_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    deleted_at: Mapped[str | None] = mapped_column(Text, nullable=True)


class ProjectScene(Base):
    """ローカルProjectが所有するScene。"""

    __tablename__ = "project_scene"
    __table_args__ = (
        CheckConstraint(
            "production_status in ('not_started','in_progress','has_candidates','accepted','completed')",
            name="ck_project_scene_production_status",
        ),
        Index("ix_project_scene_project", "project_id", "deleted_at", "sequence"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(PROJECT_ID_LENGTH), ForeignKey("project.id"), nullable=False
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    tags: Mapped[list] = mapped_column(JSON, nullable=False)
    production_status: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)
    deleted_at: Mapped[str | None] = mapped_column(Text, nullable=True)


class ProjectShot(Base):
    """ローカルSceneが所有するShot。"""

    __tablename__ = "project_shot"
    __table_args__ = (
        CheckConstraint(
            "production_status in ('not_started','in_progress','has_candidates','accepted','completed')",
            name="ck_project_shot_production_status",
        ),
        Index("ix_project_shot_scene", "scene_id", "deleted_at", "sequence"),
        Index("ix_project_shot_project", "project_id", "deleted_at"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(PROJECT_ID_LENGTH), ForeignKey("project.id"), nullable=False
    )
    scene_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("project_scene.id"), nullable=False
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    duration_sec: Mapped[float] = mapped_column(Float, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    tags: Mapped[list] = mapped_column(JSON, nullable=False)
    production_status: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)
    deleted_at: Mapped[str | None] = mapped_column(Text, nullable=True)


class Workflow(Base):
    """登録済みWorkflow。Recipeが参照する実行本体の識別単位。

    Workflow本体はリポジトリ同梱のテンプレートとAdapterの実装であり、この表はその
    登録簿にあたる。利用者入力から任意のWorkflowを実行させないため、行を足しても
    実行できるWorkflowは増えない。
    """

    __tablename__ = "workflow"
    __table_args__ = (
        CheckConstraint(
            "kind in ('image','video','voice','music','compose')",
            name="ck_workflow_kind",
        ),
        UniqueConstraint("name", name="uq_workflow_name"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    #: 同梱テンプレート名、またはAdapterのスナップショット名。
    name: Mapped[str] = mapped_column(Text, nullable=False)
    #: 生成種別。Recipeの`kind`と揃える。
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    #: このWorkflowを実行できるBackend。音声のように複数Backendが同じ形を使う。
    engines: Mapped[list] = mapped_column(JSON, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class WorkflowVersion(Base):
    """Workflowの1版。変数定義、対応モデル、入出力を保持する。

    版の内容は作成後に書き換えない。テンプレートやスナップショットの形が変われば
    新しい版を足す。Recipeは版を指し、指した版の宣言の範囲でだけ値を差し替える。
    """

    __tablename__ = "workflow_version"
    __table_args__ = (
        UniqueConstraint("workflow_id", "version", name="uq_workflow_version_version"),
        Index("ix_workflow_version_workflow_id", "workflow_id"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    workflow_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("workflow.id"), nullable=False
    )
    #: ComfyUI系はテンプレートのSHA-256、テンプレートファイルを持たないAdapterは
    #: スナップショットの版番号を文字列にしたもの。
    version: Mapped[str] = mapped_column(Text, nullable=False)
    #: 同梱テンプレートのSHA-256。テンプレートファイルを持たない版ではNULL。
    template_sha256: Mapped[str | None] = mapped_column(
        String(SHA256_LENGTH), nullable=True
    )
    #: 差し替えを許す変数。キーが変数名、値が型・必須・書き込み先。
    variables: Mapped[dict] = mapped_column(JSON, nullable=False)
    #: モデルファイル名を受け取る変数と、在庫確認に使うノード定義。
    model_slots: Mapped[list] = mapped_column(JSON, nullable=False)
    #: 素材の取り込みが要る入力。
    inputs: Mapped[list] = mapped_column(JSON, nullable=False)
    #: この版が生むArtifactの種別。
    outputs: Mapped[list] = mapped_column(JSON, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


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
    #: 参照するWorkflowの版。レジストリ導入前に作られたRecipeではNULLになる。
    workflow_version_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("workflow_version.id"), nullable=True
    )
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
        Index("ix_generation_job_assignment", "assigned_project_id", "assigned_scene_id", "assigned_shot_id"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    scene_ref: Mapped[dict] = mapped_column(JSON, nullable=False)
    shot_ref: Mapped[dict] = mapped_column(JSON, nullable=False)
    # Manifestと上の参照は生成時点の記録として固定し、整理先は別に更新する。
    assigned_project_id: Mapped[str | None] = mapped_column(
        String(PROJECT_ID_LENGTH), nullable=True
    )
    assigned_scene_id: Mapped[str | None] = mapped_column(
        String(PROJECT_ID_LENGTH), nullable=True
    )
    assigned_shot_id: Mapped[str | None] = mapped_column(
        String(PROJECT_ID_LENGTH), nullable=True
    )
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
    # 実行基盤の版はJob作成時点では確定できない。Executorが実行開始直後に1回だけ設定する。
    engine_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    model: Mapped[dict] = mapped_column(JSON, nullable=False)
    seed: Mapped[int] = mapped_column(Integer, nullable=False)
    resolved_prompt: Mapped[str] = mapped_column(Text, nullable=False)
    parameters: Mapped[dict] = mapped_column(JSON, nullable=False)
    input_refs: Mapped[list] = mapped_column(JSON, nullable=False)
    workflow_artifact_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("artifact.id"), nullable=False
    )
    # Exact Replayで作ったManifestだけが、再実行元のManifestを指す。
    replay_of_manifest_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("generation_manifest.id"), nullable=True
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
        Index("ix_artifact_assignment", "assigned_project_id", "assigned_scene_id", "assigned_shot_id"),
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
    assigned_project_id: Mapped[str | None] = mapped_column(
        String(PROJECT_ID_LENGTH), nullable=True
    )
    assigned_scene_id: Mapped[str | None] = mapped_column(
        String(PROJECT_ID_LENGTH), nullable=True
    )
    assigned_shot_id: Mapped[str | None] = mapped_column(
        String(PROJECT_ID_LENGTH), nullable=True
    )
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    decision: Mapped[str] = mapped_column(Text, nullable=False, default="undecided")
    decision_at: Mapped[str | None] = mapped_column(Text, nullable=True)


class ArtifactTag(Base):
    """Artifactへ付けた1件のタグ。

    タグはArtifactの列ではなく別表にする。1件のArtifactへ複数付き、タグ側からの
    絞り込みが主経路になるため、JSON列に持たせると検索のたびに全行を走査することに
    なる。値は付けられたまま保存し、大文字小文字や表記の違いは吸収しない。同義語の
    管理はIssue #42の対象外である。
    """

    __tablename__ = "artifact_tag"
    __table_args__ = (
        UniqueConstraint("artifact_id", "tag", name="uq_artifact_tag_artifact_id_tag"),
        Index("ix_artifact_tag_artifact_id", "artifact_id"),
        Index("ix_artifact_tag_tag", "tag"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    artifact_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("artifact.id"), nullable=False
    )
    tag: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


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


class AgentProposal(Base):
    """Agent提案の履歴。提案内容と入力コンテキストは作成後に書き換えない。

    提案の取得自体は副作用を持たない。承認と適用は`state`だけを進め、`output`と
    `request_context`を更新しない。
    """

    __tablename__ = "agent_proposal"
    __table_args__ = (
        CheckConstraint(
            "kind in ('shot_breakdown','image_prompt','reference_candidates',"
            "'recipe_draft','workflow_registration_draft','batch_generation_plan',"
            "'asset_organization_plan')",
            name="ck_agent_proposal_kind",
        ),
        CheckConstraint(
            "state in ('proposed','approved','rejected','applied','failed')",
            name="ck_agent_proposal_state",
        ),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    provider_id: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    project_id: Mapped[str] = mapped_column(Text, nullable=False)
    scene_id: Mapped[str] = mapped_column(Text, nullable=False)
    shot_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 承認後に投入するJobのRecipe。副作用のある操作を伴う提案でだけ設定する。
    recipe_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("recipe.id"), nullable=True
    )
    instruction: Mapped[str] = mapped_column(Text, nullable=False)
    # Providerへ渡した入力。許可した表示用フィールドだけで組み立てる。
    request_context: Mapped[dict] = mapped_column(JSON, nullable=False)
    # 提案本体。取得に失敗した提案はNULLのまま残す。
    output: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # 実行の実測値。費用、所要時間、往復回数だけを残す。
    usage: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    model: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 単一のJob投入を伴う提案(`image_prompt`)の互換用。複数stepの提案では書かず、
    # 適用先の正本は`agent_proposal_application`とする。
    applied_job_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("generation_job.id"), nullable=True
    )
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    decided_at: Mapped[str | None] = mapped_column(Text, nullable=True)


class AgentProposalApplication(Base):
    """提案の計画1stepごとの適用状態。

    1件の提案が複数の操作を持つため、適用先を提案の列では表せない。stepごとに行を
    作り、成功した分だけ`applied`で確定させる。一部が失敗しても成功済みのstepを
    実行し直さないための正本にあたる。

    行は承認時ではなく最初の適用要求時に作る。承認しただけでは何も実行しないという
    扱いを、記録の側でも保つためである。
    """

    __tablename__ = "agent_proposal_application"
    __table_args__ = (
        CheckConstraint(
            "state in ('pending','applying','applied','failed')",
            name="ck_agent_proposal_application_state",
        ),
        UniqueConstraint(
            "proposal_id",
            "step_index",
            name="uq_agent_proposal_application_proposal_id_step_index",
        ),
        Index("ix_agent_proposal_application_proposal_id", "proposal_id"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    proposal_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("agent_proposal.id"), nullable=False
    )
    #: 計画内での順序。承認した計画の並びと対応する。
    step_index: Mapped[int] = mapped_column(Integer, nullable=False)
    operation_type: Mapped[str] = mapped_column(Text, nullable=False)
    #: 承認時の操作内容のdigest。適用直前に組み立て直した値と突き合わせる。
    operation_digest: Mapped[str] = mapped_column(Text, nullable=False)
    target: Mapped[dict] = mapped_column(JSON, nullable=False)
    #: 適用状態。`applying`は実行中の印で、同じstepを2つの要求が同時に実行しない
    #: ための占有に使う。プロセスが落ちた場合は起動時に`failed`へ倒す。
    state: Mapped[str] = mapped_column(Text, nullable=False)
    #: 適用先の種別。`generation_job`/`recipe`/`artifact_tag`/`artifact_file`の
    #: いずれか。
    applied_ref_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    applied_ref_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 適用先のIDだけでは辿れない実行結果。`file.move`は移動元と移動先を残す。
    #: 他の操作種別はNULLのままとする。
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    failure_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class VoiceVerification(Base):
    """音声Artifactの読み検証の結果。Shot内の台詞ごとに1件記録する。

    ArtifactへJSONとして書くのではなく表にするのは、台詞単位での一覧表示と不一致の
    絞り込みをAPIで返すためである。記録は追記のみとし、後から書き換えない。

    `status`と`target_duration_sec`はIssue #11の項目表に無いが、画面が「一致しなかった」
    と「そもそも検証していない」を区別し、尺の超過を判定するために必要なため加えた。
    """

    __tablename__ = "voice_verification"
    __table_args__ = (
        CheckConstraint(
            "status in ('verified','skipped','asr_failed','kana_unavailable')",
            name="ck_voice_verification_status",
        ),
        Index("ix_voice_verification_job_id", "job_id"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    job_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("generation_job.id"), nullable=False
    )
    artifact_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("artifact.id"), nullable=False
    )
    #: Shot内での台詞の位置。
    dialogue_index: Mapped[int] = mapped_column(Integer, nullable=False)
    expected_text: Mapped[str] = mapped_column(Text, nullable=False)
    #: Shotが読みを指定していない台詞ではNULLになる。
    expected_reading: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: ASRを実行しなかった、または失敗した場合はNULLになる。
    asr_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    normalized_expected: Mapped[str | None] = mapped_column(Text, nullable=True)
    normalized_asr: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 正規化後の完全一致可否。検証していない場合はNULLになる。
    match: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    #: 不一致時の差分率。0.0で完全一致、1.0で共通部分なし。
    diff_ratio: Mapped[float | None] = mapped_column(Float, nullable=True)
    #: 生成された音声の尺。
    audio_sec: Mapped[float] = mapped_column(Float, nullable=False)
    #: パディング後の尺。超過時はパディングしないため`audio_sec`と同じ値になる。
    padded_sec: Mapped[float] = mapped_column(Float, nullable=False)
    #: Shotが求める尺。超過の判定に使う。
    target_duration_sec: Mapped[float] = mapped_column(Float, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
