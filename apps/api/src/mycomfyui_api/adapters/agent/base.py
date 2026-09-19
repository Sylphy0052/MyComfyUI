"""提案Providerの共通入出力。

Providerは提案を返すだけで、生成Job、ファイル、Git、外部送信のいずれにも触れない。
副作用のある操作は`approvals`の許可リストと承認を通したApplication API側だけが行う。

Provider実装は`ReferenceSource`と同じく、Protocolと差し替え可能な実装で表す。
"""

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

#: 提案の種別。`image_prompt`だけが承認後の生成Job投入へつながる。
AgentProposalKind = Literal[
    "shot_breakdown",
    "image_prompt",
    "reference_candidates",
    "recipe_draft",
]

AGENT_PROPOSAL_KINDS: tuple[AgentProposalKind, ...] = (
    "shot_breakdown",
    "image_prompt",
    "reference_candidates",
    "recipe_draft",
)


class AgentError(Exception):
    """提案Adapterが返す例外の基底。"""


class AgentUnavailable(AgentError):
    """Providerを起動できない、応答しない、または実行が失敗した。

    生成Jobと履歴管理はこの例外を受けても停止しない。提案の取得だけが失敗する。
    """


class AgentInvalidResponse(AgentError):
    """応答を期待する形として解釈できなかった。"""


@dataclass(frozen=True)
class ProposalRequest:
    """Providerへ渡す提案要求。

    `context`は参照APIの表示用フィールドだけを許可リストで組み立てた値とする。秘密情報、
    環境変数、ローカル絶対パスを入れない。
    """

    kind: AgentProposalKind
    instruction: str
    context: dict[str, Any] = field(default_factory=dict)


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

    async def available(self) -> bool: ...

    async def propose(self, request: ProposalRequest) -> ProposalResult: ...

    async def aclose(self) -> None: ...
