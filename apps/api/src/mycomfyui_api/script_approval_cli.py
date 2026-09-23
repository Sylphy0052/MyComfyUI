"""ユーザースクリプトのrunを手元で確かめて承認するCLI(ADR 0003)。

APIは認証を持たないため、承認tokenはREST APIでは作れない。このCLIは利用者だけが
読める承認鍵でtokenを署名する。表示した内容からdigestを自分で計算し直し、APIが
返したdigestと一致したときだけ署名する。APIの応答を鵜呑みにして別の内容へ署名
しないためである。
"""

import argparse
import sys
from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Any, TextIO

import httpx

from mycomfyui_api import script_approval
from mycomfyui_api.settings import get_settings

EXIT_REJECTED = 1
EXIT_ERROR = 2
#: 期限の上限に足す余裕。APIとCLIの時計の差を吸収する。
EXPIRY_SLACK_SECONDS = 60
REQUEST_TIMEOUT_SECONDS = 30.0


class ApprovalError(Exception):
    """承認を進められない。"""


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="mycomfyui-script-approve",
        description="ユーザースクリプトのrunの内容を表示し、確認したうえで承認する。",
    )
    parser.add_argument("run_id", help="previewで作ったrunのID。")
    parser.add_argument(
        "--api-base-url",
        help="Application APIのURL。既定はhttp://127.0.0.1:<api_port>。",
    )
    return parser.parse_args(argv)


def _visible(text: str) -> str:
    """端末の制御文字を無害な表記へ置き換える。

    script本文や引数に端末のescape sequenceを仕込み、表示を書き換えて利用者に
    別の内容を見せる攻撃を防ぐ。改行とタブ以外の制御文字はすべて表記へ変える。
    """
    out: list[str] = []
    for char in text:
        code = ord(char)
        if char in "\n\t":
            out.append(char)
        elif code < 0x20 or 0x7F <= code < 0xA0 or char in "  ":
            out.append(f"\\x{code:02x}" if code < 0x100 else f"\\u{code:04x}")
        elif (
            0x202A <= code <= 0x202E
            or 0x2066 <= code <= 0x2069
            or code == 0x200E
            or code == 0x200F
        ):
            # 双方向制御文字は表示順を入れ替えて内容を偽装できる。
            out.append(f"\\u{code:04x}")
        else:
            out.append(char)
    return "".join(out)


def _quote(value: str) -> str:
    return repr(value) if _visible(value) == value else _visible(repr(value))


def _require(run: dict[str, Any], name: str, kind: type) -> Any:
    value = run.get(name)
    if not isinstance(value, kind):
        raise ApprovalError(f"APIの応答に{name}がありません。")
    return value


def _check_run(run: dict[str, Any], run_id: str, max_ttl_seconds: int) -> str:
    """応答を検証し、自分で計算したdigestを返す。"""
    if _require(run, "id", str) != run_id:
        raise ApprovalError("APIが別のrunを返しました。")
    if _require(run, "status", str) != "pending_approval":
        raise ApprovalError(f"承認待ちのrunではありません(status={run['status']})。")
    source = _require(run, "script_source", str)
    sha = script_approval.source_sha256(source)
    if sha != _require(run, "script_sha256", str):
        raise ApprovalError("script本文のSHA-256が記録と一致しません。")
    expires_at = _require(run, "approval_expires_at", str)
    try:
        deadline = datetime.fromisoformat(expires_at)
    except ValueError as error:
        raise ApprovalError("承認の期限を解釈できません。") from error
    now = datetime.now().astimezone()
    if deadline.tzinfo is None or now > deadline:
        raise ApprovalError("承認の期限が切れています。previewからやり直してください。")
    if deadline > now + timedelta(seconds=max_ttl_seconds + EXPIRY_SLACK_SECONDS):
        raise ApprovalError("承認の期限が設定より長く、受け付けられません。")
    inputs = _require(run, "inputs", list)
    digest = script_approval.run_digest(
        script_approval.run_operation(
            run_id=run_id,
            script_id=_require(run, "script_id", str),
            script_sha256=sha,
            interpreter=_require(run, "interpreter", str),
            arguments=_require(run, "arguments", list),
            inputs=inputs,
            capabilities=_require(run, "capabilities", dict),
            destination=script_approval.output_destination(run_id),
        )
    )
    if digest != _require(run, "digest", str):
        raise ApprovalError("表示する内容から計算したdigestがAPIの記録と一致しません。")
    if _require(run, "output_destination", str) != script_approval.output_destination(
        run_id
    ):
        raise ApprovalError("出力先がこのrunの既定の場所ではありません。")
    return digest


def _render(run: dict[str, Any], digest: str, out: TextIO) -> None:
    lines = [
        "=== ユーザースクリプトの実行承認 ===",
        f"run: {run['id']}",
        f"script: {_visible(run.get('script_name', ''))} ({run['script_id']})",
        f"script SHA-256: {run['script_sha256']}",
        f"実行: {_visible(run['interpreter'])} -I {script_approval.SANDBOX_SCRIPT_PATH}",
        f"引数 ({len(run['arguments'])}件):",
        *[
            f"  [{index}] {_quote(str(arg))}"
            for index, arg in enumerate(run["arguments"])
        ],
        f"入力 ({len(run['inputs'])}件、読み取り専用):",
        *[
            f"  {_visible(str(item.get('mount_path')))} <- Artifact "
            f"{_visible(str(item.get('artifact_id')))} sha256={_visible(str(item.get('sha256')))}"
            for item in run["inputs"]
        ],
        "能力:",
        *[
            f"  {_visible(str(name))}: {_visible(str(value))}"
            for name, value in sorted(run["capabilities"].items())
        ],
        f"出力: {script_approval.SANDBOX_OUTPUT_DIR} -> {run['output_destination']}",
        f"承認の期限: {run['approval_expires_at']}",
        f"digest: {digest}",
        "--- script本文 ---",
        _visible(run["script_source"]),
        "--- ここまで ---",
    ]
    out.write("\n".join(lines) + "\n")
    out.flush()


def _confirm(stdin: TextIO, out: TextIO) -> bool:
    if not stdin.isatty():
        raise ApprovalError(
            "承認は端末から対話で行ってください。標準入力が端末ではありません。"
        )
    out.write("この内容で実行を承認するなら yes と入力してください: ")
    out.flush()
    return stdin.readline().strip() == "yes"


def approve(
    run_id: str,
    base_url: str,
    *,
    stdin: TextIO = sys.stdin,
    out: TextIO = sys.stdout,
) -> int:
    settings = get_settings()
    key = script_approval.load_key(settings.user_script_approval_key_path)
    url = f"{base_url.rstrip('/')}/api/v1/user-scripts/runs/{run_id}"
    # 環境変数のproxy設定を読まない。承認tokenを手元のAPI以外へ送らないためである。
    with httpx.Client(trust_env=False, timeout=REQUEST_TIMEOUT_SECONDS) as client:
        response = client.get(url)
        if response.status_code != 200:
            raise ApprovalError(f"runを取得できません(HTTP {response.status_code})。")
        run = response.json()
        if not isinstance(run, dict):
            raise ApprovalError("APIの応答を解釈できません。")
        digest = _check_run(run, run_id, settings.user_scripts_approval_ttl_seconds)
        _render(run, digest, out)
        if not _confirm(stdin, out):
            out.write("承認しませんでした。\n")
            return EXIT_REJECTED
        token = script_approval.sign(
            key, run_id=run_id, digest=digest, expires_at=run["approval_expires_at"]
        )
        response = client.post(f"{url}/approve", json={"approval_token": token})
        if response.status_code != 200:
            raise ApprovalError(
                f"承認を記録できません(HTTP {response.status_code}): {_visible(response.text[:500])}"
            )
    out.write("承認しました。実行はAPIのexecuteで行ってください。\n")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    base_url = args.api_base_url or f"http://127.0.0.1:{get_settings().api_port}"
    try:
        return approve(args.run_id, base_url)
    except (ApprovalError, script_approval.ApprovalKeyError) as error:
        sys.stderr.write(f"エラー: {error}\n")
        return EXIT_ERROR
    except httpx.HTTPError as error:
        sys.stderr.write(f"エラー: APIへ接続できません: {error}\n")
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
