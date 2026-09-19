"""提案Adapter。設定に応じてProviderを1つ選ぶ。

Providerは提案を返すだけで、副作用のある操作は行わない。承認と実行はApplication API側
の`approvals`と各Endpointが担う。
"""

from mycomfyui_api.adapters.agent.base import AgentProvider
from mycomfyui_api.adapters.agent.claude_code import ClaudeCodeProvider
from mycomfyui_api.adapters.agent.stub import StubAgentProvider
from mycomfyui_api.settings import Settings, get_settings


def create_agent_provider(settings: Settings | None = None) -> AgentProvider:
    """設定で指定されたProviderを作る。

    CLIが無い環境でも起動を止めない。`available()`がFalseを返すだけで、提案取得を
    要求したときに初めて失敗する。
    """
    settings = settings or get_settings()
    if settings.agent_provider == "stub":
        return StubAgentProvider(settings)
    return ClaudeCodeProvider(settings)


__all__ = [
    "AgentProvider",
    "ClaudeCodeProvider",
    "StubAgentProvider",
    "create_agent_provider",
]
