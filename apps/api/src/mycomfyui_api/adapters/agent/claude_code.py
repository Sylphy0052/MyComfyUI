"""Claude Code CLIをsubprocessで呼ぶ提案Provider。

APIキーをMyComfyUI側へ持たず、CLIの既存認証をそのまま使う。設定にもDBにも認証情報を
置かないため、秘密情報を履歴やログへ残す経路を作らない。

提案以外の副作用を持たせないため、次の条件で起動する。

- 本文は引数ではなく標準入力へ渡す。外部由来のテキストをコマンド行へ載せない。
- `--tools ""`でCLIの全ツールを無効化し、`--safe-mode`で利用者設定、CLAUDE.md、hook、
  MCP、skillを読み込ませない。
- cwdは提案ごとに作る空ディレクトリとする。リポジトリも`data_root`の他の領域も見せない。
- 環境変数は`PATH`と`HOME`だけを渡す。`HOME`はCLIの既存認証に必要なため残す。
- 画像を添付するときだけ、入出力を`stream-json`へ切り替える。画像はbase64のcontent
  blockとして標準入力へ流し、ファイルとして書き出さない。ツールを持たせないため、
  パスを渡して読ませる方式は使えない。CLI 2.1.280で、この経路でも上の条件を併用できる
  ことと、`type=result`の最終行に構造化出力が載ることを実測した。

この条件が効くことはCLI 2.1.270で実測した。ツール実行・ファイル作成・設定ファイルの読み出しを
促す指示文を与えても、応答は提案JSONだけで、ツール使用と許可要求は発生せず、作業ディレクトリに
ファイルも残らなかった。CLIを更新したときは同じ確認をやり直す。
"""

import asyncio
import base64
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

    @property
    def supports_images(self) -> bool:
        return True

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

    def _argv(self, executable: str, kind: str, *, streaming: bool) -> list[str]:
        schema = proposals.json_schema(kind)  # type: ignore[arg-type]
        # 画像はstream-jsonの入力でしか渡せず、CLIはその入力を`--output-format json`と
        # 組み合わせられない。画像が無い呼び出しは従来の形のまま変えない。
        formats = (
            [
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
            ]
            if streaming
            else ["--output-format", "json"]
        )
        return [
            executable,
            "-p",
            *formats,
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
            # 設定した実行ファイルのパスは失敗理由へ載せない。この文言は提案の履歴へ
            # 保存され、APIから読み出せるため、ローカル固有のパスを残さない。
            raise AgentUnavailable(
                "Claude Code CLIを実行できません。実行ファイルの設定を確認してください。"
            )
        workspace = self._settings.agent_workspace_root / str(uuid4())
        try:
            workspace.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise AgentUnavailable("提案用の作業ディレクトリを作れません。") from error
        try:
            payload = await self._run(executable, request, workspace)
        finally:
            self._discard_workspace(workspace)
        return self._result(request, payload)

    def _discard_workspace(self, workspace: Path) -> None:
        """作業ディレクトリを消す。失敗しても提案の結果は変えない。

        消せないまま黙って進むと`tmp/agent/`配下が溜まり続けるため、検知できるよう
        警告だけ残す。
        """
        try:
            shutil.rmtree(workspace)
        except OSError:
            logger.warning(
                "提案の作業ディレクトリを削除できません。provider=%s", PROVIDER_ID
            )

    async def _run(
        self, executable: str, request: ProposalRequest, workspace: Path
    ) -> dict[str, Any]:
        streaming = bool(request.images)
        argv = self._argv(executable, request.kind, streaming=streaming)
        prompt = self._stdin(request, streaming=streaming)
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
            text = stdout.decode("utf-8")
            payload = self._stream_result(text) if streaming else json.loads(text)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise AgentInvalidResponse(
                "提案Providerの応答を解釈できません。"
            ) from error
        if not isinstance(payload, dict):
            raise AgentInvalidResponse(
                "提案Providerの応答がJSON objectではありません。"
            )
        return payload

    def _stdin(self, request: ProposalRequest, *, streaming: bool) -> bytes:
        """標準入力へ流す本文。画像があるときはstream-jsonの利用者メッセージ1件にする。"""
        prompt = proposals.build_prompt(request)
        if not streaming:
            return prompt.encode("utf-8")
        content: list[dict[str, Any]] = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image.media_type,
                    "data": base64.b64encode(image.data).decode("ascii"),
                },
            }
            for image in request.images
        ]
        content.append({"type": "text", "text": prompt})
        message = {"type": "user", "message": {"role": "user", "content": content}}
        return (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")

    def _stream_result(self, text: str) -> Any:
        """stream-jsonの出力から`type=result`の行を取り出す。

        途中の行には応答本文や思考の断片が載るため、結果の行以外は解釈しない。
        """
        for line in reversed(text.splitlines()):
            if not line.strip():
                continue
            event = json.loads(line)
            if isinstance(event, dict) and event.get("type") == "result":
                return event
        raise AgentInvalidResponse("提案Providerの応答に結果がありません。")

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
