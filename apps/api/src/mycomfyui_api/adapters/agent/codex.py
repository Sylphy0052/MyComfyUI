"""Codex CLIをsubprocessで呼ぶ提案Provider。

APIキーをMyComfyUI側へ持たず、CLIの既存認証(`codex login`)をそのまま使う。設定にもDBにも
認証情報を置かないため、秘密情報を履歴やログへ残す経路を作らない。

提案以外の副作用を持たせないため、次の条件で起動する。

- `codex exec`へ`--sandbox read-only`を渡す。ファイルシステムへの書き込みに加え、
  ネットワークアクセスも既定で遮断される(`curl`を実行させてもDNS解決から失敗することを
  実測で確認した。ホスト側では同じ名前解決とHTTP到達が成功することも確認済み)。
- `--skip-git-repo-check`でGit repository外のcwdでも動かす。
- cwdは提案ごとに作る空ディレクトリとする。リポジトリも`data_root`の他の領域も見せない。
- 環境変数は`PATH`と`HOME`だけを渡す。`HOME`はCLIの既存認証(`~/.codex`)に必要なため残す。
- 出力形式は`--output-schema`へ渡したJSON Schemaファイルで固定し、`-o`で最終応答だけを
  別ファイルへ書き出す。標準出力のJSONLイベント本文はログへ出さない。
- Codexの`response_format`はOpenAIのstrict JSON Schemaを要求し、`properties`にある
  項目を全て`required`へ含めないと400で拒否される(実測で確認)。`proposals.json_schema`
  はPydanticの`default`を持つ項目を`required`から外すため、ここで全項目を`required`へ
  足したschemaを別途組み立てる。出力の検証自体は`proposals.validate_output`(Pydantic側)
  を通すため、Codexが`default`と同じ値を明示的に返しても扱いは変わらない。

この条件が効くことはCLI 0.154.0で実測した。ファイル書き込みと外部送信(`curl`)を促す
指示文を与えても、sandboxがどちらも拒否し、承認待ちで停止することもなかった。CLIを
更新したときは同じ確認をやり直す。

プロンプトを起動引数ではなく標準入力へ渡すと、CLIが追加入力を標準入力から読もうとして
終了しない。そのため本文は起動引数として渡し、標準入力は明示的に閉じる。この結果、
プロンプト本文(利用者指示文とScene/Shot本文)は起動中のプロセスのコマンドライン引数として
残り、同じホスト上の他ユーザーやプロセス監視ツールから`/proc/<pid>/cmdline`等で読める
状態になる。単一利用者のローカル実行を前提とする間はこの経路を許容するが、共有ホストや
複数利用者環境では使わない。
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
    AgentProposalKind,
    AgentUnavailable,
    ProposalRequest,
    ProposalResult,
)
from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

PROVIDER_ID = "codex"
PROVIDER_LABEL = "Codex CLI"

#: 応答から履歴へ残す実測値。認証情報も接続先も含まない項目だけを並べる。
USAGE_KEYS = ("input_tokens", "cached_input_tokens", "output_tokens")


def _strict_schema(kind: AgentProposalKind) -> dict[str, Any]:
    """理由はモジュールdocstringを参照。`required`を`properties`の全項目へ揃える。"""
    return _require_all_properties(proposals.json_schema(kind))


def _require_all_properties(node: Any) -> Any:
    """dict/listを再帰的に辿り、object nodeの`required`を`properties`全体へ揃える。

    `$defs`配下のitem型定義にも同じ変換をかけるため、`properties`という名前に
    決め打ちせず全nodeを見て回る。
    """
    if isinstance(node, dict):
        result = {key: _require_all_properties(value) for key, value in node.items()}
        properties = result.get("properties")
        if isinstance(properties, dict):
            result["required"] = list(properties.keys())
        return result
    if isinstance(node, list):
        return [_require_all_properties(item) for item in node]
    return node


class CodexProvider:
    """Codex CLIを1回呼び出して提案を1件返す。"""

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
        configured = self._settings.agent_codex_cli_path
        if os.sep in configured or (os.altsep and os.altsep in configured):
            path = Path(configured)
            return str(path) if os.access(path, os.X_OK) else None
        return shutil.which(configured)

    def _argv(
        self,
        executable: str,
        prompt: str,
        workspace: Path,
        schema_path: Path,
        output_path: Path,
    ) -> list[str]:
        argv = [
            executable,
            "exec",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "-C",
            str(workspace),
            "--output-schema",
            str(schema_path),
            "-o",
            str(output_path),
            "--json",
        ]
        if self._settings.agent_codex_model:
            argv.extend(["--model", self._settings.agent_codex_model])
        argv.append(prompt)
        return argv

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
                "Codex CLIを実行できません。実行ファイルの設定を確認してください。"
            )
        workspace = self._settings.agent_workspace_root / str(uuid4())
        try:
            # 0o700で作る。schema/promptの中身にScene/Shot本文が載るため、同じホスト上の
            # 他利用者から読めるパーミッションにしない。
            workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
        except OSError as error:
            raise AgentUnavailable("提案用の作業ディレクトリを作れません。") from error
        try:
            payload, usage = await self._run(executable, request, workspace)
        finally:
            self._discard_workspace(workspace)
        output = proposals.validate_output(request.kind, payload)
        return ProposalResult(
            output=output, model=self._settings.agent_codex_model, usage=usage
        )

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
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        schema_path = workspace / "schema.json"
        output_path = workspace / "last-message.json"
        schema_path.write_text(
            json.dumps(_strict_schema(request.kind), ensure_ascii=False),
            encoding="utf-8",
        )
        prompt = proposals.build_prompt(request)
        argv = self._argv(executable, prompt, workspace, schema_path, output_path)
        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=workspace,
                env=self._environment(),
            )
        except OSError as error:
            raise AgentUnavailable("提案Providerを起動できません。") from error
        try:
            stdout, _ = await asyncio.wait_for(
                process.communicate(),
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
            text = output_path.read_text(encoding="utf-8")
        except OSError as error:
            raise AgentInvalidResponse(
                "提案Providerの応答を読み出せません。"
            ) from error
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as error:
            raise AgentInvalidResponse(
                "提案Providerの応答を解釈できません。"
            ) from error
        if not isinstance(payload, dict):
            raise AgentInvalidResponse(
                "提案Providerの応答がJSON objectではありません。"
            )
        return payload, self._extract_usage(stdout)

    def _extract_usage(self, stdout: bytes) -> dict[str, Any]:
        """`--json`のJSONLイベントから、最後の`turn.completed`のusageだけを拾う。

        イベント本文には接続先や認証情報は含まれない。1行でも解釈できない行が
        あっても、usageが取れないだけで提案の成否には影響させない。
        """
        usage: dict[str, Any] = {}
        for line in stdout.decode("utf-8", errors="replace").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict) or event.get("type") != "turn.completed":
                continue
            raw_usage = event.get("usage")
            if isinstance(raw_usage, dict):
                usage = {
                    key: raw_usage[key]
                    for key in USAGE_KEYS
                    if isinstance(raw_usage.get(key), int | float)
                }
        return usage
