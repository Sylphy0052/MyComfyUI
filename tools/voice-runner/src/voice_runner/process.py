"""Backendをsubprocessで起動する。

モデル本体をrunnerのプロセスへimportしない。1リクエストにつき1つのBackendだけを
起動し、終わったらプロセスを落としてVRAMを返す。

exit codeが非0なら失敗として扱い、別のBackendへ自動でfallbackしない
(`tools/ai-media/docs/tts-backends.md`のAdapter共通契約)。
"""

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

WORKERS_DIR = Path(__file__).resolve().parents[2] / "workers"

#: stderrから応答へ載せる長さ。モデルの警告で応答が膨らむのを防ぐ。
STDERR_EXCERPT = 2000


class WorkerFailed(RuntimeError):
    """Backendプロセスが非0で終了した、または応答を返さなかった。"""


class WorkerTimeout(RuntimeError):
    """Backendプロセスが制限時間内に終わらなかった。"""


async def run_worker(
    python: Path,
    script: str,
    request: dict[str, Any],
    workdir: Path,
    timeout_sec: float,
) -> dict[str, Any]:
    """worker scriptを実行し、応答JSONを返す。

    入出力はファイルで渡す。stdoutは進捗、stderrはモデルの警告に使われるため、
    結果の受け渡しには使わない。
    """
    request_path = workdir / "request.json"
    response_path = workdir / "response.json"
    request_path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
    worker_path = WORKERS_DIR / script
    if not worker_path.is_file():
        raise WorkerFailed(f"worker scriptがありません: {worker_path}")
    process = await asyncio.create_subprocess_exec(
        str(python),
        str(worker_path),
        str(request_path),
        str(response_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(workdir),
    )
    try:
        _, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_sec)
    except TimeoutError as error:
        process.kill()
        await process.wait()
        raise WorkerTimeout(
            f"Backendが{timeout_sec}秒以内に終わりませんでした: {script}"
        ) from error
    if process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace")[-STDERR_EXCERPT:]
        raise WorkerFailed(
            f"Backendがexit code {process.returncode}で終了しました: {detail}"
        )
    try:
        payload = json.loads(response_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise WorkerFailed("Backendの応答を読み込めません。") from error
    if not isinstance(payload, dict):
        raise WorkerFailed("Backendの応答形式が想定外です。")
    if payload.get("error"):
        raise WorkerFailed(str(payload["error"])[:STDERR_EXCERPT])
    return payload
