"""Artifact storeへの実ファイル保存。

`data_root`配下だけを扱い、DBへは`data_root`基準の相対パスを渡す。パスの組み立ては
このモジュールへ閉じ込め、呼び出し元が絶対パスを持ち回らないようにする。
"""

import hashlib
from dataclasses import dataclass
from pathlib import Path

from mycomfyui_api.settings import Settings, get_settings

ARTIFACTS_DIR_NAME = "artifacts"
WORKFLOW_FILE_NAME = "workflow.json"


class StorageError(RuntimeError):
    """`data_root`配下への書き込みに失敗した。"""


@dataclass(frozen=True)
class StoredFile:
    """保存済みファイルのDB記録用メタデータ。"""

    relative_path: str
    sha256: str
    byte_size: int


def _safe_name(name: str) -> str:
    """Backendが返したファイル名から、ディレクトリを跨げる要素を取り除く。

    ComfyUIの出力ファイル名は外部由来のため、`..`や区切り文字をそのまま信用しない。
    """
    candidate = name.replace("\\", "/").split("/")[-1].strip()
    if not candidate or candidate in (".", ".."):
        raise StorageError(f"保存できないファイル名です: {name!r}")
    return candidate


def job_directory(job_id: str, settings: Settings | None = None) -> Path:
    settings = settings or get_settings()
    return settings.artifacts_root / _safe_name(job_id)


def write_artifact(
    job_id: str, file_name: str, data: bytes, settings: Settings | None = None
) -> StoredFile:
    """`artifacts/<job-id>/<file_name>`へ書き出し、DB記録用のメタデータを返す。

    同名ファイルが既にある場合は連番を付けて別ファイルにする。設計上、保存済みの
    Artifactは置換せず、再出力は別Artifactとして記録するため。
    """
    settings = settings or get_settings()
    directory = job_directory(job_id, settings)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        path = _unique_path(directory, _safe_name(file_name))
        path.write_bytes(data)
    except OSError as error:
        raise StorageError(f"Artifactを保存できません: {file_name}") from error
    relative = f"{ARTIFACTS_DIR_NAME}/{_safe_name(job_id)}/{path.name}"
    return StoredFile(
        relative_path=relative,
        sha256=hashlib.sha256(data).hexdigest(),
        byte_size=len(data),
    )


def _unique_path(directory: Path, file_name: str) -> Path:
    candidate = directory / file_name
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    suffix = candidate.suffix
    for index in range(1, 1000):
        candidate = directory / f"{stem}_{index}{suffix}"
        if not candidate.exists():
            return candidate
    raise StorageError(f"保存先の空き名を決められません: {file_name}")
