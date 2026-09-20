"""同梱fixtureを返す提案Provider。

CLIを入れていない環境でも提案から承認までの経路を確かめられるようにする。設定で常に
失敗させられるため、Provider障害が生成Jobと履歴管理を止めないことの確認にも使う。
"""

import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

from mycomfyui_api.adapters.agent import proposals
from mycomfyui_api.adapters.agent.base import (
    AgentInvalidResponse,
    AgentUnavailable,
    ProposalRequest,
    ProposalResult,
)
from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

PROVIDER_ID = "stub"
PROVIDER_LABEL = "同梱fixture (stub)"

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "proposals.json"


@lru_cache
def _load_fixture() -> dict[str, Any]:
    """同梱fixtureを読む。読めないときもAdapterの例外へ揃える。

    fixtureの欠落や壊れたJSONをそのまま投げると、提案取得の失敗として扱われず、
    失敗した提案が履歴へ残らない。
    """
    try:
        document = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AgentUnavailable("提案fixtureを読み込めません。") from error
    if not isinstance(document, dict):
        raise AgentInvalidResponse("提案fixtureがJSON objectではありません。")
    return document


class StubAgentProvider:
    """fixtureの固定提案を返す。外部へ一切送信しない。"""

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()

    @property
    def id(self) -> str:
        return PROVIDER_ID

    @property
    def label(self) -> str:
        return PROVIDER_LABEL

    async def available(self) -> bool:
        return not self._settings.agent_stub_failure

    async def aclose(self) -> None:
        """保持する接続は無い。Protocolを満たすために用意する。"""

    async def propose(self, request: ProposalRequest) -> ProposalResult:
        if self._settings.agent_stub_failure:
            # 障害試験用。提案取得だけが失敗し、生成と履歴の経路は動作を続ける。
            raise AgentUnavailable("stub Providerは失敗するよう設定されています。")
        document = _load_fixture()
        payload = document.get(request.kind)
        if payload is None:
            raise AgentUnavailable(f"fixtureに{request.kind}の提案がありません。")
        output = proposals.validate_output(
            request.kind, _bind_context_ids(request, payload)
        )
        return ProposalResult(output=output, model=None, usage={})


def _bind_context_ids(request: ProposalRequest, payload: Any) -> Any:
    """準備段階の計画fixtureへ、入力コンテキストに載っているIDを割り当てる。

    適用先を持つ計画は、対象IDが入力の範囲外だとstepごと落ちる。fixtureは固定の
    ID列を持てないため、渡された一覧の先頭から順に割り当て、CLIを入れていない環境
    でも承認から適用までを通せるようにする。一覧より多いstepは落とす。
    """
    sources = {
        "batch_generation_plan": ("shots", "id", "shot_id"),
        "asset_organization_plan": ("artifacts", "artifact_id", "artifact_id"),
    }
    binding = sources.get(request.kind)
    if binding is None or not isinstance(payload, dict):
        return payload
    context_key, source_key, target_key = binding
    entries = request.context.get(context_key)
    items = payload.get("items")
    if not isinstance(entries, list) or not isinstance(items, list):
        return payload
    available = [
        entry[source_key]
        for entry in entries
        if isinstance(entry, dict) and entry.get(source_key)
    ]
    bound = [
        {**item, target_key: value}
        for item, value in zip(items, available, strict=False)
        if isinstance(item, dict)
    ]
    return {**payload, "items": bound}
