"""Claude Code CLIをsubprocessで呼ぶ提案Provider。

APIキーをMyComfyUI側へ持たず、CLIの既存認証をそのまま使う。設定にもDBにも認証情報を
置かないため、秘密情報を履歴やログへ残す経路を作らない。

提案以外の副作用を持たせないため、次の条件で起動する。

- 本文は引数ではなく標準入力へ渡す。外部由来のテキストをコマンド行へ載せない。
- `--tools ""`でCLIの全ツールを無効化し、`--safe-mode`で利用者設定、CLAUDE.md、hook、
  MCP、skillを読み込ませない。
- cwdは提案ごとに作る空ディレクトリとする。リポジトリも`data_root`の他の領域も見せない。
- 環境変数は`PATH`と`HOME`だけを渡す。`HOME`はCLIの既存認証に必要なため残す。
"""

import asyncio
import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any
from uuid import uuid4

from mycomfyui_api.adapters.agent import proposals
from mycomfyui_api.adapters.agent.base import (
    AgentInvalidResponse,
    AgentUnavailable,
    ProposalRequest,
    ProposalResult,
)
from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

PROVIDER_ID = "claude_code"
PROVIDER_LABEL = "Claude Code CLI"

#: 応答から履歴へ残す実測値。認証情報も接続先も含まない項目だけを並べる。
USAGE_KEYS = ("total_cost_usd", "duration_ms", "num_turns")


class ClaudeCodeProvider:
    """Claude Code CLIを1回呼び出して提案を1件返す。"""

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()

    @property
    def id(self) -> str:
        return PROVIDER_ID

    @property
    def label(self) -> str:
        return PROVIDER_LABEL

    async def available(self) -> bool:
        """CLIを実行できるかだけを返す。認証状態はここでは確かめない。"""
        return self._executable() is not None

    async def aclose(self) -> None:
        """保持する接続は無い。Protocolを満たすために用意する。"""

    def _executable(self) -> str | None:
        configured = self._settings.agent_cli_path
        if os.sep in configured or (os.altsep and os.altsep in configured):
            path = Path(configured)
            return str(path) if os.access(path, os.X_OK) else None
        return shutil.which(configured)

    def _argv(self, executable: str, kind: str) -> list[str]:
        schema = proposals.json_schema(kind)  # type: ignore[arg-type]
        return [
            executable,
            "-p",
            "--output-format",
            "json",
            "--json-schema",
            json.dumps(schema, ensure_ascii=False),
            # 提案だけを返させる。ツールを持たせない。
            "--tools",
            "",
            # 利用者設定、CLAUDE.md、hook、MCP、skillを読ませない。
            "--safe-mode",
            # 許可を尋ねる操作はすべて拒否する。対話は発生しない。
            "--permission-prompts",
            "none",
            "--no-session-persistence",
            "--model",
            self._settings.agent_model,
            "--max-budget-usd",
            str(self._settings.agent_max_budget_usd),
            "--system-prompt",
            proposals.SYSTEM_PROMPT,
        ]

    def _environment(self) -> dict[str, str]:
        """CLIへ渡す環境変数。既存の環境をそのまま引き渡さない。"""
        environment = {"PATH": os.environ.get("PATH", "")}
        home = os.environ.get("HOME")
        if home:
            environment["HOME"] = home
        return environment

    async def propose(self, request: ProposalRequest) -> ProposalResult:
        executable = self._executable()
        if executable is None:
            raise AgentUnavailable(
                f"Claude Code CLIを実行できません: {self._settings.agent_cli_path}"
            )
        workspace = self._settings.agent_workspace_root / str(uuid4())
        try:
            workspace.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise AgentUnavailable("提案用の作業ディレクトリを作れません。") from error
        try:
            payload = await self._run(executable, request, workspace)
        finally:
            shutil.rmtree(workspace, ignore_errors=True)
        return self._result(request, payload)

    async def _run(
        self, executable: str, request: ProposalRequest, workspace: Path
    ) -> dict[str, Any]:
        argv = self._argv(executable, request.kind)
        prompt = proposals.build_prompt(request).encode("utf-8")
        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=workspace,
                env=self._environment(),
            )
        except OSError as error:
            raise AgentUnavailable("提案Providerを起動できません。") from error
        try:
            stdout, _ = await asyncio.wait_for(
                process.communicate(prompt),
                timeout=self._settings.agent_timeout_seconds,
            )
        except TimeoutError as error:
            process.kill()
            await process.wait()
            raise AgentUnavailable(
                f"提案の取得が{self._settings.agent_timeout_seconds}秒で"
                "終わりませんでした。"
            ) from error
        if process.returncode != 0:
            # 標準エラーの本文は残さない。秘密情報が混ざりうるため、判定に使う値だけ
            # ログへ出す。
            logger.warning(
                "提案Providerが異常終了しました。provider=%s returncode=%s",
                PROVIDER_ID,
                process.returncode,
            )
            raise AgentUnavailable("提案Providerが異常終了しました。")
        try:
            payload = json.loads(stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise AgentInvalidResponse(
                "提案Providerの応答を解釈できません。"
            ) from error
        if not isinstance(payload, dict):
            raise AgentInvalidResponse(
                "提案Providerの応答がJSON objectではありません。"
            )
        return payload

    def _result(
        self, request: ProposalRequest, payload: dict[str, Any]
    ) -> ProposalResult:
        if payload.get("is_error") or payload.get("subtype") != "success":
            logger.warning(
                "提案Providerが失敗を返しました。provider=%s subtype=%s",
                PROVIDER_ID,
                payload.get("subtype"),
            )
            raise AgentUnavailable("提案Providerが提案を返しませんでした。")
        output = proposals.validate_output(
            request.kind, payload.get("structured_output")
        )
        usage = {
            key: payload[key]
            for key in USAGE_KEYS
            if isinstance(payload.get(key), int | float)
        }
        return ProposalResult(
            output=output, model=self._settings.agent_model, usage=usage
        )
