"""Artifact storeへの実ファイル保存。

`data_root`配下だけを扱い、DBへは`data_root`基準の相対パスを渡す。パスの組み立ては
このモジュールへ閉じ込め、呼び出し元が絶対パスを持ち回らないようにする。
"""

import errno
import hashlib
import logging
import os
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

ARTIFACTS_DIR_NAME = "artifacts"
INPUTS_DIR_NAME = "inputs"
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


def resolve_artifact(relative_path: str, settings: Settings | None = None) -> Path:
    """DBの相対パスを`data_root`配下の実ファイルへ解決する。

    配信に使うため、symlinkを辿った結果まで含めて`data_root`の外へ出ないことを
    確かめる。存在しない場合もStorageErrorとする。
    """
    settings = settings or get_settings()
    root = settings.data_root.resolve()
    candidate = (root / relative_path).resolve()
    # Artifact storeの外は、`data_root`配下であっても配信しない。DBファイルのような
    # 生成物以外を指すレコードが作られても、ここで止める。
    if not candidate.is_relative_to(settings.artifacts_root.resolve()):
        raise StorageError(f"Artifact storeの外を参照しています: {relative_path}")
    if not candidate.is_relative_to(root):
        raise StorageError(f"保存先の外を参照しています: {relative_path}")
    if not candidate.is_file():
        raise StorageError(f"Artifactの実ファイルがありません: {relative_path}")
    return candidate


def resolve_input(relative_path: str, settings: Settings | None = None) -> Path:
    """Manifestが持つ入力cache参照を`data_root`配下の実ファイルへ解決する。

    再実行前に、記録時と同じ入力素材が残っているかを確かめるために使う。読み出せる
    のは`inputs/`配下だけとし、生成物やデータベースを指す値は拒否する。
    """
    settings = settings or get_settings()
    root = settings.data_root.resolve()
    candidate = (root / relative_path).resolve()
    inputs_root = (settings.data_root / INPUTS_DIR_NAME).resolve()
    if not candidate.is_relative_to(inputs_root):
        raise StorageError(f"入力cacheの外を参照しています: {relative_path}")
    if not candidate.is_file():
        raise StorageError(f"入力cacheの実ファイルがありません: {relative_path}")
    return candidate


def artifact_destination_dir(relative_path: str) -> str:
    """`data_root`基準の相対パスから、`artifacts_root`基準の親ディレクトリを返す。

    `move_artifact`へ渡せる形で移動元のディレクトリを取り出す。移動に失敗した後始末
    で元の場所へ戻すときに使い、呼び出し元がパスを組み立てずに済むようにする。
    """
    parts = PurePosixPath(relative_path.replace("\\", "/")).parent.parts
    if not parts or parts[0] != ARTIFACTS_DIR_NAME:
        raise StorageError(f"Artifact storeの外を参照しています: {relative_path}")
    return PurePosixPath(*parts[1:]).as_posix() if len(parts) > 1 else "."


def move_artifact(
    relative_path: str, destination_dir: str, settings: Settings | None = None
) -> str:
    """Artifactの実ファイルを`artifacts_root`配下の別ディレクトリへ移し、相対パスを返す。

    移動先は`artifacts_root`配下に限る。`data_root`配下であっても`artifacts/`の外へ
    出すと`resolve_artifact`が配信を拒み、移動したArtifactを参照できなくなるためで
    ある。絶対パス、`..`、symlink経由の脱出はいずれも拒否する。

    ファイル名は移動元のものを維持する。移動先の名前を指定できる形にすると、拡張子を
    偽装したファイルを配置できてしまう。移動先に同名ファイルがある場合も拒否し、既存
    のArtifactを上書きしない。配置はまずhard linkで名前を取り、取れた場合だけ移動元を
    消す。存在確認と`replace`の2段では、確認を通った2つの移動が同じ名前へ重なったとき
    に後勝ちで上書きしてしまう。hard linkを作れないファイルシステムでは、存在確認の
    うえで`replace`へ落とす。

    既に移動先にある場合は何もせず現在の相対パスを返す。狙いどおりの状態になっている
    ことを結果とし、再実行でファイルを二重に動かさない。linkを張った後に移動元を消す
    前で中断した場合は、移動元と移動先が同じ実体を指す。その状態は残りの手順だけを
    進めて移動済みとして扱う。

    移動元のディレクトリが空になっても消さない。他のArtifactがそのディレクトリを参照
    しているかを、この関数からは判定できないためである。
    """
    settings = settings or get_settings()
    root = settings.data_root.resolve()
    source = resolve_artifact(relative_path, settings)
    directory = _resolve_destination_dir(destination_dir, settings)
    target = directory / source.name
    if target == source:
        return _artifact_relative_path(source, root)
    try:
        taken = target.exists() or target.is_symlink()
    except OSError as error:
        # `Path.exists`は権限エラーをそのまま投げる。移動先を確かめられないことも
        # 他の異常系と同じ形で失敗として残す。
        raise StorageError(f"移動先を確かめられません: {destination_dir}") from error
    if taken:
        if _is_same_file(source, target):
            # hard linkを張った後、移動元を消す前に中断した。残りの手順だけ進める。
            # 同じ実体を指しているため、ここで移動元を消しても内容は失われない。
            try:
                source.unlink()
            except OSError as error:
                raise StorageError(f"移動元を消せません: {relative_path}") from error
            return _artifact_relative_path(target, root)
        raise StorageError(f"移動先に同名のファイルがあります: {target.name}")
    try:
        directory.mkdir(parents=True, exist_ok=True)
        _place(source, target)
    except FileExistsError as error:
        raise StorageError(
            f"移動先に同名のファイルがあります: {target.name}"
        ) from error
    except OSError as error:
        raise StorageError(f"Artifactを移動できません: {relative_path}") from error
    return _artifact_relative_path(target, root)


def _is_same_file(source: Path, target: Path) -> bool:
    """2つのパスが同じ実体を指すか。hard linkを張った直後の中断を見分けるのに使う。"""
    try:
        return target.is_file() and not target.is_symlink() and target.samefile(source)
    except OSError:
        return False


#: hard linkを作れないことを表すerrno。これ以外の失敗は権限や故障の類とみなす。
_LINK_UNSUPPORTED_ERRNOS = frozenset(
    {errno.EXDEV, errno.EPERM, errno.EOPNOTSUPP, errno.ENOSYS, errno.EMLINK}
)


def _place(source: Path, target: Path) -> None:
    """移動元を移動先の名前へ置く。既に同じ名前があれば`FileExistsError`とする。

    `os.link`は名前が埋まっていれば失敗するため、確認と配置を1手で行える。hard linkを
    作れないファイルシステム(FATや一部のマウント)でだけ`replace`へ落とす。落とした先は
    後勝ちの上書きになるため、直前にもう一度名前が空いていることを確かめる。隙間は残る
    が、hard linkを使えない環境に限られる。

    linkを張った後に移動元を消す前で中断すると、両方に同じ実体が残る。その状態は
    `move_artifact`が`_is_same_file`で見分けて後始末する。
    """
    try:
        os.link(source, target)
    except FileExistsError:
        raise
    except OSError as error:
        if error.errno not in _LINK_UNSUPPORTED_ERRNOS:
            raise
        # どの環境でfallbackへ落ちたかを残す。上書きの隙が残るのはこの経路だけで、
        # 競合を疑うときに最初に見る手掛かりになる。
        logger.warning(
            "hard linkを作れないため上書き確認つきの移動へ切り替えます。errno=%s path=%s",
            error.errno,
            target,
        )
        if target.exists() or target.is_symlink():
            raise FileExistsError(str(target)) from error
        source.replace(target)
        return
    source.unlink()


def adopt_moved_artifact(
    relative_path: str,
    destination_dir: str,
    sha256: str,
    settings: Settings | None = None,
) -> str | None:
    """移動済みの実ファイルを見つけ、その相対パスを返す。無ければNoneを返す。

    ファイルを動かしてからDBを更新するまでの間にプロセスが落ちると、DBは移動元を
    指したまま実ファイルだけが移動先にある状態が残る。そのままではArtifactを配信
    できず、stepを再実行しても移動元が無いため失敗し続ける。

    移動元が消えていて、移動先に記録と同じ内容のファイルがある場合だけ、その
    ファイルを移動の結果として扱う。同じ名前というだけでは別のファイルを掴みうる
    ため、Artifactへ記録したSHA-256の一致まで確かめる。
    """
    settings = settings or get_settings()
    root = settings.data_root.resolve()
    name = PurePosixPath(relative_path.replace("\\", "/")).name
    if not name:
        return None
    try:
        directory = _resolve_destination_dir(destination_dir, settings)
    except StorageError:
        return None
    if (root / relative_path).exists():
        return None
    target = directory / name
    if target.is_symlink() or not target.is_file():
        return None
    try:
        if _file_sha256(target) != sha256:
            return None
    except OSError:
        return None
    return _artifact_relative_path(target, root)


def _file_sha256(path: Path) -> str:
    """実ファイルのSHA-256。Artifactの記録と同じ内容かを確かめるのに使う。"""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _resolve_destination_dir(destination_dir: str, settings: Settings) -> Path:
    """移動先ディレクトリを`artifacts_root`配下の実パスへ解決する。

    `resolve()`で`..`とsymlinkを畳んでから範囲を判定する。文字列のまま`..`を弾く形に
    すると、symlinkを経由した脱出を止められない。

    パスとして組み立てられない値もStorageErrorへ揃える。NUL文字のように`Path`が
    ValueErrorを投げる入力がProviderの出力から届きうるため、未処理の例外で500を
    返さず、拒否した理由を履歴へ残せる形にする。
    """
    candidate = destination_dir.replace("\\", "/").strip().strip("/")
    if not candidate:
        raise StorageError("移動先ディレクトリが指定されていません。")
    artifacts_root = settings.artifacts_root.resolve()
    try:
        if Path(destination_dir).is_absolute():
            raise StorageError(f"移動先に絶対パスは指定できません: {destination_dir}")
        directory = (artifacts_root / candidate).resolve()
        is_inside = directory.is_relative_to(artifacts_root)
    except (ValueError, OSError) as error:
        raise StorageError(
            f"移動先として扱えないパスです: {destination_dir!r}"
        ) from error
    if not is_inside:
        raise StorageError(f"Artifact storeの外へは移動できません: {destination_dir}")
    return directory


def _artifact_relative_path(path: Path, root: Path) -> str:
    """`data_root`基準の相対パスへ戻す。DBへ渡すのはこの形だけとする。"""
    try:
        return path.relative_to(root).as_posix()
    except ValueError as error:
        raise StorageError(f"保存先の外を参照しています: {path.name}") from error


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


def write_input(
    file_name: str, data: bytes, settings: Settings | None = None
) -> StoredFile:
    """`inputs/<sha256>/<file_name>`へ利用者素材を取り込む。

    内容のSHA-256をディレクトリ名にする。同じ内容を何度取り込んでも同じ場所を指し、
    Manifestへ記録した参照が別の内容を指すことがない。既に同じ内容が置かれている
    場合は書き直さない。
    """
    settings = settings or get_settings()
    digest = hashlib.sha256(data).hexdigest()
    name = _safe_name(file_name)
    directory = settings.data_root / INPUTS_DIR_NAME / digest
    try:
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / name
        if not path.exists():
            path.write_bytes(data)
    except OSError as error:
        raise StorageError(f"入力cacheへ保存できません: {file_name}") from error
    return StoredFile(
        relative_path=f"{INPUTS_DIR_NAME}/{digest}/{name}",
        sha256=digest,
        byte_size=len(data),
    )


def discard_artifacts(
    relative_paths: list[str], settings: Settings | None = None
) -> None:
    """どのレコードからも参照されなくなったファイルを消す。

    保存には成功したがDBへ記録できなかった場合に使う。記録が無いファイルは再実行で
    連番違いが増えるだけで、残しても診断に使えないため消す。空になった
    `artifacts/<job-id>/`も片付ける。
    """
    settings = settings or get_settings()
    directories: set[Path] = set()
    for relative_path in relative_paths:
        path = settings.data_root / relative_path
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Artifactを削除できません: %s", relative_path)
            continue
        directories.add(path.parent)
    for directory in directories:
        try:
            directory.rmdir()
        except OSError:
            # 他のArtifactが残っていれば消さない。空でないrmdirの失敗は想定内。
            pass


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
