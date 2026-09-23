"""ユーザースクリプトの登録、preview、承認、実行、取消、監査のAPI(ADR 0003)。

実行までの流れは次のとおり。

1. 登録で本文、SHA-256、能力manifestを固定する。
2. previewで引数、入力、能力、出力先を並べたrunを作り、digestを返す。
3. 利用者が手元のCLIで内容を確かめ、鍵で署名したtokenを承認として送る。
4. 実行の直前にdigestとtokenを検証し直し、sandboxが使えることを確かめてから起動する。

APIは認証を持たないため、tokenを作る経路はREST APIに置かない。
"""

import asyncio
import logging
import os
import re
import shutil
import stat
from datetime import datetime, timedelta
from pathlib import Path
from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from mycomfyui_api import script_approval, script_sandbox
from mycomfyui_api.db import get_session, get_session_factory
from mycomfyui_api.errors import ApiError
from mycomfyui_api.models import Artifact
from mycomfyui_api.schemas import new_id
from mycomfyui_api.settings import Settings, get_settings
from mycomfyui_api.storage import (
    StorageError,
    detect_image_media_type,
    discard_artifacts,
    resolve_artifact,
    write_artifact,
)
from mycomfyui_api.user_script_models import (
    TERMINAL_RUN_STATUSES,
    UserScript,
    UserScriptAuditEvent,
    UserScriptRun,
)
from mycomfyui_api.user_script_schemas import (
    UserScriptAuditEventRead,
    UserScriptCreate,
    UserScriptDetail,
    UserScriptRead,
    UserScriptRunApprove,
    UserScriptRunCreate,
    UserScriptRunRead,
    UserScriptRunStatus,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/user-scripts", tags=["user-scripts"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]

#: 入力をsandboxへ見せるときのファイル名に使える文字。それ以外は`_`へ置き換える。
_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9._-]")
_MAX_INPUT_NAME = 100

#: 実行中のrunと、その取消の合図。同時に実行するrunは1件に限る。
_active: dict[str, asyncio.Event] = {}
_tasks: dict[str, asyncio.Task] = {}


class _Rejected(Exception):
    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now().astimezone()


def _is_expired(deadline: str, now: datetime) -> bool:
    """期限を過ぎたか。解釈できない期限は切れた扱いにする。"""
    try:
        return now > datetime.fromisoformat(deadline)
    except ValueError:
        return True


def _require_enabled(settings: Settings) -> None:
    if not settings.user_scripts_enabled:
        raise ApiError(
            "USER_SCRIPTS_DISABLED",
            "ユーザースクリプトは無効です。設定のuser_scripts_enabledで有効にしてください。",
            status_code=status.HTTP_403_FORBIDDEN,
        )


def _audit(
    session: AsyncSession,
    event_type: str,
    *,
    script_id: str | None = None,
    run_id: str | None = None,
    digest: str | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    session.add(
        UserScriptAuditEvent(
            id=new_id(),
            event_type=event_type,
            script_id=script_id,
            run_id=run_id,
            digest=digest,
            detail=detail or {},
            created_at=_now().isoformat(),
        )
    )


def _not_found(resource: str, resource_id: str) -> ApiError:
    return ApiError(
        "REFERENCE_NOT_FOUND",
        f"{resource}がありません。",
        status_code=status.HTTP_404_NOT_FOUND,
        details={"resource": resource, "id": resource_id},
    )


def _capability_violations(
    capabilities: dict[str, Any], settings: Settings
) -> list[str]:
    """設定の上限を超える能力の名前。"""
    caps = {
        "cpu_seconds": settings.user_scripts_max_cpu_seconds,
        "memory_bytes": settings.user_scripts_max_memory_bytes,
        "max_tasks": settings.user_scripts_max_tasks,
        "wall_seconds": settings.user_scripts_max_wall_seconds,
        "output_bytes": settings.user_scripts_max_output_bytes,
        "output_files": settings.user_scripts_max_output_files,
    }
    violations = [
        name
        for name, cap in caps.items()
        if not isinstance(capabilities.get(name), int) or capabilities[name] > cap
    ]
    if capabilities.get("network") != "none":
        violations.append("network")
    return violations


def _limits(capabilities: dict[str, Any], settings: Settings) -> script_sandbox.Limits:
    return script_sandbox.Limits(
        cpu_seconds=capabilities["cpu_seconds"],
        memory_bytes=capabilities["memory_bytes"],
        max_tasks=capabilities["max_tasks"],
        wall_seconds=capabilities["wall_seconds"],
        output_bytes=capabilities["output_bytes"],
        output_files=capabilities["output_files"],
        log_bytes=settings.user_scripts_max_log_bytes,
    )


def _mount_path(index: int, relative_path: str) -> str:
    name = _UNSAFE_NAME.sub("_", Path(relative_path).name)[:_MAX_INPUT_NAME] or "input"
    return f"{script_approval.SANDBOX_INPUTS_DIR}/{index:02d}-{name}"


def _run_read(run: UserScriptRun, script: UserScript) -> UserScriptRunRead:
    return UserScriptRunRead(
        id=run.id,
        script_id=script.id,
        script_name=script.name,
        script_sha256=run.script_sha256,
        script_source=script.source,
        interpreter=run.interpreter,
        arguments=list(run.arguments),
        inputs=list(run.inputs),
        capabilities=dict(run.capabilities),
        output_destination=run.output_destination,
        digest=run.digest,
        status=cast(UserScriptRunStatus, run.status),
        approval_expires_at=run.approval_expires_at,
        approved_at=run.approved_at,
        started_at=run.started_at,
        finished_at=run.finished_at,
        exit_code=run.exit_code,
        failure_reason=run.failure_reason,
        stdout=run.stdout,
        stderr=run.stderr,
        output_artifact_ids=list(run.output_artifact_ids),
        created_at=run.created_at,
    )


def _operation(
    run: UserScriptRun,
    script: UserScript,
    *,
    interpreter: str,
    inputs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """保存済みの記録から実行内容を組み立て直す。

    scriptのSHA-256は保存値を信じず本文から計算し直す。能力はscriptに固定した値を使う。
    """
    return script_approval.run_operation(
        run_id=run.id,
        script_id=script.id,
        script_sha256=script_approval.source_sha256(script.source),
        interpreter=interpreter,
        arguments=list(run.arguments),
        inputs=list(run.inputs) if inputs is None else inputs,
        capabilities=dict(script.capabilities),
        destination=script_approval.output_destination(run.id),
    )


async def _get_run(
    session: AsyncSession, run_id: str
) -> tuple[UserScriptRun, UserScript]:
    run = await session.get(UserScriptRun, run_id)
    if run is None:
        raise _not_found("run", run_id)
    script = await session.get(UserScript, run.script_id)
    if script is None:
        raise _not_found("script", run.script_id)
    return run, script


@router.get("/audit", response_model=list[UserScriptAuditEventRead])
async def list_audit_events(
    session: SessionDep,
    run_id: str | None = None,
    script_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> list[UserScriptAuditEventRead]:
    statement = select(UserScriptAuditEvent)
    if run_id is not None:
        statement = statement.where(UserScriptAuditEvent.run_id == run_id)
    if script_id is not None:
        statement = statement.where(UserScriptAuditEvent.script_id == script_id)
    statement = statement.order_by(UserScriptAuditEvent.created_at.desc()).limit(limit)
    rows = (await session.scalars(statement)).all()
    return [UserScriptAuditEventRead.model_validate(row) for row in rows]


@router.get("", response_model=list[UserScriptRead])
async def list_scripts(session: SessionDep) -> list[UserScriptRead]:
    rows = (
        await session.scalars(select(UserScript).order_by(UserScript.created_at))
    ).all()
    return [UserScriptRead.model_validate(row) for row in rows]


@router.post("", response_model=UserScriptDetail, status_code=status.HTTP_201_CREATED)
async def register_script(
    payload: UserScriptCreate, session: SessionDep
) -> UserScriptDetail:
    settings = get_settings()
    _require_enabled(settings)
    capabilities = payload.capabilities.model_dump()
    violations = _capability_violations(capabilities, settings)
    if violations:
        raise ApiError(
            "CAPABILITY_EXCEEDS_LIMIT",
            "能力manifestが設定の上限を超えています。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={"fields": violations},
        )
    script = UserScript(
        id=new_id(),
        name=payload.name,
        source=payload.source,
        sha256=script_approval.source_sha256(payload.source),
        capabilities=capabilities,
        created_at=_now().isoformat(),
    )
    session.add(script)
    _audit(
        session,
        "script.registered",
        script_id=script.id,
        digest=script.sha256,
        detail={"name": script.name, "capabilities": capabilities},
    )
    await session.commit()
    return UserScriptDetail.model_validate(script)


@router.get("/{script_id}", response_model=UserScriptDetail)
async def get_script(script_id: str, session: SessionDep) -> UserScriptDetail:
    script = await session.get(UserScript, script_id)
    if script is None:
        raise _not_found("script", script_id)
    return UserScriptDetail.model_validate(script)


@router.post(
    "/{script_id}/runs",
    response_model=UserScriptRunRead,
    status_code=status.HTTP_201_CREATED,
)
async def preview_run(
    script_id: str, payload: UserScriptRunCreate, session: SessionDep
) -> UserScriptRunRead:
    """実行内容を確定してdigestを返す。承認されるまで実行しない。"""
    settings = get_settings()
    _require_enabled(settings)
    script = await session.get(UserScript, script_id)
    if script is None:
        raise _not_found("script", script_id)
    violations = _capability_violations(script.capabilities, settings)
    if violations:
        raise ApiError(
            "CAPABILITY_EXCEEDS_LIMIT",
            "scriptの能力manifestが現在の設定の上限を超えています。",
            status_code=status.HTTP_409_CONFLICT,
            details={"fields": violations},
        )
    inputs: list[dict[str, Any]] = []
    for index, artifact_id in enumerate(payload.input_artifact_ids):
        artifact = await session.get(Artifact, artifact_id)
        if artifact is None or artifact.availability != "complete":
            raise _not_found("Artifact", artifact_id)
        try:
            resolve_artifact(artifact.relative_path)
        except StorageError as error:
            raise ApiError(
                "ARTIFACT_UNAVAILABLE",
                "入力Artifactの実ファイルを読めません。",
                status_code=status.HTTP_409_CONFLICT,
                details={"artifact_id": artifact_id},
            ) from error
        inputs.append(
            {
                "artifact_id": artifact.id,
                "sha256": artifact.sha256,
                "mount_path": _mount_path(index, artifact.relative_path),
            }
        )
    now = _now()
    run = UserScriptRun(
        id=new_id(),
        script_id=script.id,
        script_sha256=script.sha256,
        interpreter=settings.user_scripts_python_path,
        arguments=list(payload.arguments),
        inputs=inputs,
        capabilities=dict(script.capabilities),
        status="pending_approval",
        approval_expires_at=(
            now + timedelta(seconds=settings.user_scripts_approval_ttl_seconds)
        ).isoformat(),
        output_artifact_ids=[],
        created_at=now.isoformat(),
    )
    run.output_destination = script_approval.output_destination(run.id)
    run.digest = script_approval.run_digest(
        _operation(run, script, interpreter=run.interpreter)
    )
    session.add(run)
    _audit(
        session,
        "run.previewed",
        script_id=script.id,
        run_id=run.id,
        digest=run.digest,
        detail={"arguments": run.arguments, "inputs": inputs},
    )
    await session.commit()
    return _run_read(run, script)


@router.get("/runs/{run_id}", response_model=UserScriptRunRead)
async def get_run(run_id: str, session: SessionDep) -> UserScriptRunRead:
    run, script = await _get_run(session, run_id)
    return _run_read(run, script)


async def _reject(
    session: AsyncSession,
    event_type: str,
    run: UserScriptRun,
    rejected: _Rejected,
) -> ApiError:
    """拒否を監査記録へ残してから、応答用のエラーを返す。"""
    # rollbackで属性が失効し、非同期sessionでは読み直せないため先に控える。
    script_id, run_id, digest = run.script_id, run.id, run.digest
    await session.rollback()
    _audit(
        session,
        event_type,
        script_id=script_id,
        run_id=run_id,
        digest=digest,
        detail={"code": rejected.code, "message": rejected.message},
    )
    await session.commit()
    return ApiError(
        rejected.code,
        rejected.message,
        status_code=rejected.status_code,
        details={"run_id": run_id},
    )


@router.post("/runs/{run_id}/approve", response_model=UserScriptRunRead)
async def approve_run(
    run_id: str, payload: UserScriptRunApprove, session: SessionDep
) -> UserScriptRunRead:
    """承認CLIが鍵で署名したtokenを検証して記録する。"""
    settings = get_settings()
    _require_enabled(settings)
    run, script = await _get_run(session, run_id)
    try:
        if run.status != "pending_approval":
            raise _Rejected(
                "RUN_NOT_PENDING",
                "承認待ちのrunではありません。",
                status.HTTP_409_CONFLICT,
            )
        if _is_expired(run.approval_expires_at, _now()):
            raise _Rejected(
                "APPROVAL_EXPIRED",
                "承認の期限が切れています。previewからやり直してください。",
                status.HTTP_409_CONFLICT,
            )
        digest = script_approval.run_digest(
            _operation(run, script, interpreter=run.interpreter)
        )
        if digest != run.digest:
            raise _Rejected(
                "APPROVAL_STALE",
                "runの内容が変わっています。previewからやり直してください。",
                status.HTTP_409_CONFLICT,
            )
        key = script_approval.load_key(settings.user_script_approval_key_path)
        if not script_approval.verify_token(
            key,
            payload.approval_token,
            run_id=run.id,
            digest=run.digest,
            expires_at=run.approval_expires_at,
        ):
            raise _Rejected(
                "APPROVAL_INVALID",
                "承認tokenが正しくありません。",
                status.HTTP_403_FORBIDDEN,
            )
    except script_approval.ApprovalKeyError as error:
        raise await _reject(
            session,
            "run.approval_rejected",
            run,
            _Rejected(
                "APPROVAL_KEY_UNAVAILABLE",
                str(error),
                status.HTTP_503_SERVICE_UNAVAILABLE,
            ),
        ) from error
    except _Rejected as rejected:
        raise await _reject(
            session, "run.approval_rejected", run, rejected
        ) from rejected
    approved_at = _now().isoformat()
    result = await session.execute(
        update(UserScriptRun)
        .where(UserScriptRun.id == run.id, UserScriptRun.status == "pending_approval")
        .values(
            status="approved",
            approval_token=payload.approval_token,
            approved_at=approved_at,
        )
    )
    if result.rowcount != 1:
        await session.rollback()
        raise ApiError(
            "RUN_NOT_PENDING",
            "承認待ちのrunではありません。",
            status_code=status.HTTP_409_CONFLICT,
        )
    _audit(
        session, "run.approved", script_id=script.id, run_id=run.id, digest=run.digest
    )
    await session.commit()
    await session.refresh(run)
    return _run_read(run, script)


def _make_private_dir(path: Path) -> None:
    path.mkdir(mode=0o700, parents=False)


def _remove_tree(path: Path) -> None:
    """作業ディレクトリを消す。script が権限を落としたディレクトリも消せるようにする。"""
    if not path.exists():
        return
    for root, dirs, _ in os.walk(path, followlinks=False):
        for name in dirs:
            target = Path(root) / name
            if not target.is_symlink():
                try:
                    target.chmod(0o700)
                except OSError:
                    pass
    try:
        shutil.rmtree(path)
    except OSError:
        logger.warning("scriptの作業ディレクトリを消せません: %s", path, exc_info=True)


def _file_sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _prepare_staging(
    staging: Path,
    source: str,
    inputs: list[dict[str, Any]],
    relative_paths: dict[str, str],
) -> tuple[Path, Path, list[script_sandbox.Mount], list[dict[str, Any]]]:
    """runの作業ディレクトリへscriptと入力を複製する。

    入力は複製してから検証し、検証した複製をsandboxへ見せる。検証と使用の間に元の
    ファイルを差し替えられても、実行する内容は変わらない。
    """
    _remove_tree(staging)
    staging.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    _make_private_dir(staging)
    script_path = staging / "script.py"
    script_path.write_bytes(source.encode("utf-8"))
    script_path.chmod(0o400)
    inputs_dir = staging / "inputs"
    output_dir = staging / "output"
    _make_private_dir(inputs_dir)
    _make_private_dir(output_dir)
    mounts: list[script_sandbox.Mount] = []
    verified: list[dict[str, Any]] = []
    for item in inputs:
        source_path = resolve_artifact(relative_paths[item["artifact_id"]])
        copy = inputs_dir / Path(item["mount_path"]).name
        shutil.copyfile(source_path, copy, follow_symlinks=False)
        copy.chmod(0o400)
        mounts.append(
            script_sandbox.Mount(host_path=copy, sandbox_path=item["mount_path"])
        )
        verified.append({**item, "sha256": _file_sha256(copy)})
    return script_path, output_dir, mounts, verified


@router.post(
    "/runs/{run_id}/execute",
    response_model=UserScriptRunRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def execute_run(run_id: str, session: SessionDep) -> UserScriptRunRead:
    """承認済みのrunを、digestと承認を検証し直してからsandboxで起動する。"""
    settings = get_settings()
    _require_enabled(settings)
    run, script = await _get_run(session, run_id)
    if run.status != "approved":
        raise ApiError(
            "RUN_NOT_APPROVED",
            "承認済みのrunではありません。",
            status_code=status.HTTP_409_CONFLICT,
            details={"status": run.status},
        )
    if _active:
        raise ApiError(
            "RUN_BUSY",
            "別のscriptを実行中です。終了してから実行してください。",
            status_code=status.HTTP_409_CONFLICT,
        )
    # 検証中のawaitで別の要求が割り込まないよう、先に枠を押さえる。
    cancel = asyncio.Event()
    _active[run.id] = cancel
    staging = settings.user_script_runs_root / run.id
    try:
        try:
            command, output_dir, tools, limits = await _verify_and_prepare(
                session, run, script, settings, staging
            )
        except script_sandbox.SandboxUnavailable as error:
            raise _Rejected(
                "SANDBOX_UNAVAILABLE", str(error), status.HTTP_503_SERVICE_UNAVAILABLE
            ) from error
        except script_approval.ApprovalKeyError as error:
            raise _Rejected(
                "APPROVAL_KEY_UNAVAILABLE",
                str(error),
                status.HTTP_503_SERVICE_UNAVAILABLE,
            ) from error
        except (StorageError, OSError) as error:
            raise _Rejected(
                "ARTIFACT_UNAVAILABLE",
                "入力を準備できません。",
                status.HTTP_409_CONFLICT,
            ) from error
    except _Rejected as rejected:
        _active.pop(run.id, None)
        await asyncio.to_thread(_remove_tree, staging)
        raise await _reject(
            session, "run.execute_rejected", run, rejected
        ) from rejected
    except BaseException:
        _active.pop(run.id, None)
        await asyncio.to_thread(_remove_tree, staging)
        raise
    started_at = _now().isoformat()
    result = await session.execute(
        update(UserScriptRun)
        .where(UserScriptRun.id == run.id, UserScriptRun.status == "approved")
        .values(status="running", started_at=started_at)
    )
    if result.rowcount != 1:
        await session.rollback()
        _active.pop(run_id, None)
        await asyncio.to_thread(_remove_tree, staging)
        raise ApiError(
            "RUN_NOT_APPROVED",
            "承認済みのrunではありません。",
            status_code=status.HTTP_409_CONFLICT,
        )
    _audit(
        session,
        "run.started",
        script_id=script.id,
        run_id=run.id,
        digest=run.digest,
        detail={"command": command},
    )
    await session.commit()
    _tasks[run.id] = asyncio.create_task(
        _drive(run.id, tools, limits, command, staging, output_dir, cancel)
    )
    await session.refresh(run)
    return _run_read(run, script)


async def _verify_and_prepare(
    session: AsyncSession,
    run: UserScriptRun,
    script: UserScript,
    settings: Settings,
    staging: Path,
) -> tuple[list[str], Path, script_sandbox.SandboxTools, script_sandbox.Limits]:
    if _is_expired(run.approval_expires_at, _now()):
        raise _Rejected(
            "APPROVAL_EXPIRED",
            "承認の期限が切れています。previewからやり直してください。",
            status.HTTP_409_CONFLICT,
        )
    violations = _capability_violations(script.capabilities, settings)
    if violations or run.capabilities != script.capabilities:
        raise _Rejected(
            "CAPABILITY_EXCEEDS_LIMIT",
            "能力manifestが現在の設定の上限を超えているか、登録時と一致しません。",
            status.HTTP_409_CONFLICT,
        )
    tools = script_sandbox.tools_from_settings(settings)
    limits = _limits(script.capabilities, settings)
    await script_sandbox.probe(
        tools, limits, unit=script_sandbox.unit_name(f"probe-{new_id()}")
    )
    relative_paths: dict[str, str] = {}
    for item in run.inputs:
        artifact = await session.get(Artifact, item["artifact_id"])
        if artifact is None or artifact.availability != "complete":
            raise _Rejected(
                "ARTIFACT_UNAVAILABLE",
                "入力Artifactがありません。",
                status.HTTP_409_CONFLICT,
            )
        relative_paths[artifact.id] = artifact.relative_path
    script_path, output_dir, mounts, verified_inputs = await asyncio.to_thread(
        _prepare_staging, staging, script.source, list(run.inputs), relative_paths
    )
    # 実行する内容そのもの(複製したscriptと入力、現在の設定のinterpreter)から
    # digestを計算し直し、承認したdigestと突き合わせる。
    digest = script_approval.run_digest(
        _operation(
            run,
            script,
            interpreter=settings.user_scripts_python_path,
            inputs=verified_inputs,
        )
    )
    staged_sha = await asyncio.to_thread(_file_sha256, script_path)
    if digest != run.digest or staged_sha != run.script_sha256:
        raise _Rejected(
            "APPROVAL_STALE",
            "承認した内容と実行する内容が一致しません。previewからやり直してください。",
            status.HTTP_409_CONFLICT,
        )
    key = script_approval.load_key(settings.user_script_approval_key_path)
    if not run.approval_token or not script_approval.verify_token(
        key,
        run.approval_token,
        run_id=run.id,
        digest=run.digest,
        expires_at=run.approval_expires_at,
    ):
        raise _Rejected(
            "APPROVAL_INVALID",
            "承認tokenが正しくありません。",
            status.HTTP_403_FORBIDDEN,
        )
    command = script_sandbox.build_command(
        tools,
        limits,
        unit=script_sandbox.unit_name(run.id),
        script=script_path,
        inputs=mounts,
        output_dir=output_dir,
        arguments=list(run.arguments),
    )
    return command, output_dir, tools, limits


class _OutputRejected(Exception):
    def __init__(self, reason: str, details: dict[str, Any]) -> None:
        super().__init__(reason)
        self.reason = reason
        self.details = details


def _read_outputs(
    output_dir: Path, limits: script_sandbox.Limits
) -> tuple[list[tuple[str, bytes]], list[dict[str, str]]]:
    """出力ディレクトリ直下の通常ファイルを読む。

    symlinkは辿らない。リンク数が2以上のファイル、ディレクトリ、その他の種類は取り込まず
    記録だけ残す。sandboxの外のファイルを出力に見せかけて読ませないためである。
    """
    used, entries = script_sandbox.output_usage(
        output_dir, byte_limit=limits.output_bytes, file_limit=limits.output_files
    )
    if used > limits.output_bytes or entries > limits.output_files:
        raise _OutputRejected(
            "output_limit", {"output_bytes": used, "output_entries": entries}
        )
    files: list[tuple[str, bytes]] = []
    skipped: list[dict[str, str]] = []
    total = 0
    with os.scandir(output_dir) as iterator:
        items = sorted(iterator, key=lambda entry: entry.name)
    for entry in items:
        info = entry.stat(follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode):
            skipped.append({"name": entry.name, "reason": "not_regular_file"})
            continue
        if info.st_nlink != 1:
            skipped.append({"name": entry.name, "reason": "hard_link"})
            continue
        fd = os.open(entry.path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode) or opened.st_ino != info.st_ino:
                skipped.append({"name": entry.name, "reason": "changed"})
                continue
            room = limits.output_bytes - total
            with os.fdopen(os.dup(fd), "rb") as stream:
                data = stream.read(room + 1)
        finally:
            os.close(fd)
        total += len(data)
        if total > limits.output_bytes:
            raise _OutputRejected("output_limit", {"output_bytes": total})
        files.append((entry.name, data))
    return files, skipped


def _artifact_kind(media_type: str) -> str:
    return "image" if media_type.startswith("image/") else "log"


async def _collect_outputs(
    session: AsyncSession, run_id: str, output_dir: Path, limits: script_sandbox.Limits
) -> tuple[list[str], list[dict[str, str]]]:
    files, skipped = await asyncio.to_thread(_read_outputs, output_dir, limits)
    stored_paths: list[str] = []
    artifact_ids: list[str] = []
    try:
        for name, data in files:
            stored = await asyncio.to_thread(
                write_artifact, f"script-run-{run_id}", name, data
            )
            stored_paths.append(stored.relative_path)
            # 画像はmagic bytesで判定できたものだけを画像として扱う。それ以外は拡張子に
            # 関わらずoctet-streamとし、ブラウザにHTMLやSVGとして解釈させない。
            media_type = (
                detect_image_media_type(data[:32]) or "application/octet-stream"
            )
            artifact = Artifact(
                id=new_id(),
                job_id=None,
                kind=_artifact_kind(media_type),
                relative_path=stored.relative_path,
                sha256=stored.sha256,
                byte_size=stored.byte_size,
                media_type=media_type,
                availability="complete",
                created_at=_now().isoformat(),
            )
            session.add(artifact)
            artifact_ids.append(artifact.id)
        await session.flush()
    except BaseException:
        await asyncio.to_thread(discard_artifacts, stored_paths)
        raise
    return artifact_ids, skipped


def _decode(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")


async def _drive(
    run_id: str,
    tools: script_sandbox.SandboxTools,
    limits: script_sandbox.Limits,
    command: list[str],
    staging: Path,
    output_dir: Path,
    cancel: asyncio.Event,
) -> None:
    """sandboxを見張り、終了後に結果とArtifactを記録する。"""
    factory = get_session_factory()
    try:
        outcome = await script_sandbox.run(
            tools,
            limits,
            unit=script_sandbox.unit_name(run_id),
            command=command,
            output_dir=output_dir,
            cancel=cancel,
        )
        async with factory() as session:
            run = await session.get(UserScriptRun, run_id)
            assert run is not None
            artifact_ids: list[str] = []
            detail: dict[str, Any] = {
                "exit_code": outcome.exit_code,
                "duration_seconds": round(outcome.duration_seconds, 3),
                **outcome.details,
            }
            reason = outcome.stop_reason
            if reason is None and outcome.exit_code != 0:
                reason = "nonzero_exit"
            if reason is None:
                try:
                    artifact_ids, skipped = await _collect_outputs(
                        session, run_id, output_dir, limits
                    )
                    detail["skipped_outputs"] = skipped
                except _OutputRejected as rejected:
                    reason = rejected.reason
                    detail.update(rejected.details)
            final_status = (
                "succeeded"
                if reason is None
                else "cancelled"
                if reason == "cancelled"
                else "failed"
            )
            run.status = final_status
            run.finished_at = _now().isoformat()
            run.exit_code = outcome.exit_code
            run.failure_reason = reason
            run.stdout = _decode(outcome.stdout)
            run.stderr = _decode(outcome.stderr)
            run.output_artifact_ids = artifact_ids
            detail["status"] = final_status
            detail["failure_reason"] = reason
            detail["output_artifact_ids"] = artifact_ids
            _audit(
                session,
                "run.finished",
                script_id=run.script_id,
                run_id=run_id,
                digest=run.digest,
                detail=detail,
            )
            await session.commit()
    except Exception:
        logger.exception("scriptの実行を記録できませんでした: %s", run_id)
        await _mark_failed(run_id, "internal_error")
    finally:
        _active.pop(run_id, None)
        _tasks.pop(run_id, None)
        await asyncio.to_thread(_remove_tree, staging)


async def _mark_failed(run_id: str, reason: str) -> None:
    async with get_session_factory()() as session:
        run = await session.get(UserScriptRun, run_id)
        if run is None or run.status in TERMINAL_RUN_STATUSES:
            return
        run.status = "failed"
        run.failure_reason = reason
        run.finished_at = _now().isoformat()
        _audit(
            session,
            "run.finished",
            script_id=run.script_id,
            run_id=run_id,
            digest=run.digest,
            detail={"status": "failed", "failure_reason": reason},
        )
        await session.commit()


@router.post("/runs/{run_id}/cancel", response_model=UserScriptRunRead)
async def cancel_run(run_id: str, session: SessionDep) -> UserScriptRunRead:
    """未実行のrunは取り消し、実行中のrunは止める。止めるだけなので無効時も受け付ける。"""
    run, script = await _get_run(session, run_id)
    if run.status in ("pending_approval", "approved"):
        result = await session.execute(
            update(UserScriptRun)
            .where(UserScriptRun.id == run.id, UserScriptRun.status == run.status)
            .values(status="cancelled", finished_at=_now().isoformat())
        )
        if result.rowcount == 1:
            _audit(
                session,
                "run.cancelled",
                script_id=script.id,
                run_id=run.id,
                digest=run.digest,
            )
            await session.commit()
            await session.refresh(run)
            return _run_read(run, script)
        await session.rollback()
        await session.refresh(run)
    if run.status == "running":
        event = _active.get(run.id)
        if event is not None:
            event.set()
            _audit(
                session,
                "run.cancel_requested",
                script_id=script.id,
                run_id=run.id,
                digest=run.digest,
            )
            await session.commit()
            return _run_read(run, script)
    raise ApiError(
        "RUN_NOT_CANCELLABLE",
        "取り消せる状態のrunではありません。",
        status_code=status.HTTP_409_CONFLICT,
        details={"status": run.status},
    )


async def recover_interrupted_runs(session: AsyncSession) -> int:
    """前回の停止で実行中のまま残ったrunを失敗へ倒す。"""
    rows = (
        await session.scalars(
            select(UserScriptRun).where(UserScriptRun.status == "running")
        )
    ).all()
    now = _now().isoformat()
    for run in rows:
        run.status = "failed"
        run.failure_reason = "interrupted"
        run.finished_at = now
        _audit(
            session,
            "run.finished",
            script_id=run.script_id,
            run_id=run.id,
            digest=run.digest,
            detail={"status": "failed", "failure_reason": "interrupted"},
        )
    await session.commit()
    return len(rows)


def prepare_approval_key(settings: Settings) -> None:
    """機能が有効なら承認鍵を用意する。用意できなければ承認と実行が拒否される。"""
    if not settings.user_scripts_enabled:
        return
    try:
        script_approval.ensure_key(settings.user_script_approval_key_path)
    except (OSError, script_approval.ApprovalKeyError):
        logger.exception("承認鍵を用意できません。承認と実行はすべて拒否されます。")


async def shutdown() -> None:
    """実行中のrunを止め、記録が終わるまで待つ。"""
    for event in list(_active.values()):
        event.set()
    tasks = list(_tasks.values())
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
