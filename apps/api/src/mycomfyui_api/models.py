from typing import Any

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
    text,
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
        CheckConstraint(
            "sync_state in ('never','synced','outdated','conflicted','failed')",
            name="ck_project_sync_state",
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
    local_overrides: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    source_type: Mapped[str] = mapped_column(Text, nullable=False)
    source_locator: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_revision: Mapped[str | None] = mapped_column(Text, nullable=True)
    external_id: Mapped[str | None] = mapped_column(
        String(PROJECT_ID_LENGTH), nullable=True
    )
    source_snapshot: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    source_snapshot_sha256: Mapped[str | None] = mapped_column(
        String(SHA256_LENGTH), nullable=True
    )
    sync_state: Mapped[str] = mapped_column(Text, nullable=False, default="never")
    auto_sync: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_synced_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    sync_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    scene_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    shot_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    canon_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)
    last_used_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    archived_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    deleted_at: Mapped[str | None] = mapped_column(Text, nullable=True)


class ProjectTemplate(Base):
    """Project作成時に再利用する設定テンプレート。"""

    __tablename__ = "project_template"
    __table_args__ = (UniqueConstraint("name", name="uq_project_template_name"),)

    id: Mapped[str] = _uuid_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text(collation="NOCASE"), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    settings: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


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
    todo: Mapped[str | None] = mapped_column(Text, nullable=True)
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
    todo: Mapped[str | None] = mapped_column(Text, nullable=True)
    due_date: Mapped[str | None] = mapped_column(Text, nullable=True)
    priority: Mapped[str | None] = mapped_column(Text, nullable=True)
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
    #: 利用者が編集したnode/edgeグラフ本体。同梱テンプレート由来の版はNULLのまま。
    #: `graph_validation.validate_graph`を通過した内容だけを保存する。
    graph: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    #: `graph`のSHA-256。immutableな版の識別に使う。テンプレート由来の版は
    #: `template_sha256`を使うためNULLのまま。
    graph_sha256: Mapped[str | None] = mapped_column(
        String(SHA256_LENGTH), nullable=True
    )
    #: 差分表示の基準にした旧版。新規登録(既存版を編集元に持たない)ではNULL。
    based_on_version_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("workflow_version.id"), nullable=True
    )
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


class LookProfile(Base):
    """生成入力へ順序付きで重ねる、名前付きの再利用設定。"""

    __tablename__ = "look_profile"
    __table_args__ = (
        CheckConstraint(
            "kind in ('image','video','voice','music','compose')",
            name="ck_look_profile_kind",
        ),
        CheckConstraint(
            "category in ('general','style','character','background')",
            name="ck_look_profile_category",
        ),
        UniqueConstraint("kind", "name", name="uq_look_profile_kind_name"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    recipe_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("recipe.id"), nullable=True
    )
    inputs: Mapped[dict] = mapped_column(JSON, nullable=False)
    #: モードBで使用者に選ばせる入力名。値は持たず、`inputs`とは重ねない。
    #: `inputs`にもここにも無い入力は、キャラクター・場面・Recipe既定値から埋まる。
    production_choice_inputs: Mapped[list] = mapped_column(
        JSON, nullable=False, default=list
    )
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


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
    # WebUI v2のキャラクター・衣装・シーン (#530)。旧UIの`assigned_*`とは別に持つ。
    # 設計文書とIssueの`outfit_id`は、命名を#529の`story_costume`に揃えて`story_costume_id`とする。
    # 参照先を消すとNULLへ戻り、生成物は消えない。
    story_character_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH),
        ForeignKey("story_character.id", ondelete="SET NULL", name="fk_generation_job_story_character"),
        nullable=True,
    )
    story_costume_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH),
        ForeignKey("story_costume.id", ondelete="SET NULL", name="fk_generation_job_story_costume"),
        nullable=True,
    )
    story_scene_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH),
        ForeignKey("story_scene.id", ondelete="SET NULL", name="fk_generation_job_story_scene"),
        nullable=True,
    )
    # 台詞1行の音声Jobが、どの台詞の行かを記録する (#573)。参照先を消すとNULLへ戻る。
    story_dialogue_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH),
        ForeignKey("story_scene_dialogue.id", ondelete="SET NULL", name="fk_generation_job_story_dialogue"),
        nullable=True,
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


class GenerationBatch(Base):
    """複数Scene・Shotへ同じ生成設定を展開した計画。"""

    __tablename__ = "generation_batch"
    __table_args__ = (Index("ix_generation_batch_project", "project_id", "created_at"),)

    id: Mapped[str] = _uuid_column(primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(PROJECT_ID_LENGTH), ForeignKey("project.id"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    request: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class GenerationBatchItem(Base):
    """一括生成の対象と、現在その対象を担うJobの対応。"""

    __tablename__ = "generation_batch_item"
    __table_args__ = (
        Index("ix_generation_batch_item_batch", "batch_id", "created_at"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    batch_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("generation_batch.id"), nullable=False
    )
    scene_id: Mapped[str] = mapped_column(String(PROJECT_ID_LENGTH), nullable=False)
    shot_id: Mapped[str | None] = mapped_column(String(PROJECT_ID_LENGTH), nullable=True)
    job_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("generation_job.id"), nullable=True
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False)
    planning_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class GenerationExperiment(Base):
    """同一Scene・Shotで入力軸を展開する探索実験。WebUI v2ではProject無しも持つ。"""

    __tablename__ = "generation_experiment"
    __table_args__ = (
        Index("ix_generation_experiment_project", "project_id", "created_at"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    project_id: Mapped[str | None] = mapped_column(
        String(PROJECT_ID_LENGTH), ForeignKey("project.id"), nullable=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    request: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class GenerationExperimentItem(Base):
    """探索variantと、その現在のJob。"""

    __tablename__ = "generation_experiment_item"
    __table_args__ = (
        UniqueConstraint(
            "experiment_id", "ordinal", name="uq_generation_experiment_item_ordinal"
        ),
        Index("ix_generation_experiment_item_experiment", "experiment_id", "ordinal"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    experiment_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("generation_experiment.id"), nullable=False
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    variables: Mapped[dict] = mapped_column(JSON, nullable=False)
    inputs: Mapped[dict] = mapped_column(JSON, nullable=False)
    job_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("generation_job.id"), nullable=True
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False)
    planning_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


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
    """GenerationJob、外部取込、可搬packageに由来する保存ファイル参照。"""

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
        Index("ix_artifact_story_character", "story_character_id"),
        Index("ix_artifact_story_costume", "story_costume_id"),
        Index("ix_artifact_story_scene", "story_scene_id"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    job_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("generation_job.id"), nullable=True
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
    # WebUI v2のキャラクター・衣装・シーン (#530)。旧UIの`assigned_*`とは別に持つ。
    # 設計文書とIssueの`outfit_id`は、命名を#529の`story_costume`に揃えて`story_costume_id`とする。
    # 参照先を消すとNULLへ戻り、生成物は消えない。
    story_character_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH),
        ForeignKey("story_character.id", ondelete="SET NULL", name="fk_artifact_story_character"),
        nullable=True,
    )
    story_costume_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH),
        ForeignKey("story_costume.id", ondelete="SET NULL", name="fk_artifact_story_costume"),
        nullable=True,
    )
    story_scene_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH),
        ForeignKey("story_scene.id", ondelete="SET NULL", name="fk_artifact_story_scene"),
        nullable=True,
    )
    # 生成物ごとのメモ。衣装の画面とViewerのどちらからでも同じものを読み書きする。
    memo: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    decision: Mapped[str] = mapped_column(Text, nullable=False, default="undecided")
    decision_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    deleted_at: Mapped[str | None] = mapped_column(Text, nullable=True)


class ArtifactImport(Base):
    """外部画像Artifactの取込元と、非実行のRecipe下書き。"""

    __tablename__ = "artifact_import"

    artifact_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("artifact.id"), primary_key=True
    )
    original_file_name: Mapped[str] = mapped_column(Text, nullable=False)
    source_format: Mapped[str] = mapped_column(Text, nullable=False)
    raw_metadata: Mapped[dict] = mapped_column(JSON, nullable=False)
    recipe_draft: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class ImageImportPreview(Base):
    """confirmをpreview済みの同一画像へ限定する短寿命token。"""

    __tablename__ = "image_import_preview"

    id: Mapped[str] = _uuid_column(primary_key=True)
    sha256: Mapped[str] = mapped_column(String(SHA256_LENGTH), nullable=False)
    file_name: Mapped[str] = mapped_column(Text, nullable=False)
    media_type: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[str] = mapped_column(Text, nullable=False)
    consumed_at: Mapped[str | None] = mapped_column(Text, nullable=True)


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


class MediaRoleTag(Base):
    """画像取込物へ後付けする役割・キャラクター/シーンの紐付け。

    生成物・外部取込・登録素材(Artifact由来)は`artifact_id`で結び付ける。入力cache
    (`/image-references`が書く`inputs/`配下のファイル)はDB上に対応する行を持たない
    ため、`relative_path`(+`sha256`)で直接特定する。どちらか一方だけを持つ。
    入力cache側は他にDB上の記録が無いため、この行が横断一覧に載せる唯一のカタログ
    行になる。そのため`file_name`・`byte_size`・`media_type`もここへ保持する
    (artifact_id指定時はArtifact側に同じ情報があるため常にNULLのままでよい)。
    1件の対象につき役割は1つ、キャラクターは複数へ関連付けられるため`character_ids`
    はリストで持つ(JSON列。絞り込みはSQLiteの`json_each`で要素を展開して行う)。
    """

    __tablename__ = "media_role_tag"
    __table_args__ = (
        CheckConstraint(
            "role in ('appearance_reference','pose','background','costume',"
            "'voice_reference','guide_audio','other')",
            name="ck_media_role_tag_role",
        ),
        CheckConstraint(
            "(artifact_id IS NOT NULL) != (relative_path IS NOT NULL)",
            name="ck_media_role_tag_target_xor",
        ),
        UniqueConstraint("artifact_id", name="uq_media_role_tag_artifact_id"),
        UniqueConstraint("relative_path", name="uq_media_role_tag_relative_path"),
        Index(
            "ix_media_role_tag_assignment", "assigned_project_id", "assigned_scene_id"
        ),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    artifact_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("artifact.id"), nullable=True
    )
    relative_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    sha256: Mapped[str | None] = mapped_column(String(SHA256_LENGTH), nullable=True)
    file_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    byte_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    media_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    character_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    #: 声質参照(`voice_reference`)の書き起こし。音声タブで選ぶと参照テキストへ入る。
    reference_transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    assigned_project_id: Mapped[str | None] = mapped_column(
        String(PROJECT_ID_LENGTH), nullable=True
    )
    assigned_scene_id: Mapped[str | None] = mapped_column(
        String(PROJECT_ID_LENGTH), nullable=True
    )
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


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
    #: Shotが求める尺。超過の判定に使う。Shot無しのJobは目標尺が無くNULL。
    target_duration_sec: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class AppSetting(Base):
    """Web UIから変更した設定の保存値 (#337)。

    keyは`Settings`の属性名とする。行が無い項目は環境変数の値を使う。
    """

    __tablename__ = "app_setting"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class StoryCharacter(Base):
    """WebUI v2のキャラクター。旧Projectの`characters`設定とは別に持つ。

    画像・音声の参照は`MediaItemRead.key`と同じ書式の文字列 (`artifact:<id>`または
    `input:<relative_path>`) で持つ。Artifactを持たない入力cacheの素材も指すため、
    FKにはしない。
    """

    __tablename__ = "story_character"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_story_character_name"),
        Index("ix_story_character_project", "project_id", "created_at"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(PROJECT_ID_LENGTH), ForeignKey("project.id"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text(collation="NOCASE"), nullable=False)
    fixed_tags: Mapped[list] = mapped_column(JSON, nullable=False)
    negative_tags: Mapped[list] = mapped_column(JSON, nullable=False)
    profile: Mapped[str] = mapped_column(Text, nullable=False, default="")
    portrait_media_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    voice_media_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    voice_transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class StoryCostume(Base):
    """キャラクターの衣装。参照画像は`StoryCostumeImage`に並び順つきで持つ。"""

    __tablename__ = "story_costume"
    __table_args__ = (
        UniqueConstraint("character_id", "name", name="uq_story_costume_name"),
        Index("ix_story_costume_character", "character_id", "created_at"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    character_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("story_character.id"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text(collation="NOCASE"), nullable=False)
    tags: Mapped[list] = mapped_column(JSON, nullable=False)
    negative_tags: Mapped[list] = mapped_column(JSON, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class StoryCostumeImage(Base):
    """衣装の参照画像。`position`が0の行を代表画像とする。"""

    __tablename__ = "story_costume_image"
    __table_args__ = (
        UniqueConstraint("costume_id", "position", name="uq_story_costume_image_position"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    costume_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("story_costume.id"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    media_key: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class StoryScene(Base):
    """WebUI v2のシーン。Shotは持たず1階層とする。`parent_scene_id`は欄だけで常にNULL。"""

    __tablename__ = "story_scene"
    __table_args__ = (
        CheckConstraint(
            "time_of_day IS NULL OR time_of_day in ('morning','day','sunset','night')",
            name="ck_story_scene_time_of_day",
        ),
        Index("ix_story_scene_project", "project_id", "sequence"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(PROJECT_ID_LENGTH), ForeignKey("project.id"), nullable=False
    )
    parent_scene_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("story_scene.id"), nullable=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False, default="")
    background_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    background_tags: Mapped[list] = mapped_column(JSON, nullable=False)
    # 値はそのまま補完タグになる (morning / day / sunset / night)。
    time_of_day: Mapped[str | None] = mapped_column(Text, nullable=True)
    bgm_mood: Mapped[str] = mapped_column(Text, nullable=False, default="")
    video_motion: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class StorySceneCast(Base):
    """シーンの登場キャラ。衣装は同じキャラクターのものに限る (API側で検証する)。"""

    __tablename__ = "story_scene_cast"
    __table_args__ = (
        UniqueConstraint("scene_id", "character_id", name="uq_story_scene_cast_character"),
        UniqueConstraint("scene_id", "position", name="uq_story_scene_cast_position"),
        Index("ix_story_scene_cast_character", "character_id"),
        Index("ix_story_scene_cast_costume", "costume_id"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    scene_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("story_scene.id"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    character_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("story_character.id"), nullable=False
    )
    costume_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("story_costume.id"), nullable=True
    )
    pose_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    pose_tags: Mapped[list] = mapped_column(JSON, nullable=False)
    expression_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    expression_tags: Mapped[list] = mapped_column(JSON, nullable=False)


class StorySceneDialogue(Base):
    """シーンの台詞1行。"""

    __tablename__ = "story_scene_dialogue"
    __table_args__ = (
        UniqueConstraint("scene_id", "position", name="uq_story_scene_dialogue_position"),
        Index("ix_story_scene_dialogue_speaker", "speaker_character_id"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    scene_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("story_scene.id"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    speaker_character_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("story_character.id"), nullable=False
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)
    direction: Mapped[str] = mapped_column(Text, nullable=False, default="")


class StorySceneAdoption(Base):
    """シーン×枠ごとに1件の採用 (#530)。

    枠は`scene_image` / `voice` / `bgm` / `video` / `compose`。`voice`だけは台詞1行
    (`story_scene_dialogue`) ごとに別の枠になり、`dialogue_id`を持つ。同じ枠への採用は
    `artifact_id`の置き換えで表す。
    """

    __tablename__ = "story_scene_adoption"
    __table_args__ = (
        CheckConstraint(
            "slot in ('scene_image','voice','bgm','video','compose')",
            name="ck_story_scene_adoption_slot",
        ),
        CheckConstraint(
            "(slot = 'voice') = (dialogue_id IS NOT NULL)",
            name="ck_story_scene_adoption_dialogue",
        ),
        Index(
            "ux_story_scene_adoption_slot",
            "scene_id",
            "slot",
            unique=True,
            sqlite_where=text("dialogue_id IS NULL"),
        ),
        Index(
            "ux_story_scene_adoption_dialogue",
            "dialogue_id",
            unique=True,
            sqlite_where=text("dialogue_id IS NOT NULL"),
        ),
        Index("ix_story_scene_adoption_artifact", "artifact_id"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    scene_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH),
        ForeignKey("story_scene.id", ondelete="CASCADE"),
        nullable=False,
    )
    slot: Mapped[str] = mapped_column(Text, nullable=False)
    dialogue_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH),
        ForeignKey("story_scene_dialogue.id", ondelete="CASCADE"),
        nullable=True,
    )
    artifact_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH),
        ForeignKey("artifact.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class GenerationJobFollowup(Base):
    """親Jobが終端になったあとに自動で投入する後続Jobの予約 (#581)。

    `payload`は後続Jobの`GenerationJobCreate`相当で、`parent_job_id`と親の生成物を指す
    入力は含めない。親が終端になった時点でworkerが組み立てて投入する。
    """

    __tablename__ = "generation_job_followup"
    __table_args__ = (
        CheckConstraint(
            "state in ('pending','submitted','skipped','failed')",
            name="ck_generation_job_followup_state",
        ),
        Index("ix_generation_job_followup_parent", "parent_job_id"),
        Index("ix_generation_job_followup_state", "state"),
    )

    id: Mapped[str] = _uuid_column(primary_key=True)
    parent_job_id: Mapped[str] = mapped_column(
        String(UUID_LENGTH), ForeignKey("generation_job.id"), nullable=False
    )
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    child_job_id: Mapped[str | None] = mapped_column(
        String(UUID_LENGTH), ForeignKey("generation_job.id"), nullable=True
    )
    failure_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)
