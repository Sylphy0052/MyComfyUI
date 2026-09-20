"""Jobを作るときに、engineごとの準備結果を受け渡すための共通型。

`routers`はengineの種類を知らずにJobとManifestを組み立てる。実行スナップショットの
中身(ComfyUIならWorkflow JSON、音声ならvoice-runnerへのリクエスト)は各Adapterが
決め、ここでは形だけを揃える。
"""

from dataclasses import dataclass, field
from typing import Any, Protocol

from mycomfyui_api.models import Recipe


class PreparationError(ValueError):
    """Recipeと入力から実行内容を組み立てられない。

    `details`は利用者へ返すEnvelopeの`details`へそのまま載せる。秘密情報と
    ローカル絶対パスを入れない。
    """

    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details


@dataclass(frozen=True)
class PreparationContext:
    """準備に渡す、参照APIから解決済みの入力。

    `scene_data`と`shot_data`は参照APIの応答本文そのものとする。音声Jobは台詞を
    Manifestとスナップショットへ固定する必要があり、IDだけでは組み立てられない。
    """

    project_id: str
    scene_id: str
    shot_id: str
    scene_data: dict[str, Any]
    shot_data: dict[str, Any]
    #: Canon descriptorを引くための参照元。準備中の読取りだけに使う。
    canon_lookup: Any = None
    #: 既存Artifactを引くための参照元。合成Jobと、生成済み画像を入力にする動画Jobが
    #: 使う。準備中の読取りだけに使い、更新はしない。
    artifact_lookup: Any = None


@dataclass(frozen=True)
class PreparedExecution:
    """実行スナップショットと、Manifestへ残す解決済みの値。"""

    snapshot: dict[str, Any]
    seed: int
    resolved_prompt: str
    model: dict[str, Any]
    parameters: dict[str, Any]
    #: 準備の過程で判った入力参照。呼び出し元の`input_refs`と併せてManifestへ残す。
    input_refs: list[dict[str, Any]] = field(default_factory=list)
    #: 入力から決まる親Job。合成Jobが入力の動画Jobを親に持つために使う。要求が
    #: `parent_job_id`を指定していないときだけ採用する。
    parent_job_id: str | None = None


class ArtifactLookup(Protocol):
    """既存Artifactの読取り。準備処理がDBセッションを直接持たないようにする。"""

    async def get(self, artifact_id: str) -> Any | None: ...


class EnginePreparer(Protocol):
    """Recipeと入力から実行スナップショットを組み立てる。"""

    async def __call__(
        self,
        recipe: Recipe,
        inputs: dict[str, Any],
        context: PreparationContext,
    ) -> PreparedExecution: ...
