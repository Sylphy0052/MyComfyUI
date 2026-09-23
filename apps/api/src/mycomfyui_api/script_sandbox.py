"""ユーザースクリプトをbubblewrapのsandboxで実行するrunner(ADR 0003)。

起動するコマンドは引数配列として組み立て、shellを通さない。資源の上限は3段で掛ける。
メモリとプロセス数はsystemdのuser scope(cgroup v2)、CPU時間と1ファイルの大きさは
`prlimit`、経過時間と出力の総量はこのモジュールが監視して止める。

sandboxが使えない環境では実行せずに`SandboxUnavailable`を送出する(fail closed)。
"""

import asyncio
import logging
import os
import signal
import stat
import time
from dataclasses import dataclass, field
from pathlib import Path

from mycomfyui_api.script_approval import (
    SANDBOX_INPUTS_DIR,
    SANDBOX_OUTPUT_DIR,
    SANDBOX_SCRIPT_PATH,
)
from mycomfyui_api.settings import Settings

logger = logging.getLogger(__name__)

#: 経過時間と出力量を確かめる間隔。
WATCH_INTERVAL_SECONDS = 0.5
#: stdoutとstderrを読む単位。
READ_CHUNK_BYTES = 64 * 1024
#: sandboxの中で開けるfile descriptorの上限。
MAX_OPEN_FILES = 256
#: sandboxの起動確認にかける時間の上限。
PROBE_TIMEOUT_SECONDS = 30.0
#: ホストのroot直下で、`/usr`へのsymlinkかdirectoryとして見せる項目。
ROOT_LINKS = ("bin", "lib", "lib64", "sbin")
#: systemdのuser managerへ接続するためだけに`systemd-run`へ渡す環境変数。
#: sandboxの中には`--clearenv`で1つも渡らない。
SYSTEMD_ENV_KEYS = ("XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS")


class SandboxUnavailable(Exception):
    """sandboxを起動できない。実行せずに拒否する。"""


@dataclass(frozen=True)
class SandboxTools:
    bwrap: str
    prlimit: str
    systemd_run: str
    systemctl: str
    python: str


@dataclass(frozen=True)
class Limits:
    cpu_seconds: int
    memory_bytes: int
    max_tasks: int
    wall_seconds: int
    output_bytes: int
    output_files: int
    log_bytes: int


@dataclass(frozen=True)
class Mount:
    host_path: Path
    sandbox_path: str


@dataclass
class RunOutcome:
    exit_code: int | None
    #: 上限超過や取消で止めたときの理由。正常に終わったときはNone。
    stop_reason: str | None
    stdout: bytes = b""
    stderr: bytes = b""
    duration_seconds: float = 0.0
    details: dict = field(default_factory=dict)


def _require_executable(path: str, label: str) -> str:
    candidate = Path(path)
    if not candidate.is_absolute():
        raise SandboxUnavailable(f"{label}は絶対パスで設定してください: {path}")
    if not candidate.is_file() or not os.access(candidate, os.X_OK):
        raise SandboxUnavailable(f"{label}が見つからないか実行できません: {path}")
    return str(candidate)


def tools_from_settings(settings: Settings) -> SandboxTools:
    """設定の実行ファイルを確かめる。1つでも欠ければ実行しない。"""
    if not os.uname().sysname == "Linux":
        raise SandboxUnavailable("sandboxはLinuxでだけ利用できます。")
    python = _require_executable(settings.user_scripts_python_path, "python")
    if not Path(python).is_relative_to("/usr"):
        raise SandboxUnavailable(
            "sandboxへは/usrだけを見せるため、pythonは/usr配下のパスにしてください。"
        )
    return SandboxTools(
        bwrap=_require_executable(settings.user_scripts_bwrap_path, "bwrap"),
        prlimit=_require_executable(settings.user_scripts_prlimit_path, "prlimit"),
        systemd_run=_require_executable(
            settings.user_scripts_systemd_run_path, "systemd-run"
        ),
        systemctl=_require_executable(
            settings.user_scripts_systemctl_path, "systemctl"
        ),
        python=python,
    )


def launcher_env() -> dict[str, str]:
    """`systemd-run`へ渡す環境。APIの環境変数と資格情報は渡さない。"""
    env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
    for key in SYSTEMD_ENV_KEYS:
        value = os.environ.get(key)
        if value:
            env[key] = value
    return env


def _root_args() -> list[str]:
    """`/usr`以外のroot直下の項目を、ホストと同じ形で見せる引数。"""
    args: list[str] = []
    for name in ROOT_LINKS:
        host = Path("/") / name
        if host.is_symlink():
            args += ["--symlink", os.readlink(host), str(host)]
        elif host.is_dir():
            args += ["--ro-bind", str(host), str(host)]
    return args


def unit_name(run_id: str) -> str:
    return f"mycomfyui-script-{run_id}"


def build_command(
    tools: SandboxTools,
    limits: Limits,
    *,
    unit: str,
    script: Path | None,
    inputs: list[Mount],
    output_dir: Path | None,
    arguments: list[str],
    program: list[str] | None = None,
) -> list[str]:
    """sandboxを起動する引数配列を組み立てる。

    `program`を渡したときはscriptの代わりにそれを実行する。起動確認で使う。
    """
    command = [
        tools.systemd_run,
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        f"--unit={unit}",
        "-p",
        f"TasksMax={limits.max_tasks}",
        "-p",
        f"MemoryMax={limits.memory_bytes}",
        "-p",
        "MemorySwapMax=0",
        "--",
        tools.prlimit,
        f"--cpu={limits.cpu_seconds}:{limits.cpu_seconds}",
        # 1ファイルの上限。出力の総量より大きいファイルは作らせない。0を渡すと
        # 空ファイル以外を書けなくなるため、下限を1とする。
        f"--fsize={max(limits.output_bytes, 1)}:{max(limits.output_bytes, 1)}",
        "--core=0:0",
        f"--nofile={MAX_OPEN_FILES}:{MAX_OPEN_FILES}",
        "--",
        tools.bwrap,
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--setenv",
        "PATH",
        "/usr/bin:/bin",
        "--setenv",
        "LANG",
        "C.UTF-8",
        "--setenv",
        "HOME",
        "/tmp",
        "--ro-bind",
        "/usr",
        "/usr",
        *_root_args(),
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
    ]
    if script is not None:
        command += ["--ro-bind", str(script), SANDBOX_SCRIPT_PATH]
    if inputs:
        command += ["--dir", SANDBOX_INPUTS_DIR]
        for mount in inputs:
            command += ["--ro-bind", str(mount.host_path), mount.sandbox_path]
    if output_dir is not None:
        command += ["--bind", str(output_dir), SANDBOX_OUTPUT_DIR]
        command += ["--chdir", SANDBOX_OUTPUT_DIR]
    else:
        command += ["--chdir", "/tmp"]
    command.append("--")
    if program is not None:
        command += program
    else:
        command += [tools.python, "-I", SANDBOX_SCRIPT_PATH, *arguments]
    return command


async def probe(tools: SandboxTools, limits: Limits, *, unit: str) -> None:
    """実行と同じ構成で`true`を起動し、sandboxが使えることを確かめる。"""
    command = build_command(
        tools,
        limits,
        unit=unit,
        script=None,
        inputs=[],
        output_dir=None,
        arguments=[],
        program=["/usr/bin/true"],
    )
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            env=launcher_env(),
            start_new_session=True,
        )
    except OSError as error:
        raise SandboxUnavailable(f"sandboxを起動できません: {error}") from error
    try:
        _, stderr = await asyncio.wait_for(
            process.communicate(), timeout=PROBE_TIMEOUT_SECONDS
        )
    except TimeoutError as error:
        _kill_group(process.pid)
        await process.wait()
        raise SandboxUnavailable("sandboxの起動確認が時間内に終わりません。") from error
    if process.returncode != 0:
        message = stderr[:2000].decode("utf-8", errors="replace").strip()
        raise SandboxUnavailable(
            f"sandboxの起動確認に失敗しました(exit {process.returncode}): {message}"
        )


def _kill_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


async def _stop_unit(tools: SandboxTools, unit: str) -> None:
    """scopeに残ったプロセスを止める。bwrapの道連れで既に空なら何もしない。"""
    process = await asyncio.create_subprocess_exec(
        tools.systemctl,
        "--user",
        "kill",
        "--signal=SIGKILL",
        unit,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        env=launcher_env(),
    )
    await process.wait()


def output_usage(
    directory: Path, *, byte_limit: int, file_limit: int
) -> tuple[int, int]:
    """出力ディレクトリの使用量と項目数。symlinkは辿らない。

    上限を超えた時点で数えるのをやめる。大量のファイルで監視自体が重くなるのを防ぐ。
    """
    total_bytes = 0
    entries = 0
    stack = [directory]
    while stack:
        current = stack.pop()
        try:
            iterator = os.scandir(current)
        except OSError:
            continue
        with iterator:
            for entry in iterator:
                entries += 1
                try:
                    info = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                total_bytes += max(info.st_size, info.st_blocks * 512)
                if stat.S_ISDIR(info.st_mode):
                    stack.append(Path(entry.path))
                if total_bytes > byte_limit or entries > file_limit:
                    return total_bytes, entries
    return total_bytes, entries


async def _read_capped(
    stream: asyncio.StreamReader, limit: int, exceeded: asyncio.Event
) -> bytes:
    buffer = bytearray()
    while True:
        chunk = await stream.read(READ_CHUNK_BYTES)
        if not chunk:
            return bytes(buffer)
        room = limit - len(buffer)
        buffer += chunk[: max(room, 0)]
        if len(chunk) > room:
            exceeded.set()
            return bytes(buffer)


async def run(
    tools: SandboxTools,
    limits: Limits,
    *,
    unit: str,
    command: list[str],
    output_dir: Path,
    cancel: asyncio.Event,
) -> RunOutcome:
    """sandboxを起動し、終了か上限超過か取消まで見張る。"""
    started = time.monotonic()
    process = await asyncio.create_subprocess_exec(
        *command,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=launcher_env(),
        start_new_session=True,
    )
    assert process.stdout is not None and process.stderr is not None
    log_exceeded = asyncio.Event()
    stdout_task = asyncio.create_task(
        _read_capped(process.stdout, limits.log_bytes, log_exceeded)
    )
    stderr_task = asyncio.create_task(
        _read_capped(process.stderr, limits.log_bytes, log_exceeded)
    )
    wait_task = asyncio.create_task(process.wait())
    stop_reason: str | None = None
    details: dict = {}
    try:
        while not wait_task.done():
            await asyncio.wait({wait_task}, timeout=WATCH_INTERVAL_SECONDS)
            if wait_task.done():
                break
            if cancel.is_set():
                stop_reason = "cancelled"
            elif log_exceeded.is_set():
                stop_reason = "log_limit"
            elif time.monotonic() - started > limits.wall_seconds:
                stop_reason = "timeout"
            else:
                used, entries = await asyncio.to_thread(
                    output_usage,
                    output_dir,
                    byte_limit=limits.output_bytes,
                    file_limit=limits.output_files,
                )
                if used > limits.output_bytes or entries > limits.output_files:
                    stop_reason = "output_limit"
                    details = {"output_bytes": used, "output_entries": entries}
            if stop_reason is not None:
                _kill_group(process.pid)
                break
    finally:
        if not wait_task.done():
            _kill_group(process.pid)
        await wait_task
        try:
            await _stop_unit(tools, unit)
        except OSError:
            logger.warning("scriptのscopeを止められません: %s", unit, exc_info=True)
    stdout = await stdout_task
    stderr = await stderr_task
    if stop_reason is None and log_exceeded.is_set():
        stop_reason = "log_limit"
    return RunOutcome(
        exit_code=process.returncode,
        stop_reason=stop_reason,
        stdout=stdout,
        stderr=stderr,
        duration_seconds=time.monotonic() - started,
        details=details,
    )
