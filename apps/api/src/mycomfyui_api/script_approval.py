"""ユーザースクリプトの実行内容のdigestと、承認tokenの署名・検証(ADR 0003)。

APIは認証を持たないため、REST APIだけで承認が完結すると、ブラウザ経由の要求や
同じホストの別プログラムが承認を偽造できる。承認tokenは利用者だけが読める鍵による
HMACとし、tokenを作れるのは鍵を読める手元のCLIだけにする。APIは検証だけを行う。

このモジュールはAPIとCLIの両方から使う。digestの計算を1箇所に置き、CLIが表示した
内容とAPIが実行する内容が同じ関数で結び付くようにする。
"""

import hashlib
import hmac
import json
import os
import secrets
import stat
from pathlib import Path
from typing import Any

from mycomfyui_api.approvals import operation_digest

#: 署名の対象へ入れる用途の識別子。同じ鍵で別用途の署名が作られても流用できない
#: ようにする。
TOKEN_CONTEXT = "mycomfyui.user-script-run.v1"
KEY_BYTES = 32
#: tokenはHMAC-SHA256の16進表記。
TOKEN_LENGTH = 64
#: sandboxの中で見える場所。digestへ入れ、承認時に利用者が確認できるようにする。
SANDBOX_SCRIPT_PATH = "/sandbox/script.py"
SANDBOX_INPUTS_DIR = "/sandbox/inputs"
SANDBOX_OUTPUT_DIR = "/sandbox/output"


class ApprovalKeyError(Exception):
    """承認鍵が無い、または利用者以外に読める状態にある。"""


def source_sha256(source: str) -> str:
    """script本文のSHA-256。登録時の固定と実行前の再検証に同じ計算を使う。"""
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def output_destination(run_id: str) -> str:
    """生成したArtifactの保存先。`data_root`基準の相対パスで表す。"""
    return f"artifacts/script-run-{run_id}/"


def run_operation(
    *,
    run_id: str,
    script_id: str,
    script_sha256: str,
    interpreter: str,
    arguments: list[str],
    inputs: list[dict[str, Any]],
    capabilities: dict[str, Any],
    destination: str,
) -> dict[str, Any]:
    """承認の対象になる実行内容。script、引数、入力、能力、出力先をすべて含める。"""
    return {
        "kind": "user_script.run",
        "version": 1,
        "run_id": run_id,
        "script": {"id": script_id, "sha256": script_sha256},
        "interpreter": interpreter,
        "script_path": SANDBOX_SCRIPT_PATH,
        "arguments": list(arguments),
        "inputs": [
            {
                "artifact_id": item["artifact_id"],
                "sha256": item["sha256"],
                "mount_path": item["mount_path"],
            }
            for item in inputs
        ],
        "capabilities": dict(capabilities),
        "output": {"sandbox_path": SANDBOX_OUTPUT_DIR, "destination": destination},
    }


def run_digest(operation: dict[str, Any]) -> str:
    return operation_digest(operation)


def _message(run_id: str, digest: str, expires_at: str) -> bytes:
    return json.dumps(
        [TOKEN_CONTEXT, run_id, digest, expires_at],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def sign(key: bytes, *, run_id: str, digest: str, expires_at: str) -> str:
    """承認tokenを作る。CLIだけが呼ぶ。"""
    return hmac.new(
        key, _message(run_id, digest, expires_at), hashlib.sha256
    ).hexdigest()


def verify_token(
    key: bytes, token: str, *, run_id: str, digest: str, expires_at: str
) -> bool:
    """承認tokenが、このrunのこの内容と期限に対して作られたものかを確かめる。"""
    expected = sign(key, run_id=run_id, digest=digest, expires_at=expires_at)
    return hmac.compare_digest(expected, token)


def _check_private(info: os.stat_result, path: Path, kind: str) -> None:
    if info.st_uid != os.getuid():
        raise ApprovalKeyError(f"{kind}の所有者が実行中の利用者と違います: {path}")
    if info.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise ApprovalKeyError(
            f"{kind}へ他の利用者の権限が付いています。権限を外してください: {path}"
        )


def load_key(path: Path) -> bytes:
    """承認鍵を読む。symlinkと、利用者以外に権限がある鍵は使わない。"""
    _check_private(_stat_dir(path.parent), path.parent, "承認鍵のディレクトリ")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError as error:
        raise ApprovalKeyError(
            "承認鍵がありません。user_scripts_enabledを有効にしてAPIを起動してください。"
        ) from error
    except OSError as error:
        raise ApprovalKeyError(f"承認鍵を開けません: {path}") from error
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ApprovalKeyError(f"承認鍵が通常ファイルではありません: {path}")
        _check_private(info, path, "承認鍵")
        key = os.read(fd, KEY_BYTES + 1)
    finally:
        os.close(fd)
    if len(key) != KEY_BYTES:
        raise ApprovalKeyError(f"承認鍵の長さが正しくありません: {path}")
    return key


def _stat_dir(path: Path) -> os.stat_result:
    try:
        info = os.lstat(path)
    except FileNotFoundError as error:
        raise ApprovalKeyError(
            "承認鍵がありません。user_scripts_enabledを有効にしてAPIを起動してください。"
        ) from error
    if not stat.S_ISDIR(info.st_mode):
        raise ApprovalKeyError(
            f"承認鍵のディレクトリが通常のディレクトリではありません: {path}"
        )
    return info


def ensure_key(path: Path) -> None:
    """承認鍵が無ければ作る。既にあれば内容は変えず、権限だけを確かめる。"""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        load_key(path)
        return
    try:
        os.write(fd, secrets.token_bytes(KEY_BYTES))
    finally:
        os.close(fd)
    load_key(path)
