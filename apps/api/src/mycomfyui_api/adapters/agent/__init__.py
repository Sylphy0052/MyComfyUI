"""提案Adapter。設定済みProviderをまとめて用意する。

Providerは提案を返すだけで、副作用のある操作は行わない。承認と実行はApplication API側
の`approvals`と各Endpointが担う。
"""

from mycomfyui_api.adapters.agent.base import AgentProvider
from mycomfyui_api.adapters.agent.claude_code import ClaudeCodeProvider
from mycomfyui_api.adapters.agent.codex import CodexProvider
from mycomfyui_api.adapters.agent.qwen import QwenProvider
from mycomfyui_api.adapters.agent.stub import StubAgentProvider
from mycomfyui_api.settings import Settings, get_settings


def create_agent_providers(
    settings: Settings | None = None,
) -> dict[str, AgentProvider]:
    """利用しうる全Providerを作る。

    CLIが無い環境でも、Qwenの推論サーバーが起きていない環境でも起動を止めない。
    `available()`がFalseを返すだけで、提案取得を要求したときに初めて失敗する。`stub`は
    常に用意し、CLIを入れていない環境でも提案から承認までの経路を確かめられるように
    する。
    """
    settings = settings or get_settings()
    providers: dict[str, AgentProvider] = {
        "claude_code": ClaudeCodeProvider(settings),
        "codex": CodexProvider(settings),
        "qwen": QwenProvider(settings),
        "stub": StubAgentProvider(settings),
    }
    return providers


__all__ = [
    "AgentProvider",
    "ClaudeCodeProvider",
    "CodexProvider",
    "QwenProvider",
    "StubAgentProvider",
    "create_agent_providers",
]
