"""提案Providerの共通入出力。

Providerは提案を返すだけで、生成Job、ファイル、Git、外部送信のいずれにも触れない。
副作用のある操作は`approvals`の許可リストと承認を通したApplication API側だけが行う。

Provider実装は`ReferenceSource`と同じく、Protocolと差し替え可能な実装で表す。
"""

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

#: 提案の種別。提案段階の4種と、承認後に適用できる準備段階の3種を持つ。
#:
#: 副作用のある操作へつながるのは`image_prompt`と準備段階の3種だけで、残りは表示に
#: とどまる。準備段階の適用先はRecipe登録、生成Jobの一括投入、Artifactタグの更新とし、
#: 実行できるWorkflowテンプレートは増やさない。
AgentProposalKind = Literal[
    "shot_breakdown",
    "image_prompt",
    "reference_candidates",
    "recipe_draft",
    "workflow_registration_draft",
    "batch_generation_plan",
    "asset_organization_plan",
]

AGENT_PROPOSAL_KINDS: tuple[AgentProposalKind, ...] = (
    "shot_breakdown",
    "image_prompt",
    "reference_candidates",
    "recipe_draft",
    "workflow_registration_draft",
    "batch_generation_plan",
    "asset_organization_plan",
)


class AgentError(Exception):
    """提案Adapterが返す例外の基底。"""


class AgentUnavailable(AgentError):
    """Providerを起動できない、応答しない、または実行が失敗した。

    生成Jobと履歴管理はこの例外を受けても停止しない。提案の取得だけが失敗する。
    """


class AgentInvalidResponse(AgentError):
    """応答を期待する形として解釈できなかった。"""


#: Providerへ添付できる画像の形式。Claude、Codex、OpenAI互換APIのいずれも受け付ける
#: 形式だけに絞る。
PROPOSAL_IMAGE_MEDIA_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp")


@dataclass(frozen=True)
class ProposalImage:
    """Providerへ添付する画像。検証済みの本体と形式だけを持ち、元のパスは持たない。"""

    data: bytes
    media_type: str


@dataclass(frozen=True)
class ProposalRequest:
    """Providerへ渡す提案要求。

    `context`は参照APIの表示用フィールドだけを許可リストで組み立てた値とする。秘密情報、
    環境変数、ローカル絶対パスを入れない。`images`は`supports_images`が真のProviderへ
    だけ渡す。
    """

    kind: AgentProposalKind
    instruction: str
    context: dict[str, Any] = field(default_factory=dict)
    images: tuple[ProposalImage, ...] = ()


@dataclass(frozen=True)
class ProposalResult:
    """Providerが返した提案。

    `usage`は費用と所要時間などの実測値だけを持つ。認証情報、接続先、生の標準出力を
    含めない。
    """

    output: dict[str, Any]
    model: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class AgentProvider(Protocol):
    """提案取得だけを提供するProvider。更新系のメソッドは持たない。"""

    @property
    def id(self) -> str: ...

    @property
    def label(self) -> str: ...

    @property
    def supports_images(self) -> bool:
        """`ProposalRequest.images`を添付して問い合わせられるか。"""
        ...

    async def available(self) -> bool: ...

    async def propose(self, request: ProposalRequest) -> ProposalResult: ...

    async def aclose(self) -> None: ...
