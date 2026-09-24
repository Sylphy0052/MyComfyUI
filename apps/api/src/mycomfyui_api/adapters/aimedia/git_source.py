"""novel-writerのgitリポジトリを参照APIの形で返す参照元。

上流の参照API (novel-writer#17) が無い間、`tools/ai-media/projects/<project>/`の実データを
直接読む。読むのは設定したrefが指すcommitの内容だけで、working treeは見ない。revisionは
そのcommit、sha256はblobの内容から求めるため、画面に出る参照は常にgitの値と一致する。

作品正本を書き換えないよう、gitは読取り専用のコマンドだけを使う。fetchもしないため、
`origin/main`を最新にするのは利用者がnovel-writer側で行う。
"""

import asyncio
import hashlib
import json
import logging
import os
import posixpath
import re
import subprocess
import threading
from pathlib import Path
from typing import Any

import yaml

from ...provenance import ReferenceError, canon_id, immutable_reference
from .client import AiMediaUnavailable, FixtureReferenceSource, _validated

logger = logging.getLogger(__name__)

#: git 1回の上限。数十ファイルを読むだけなので、これを超えるならリポジトリ側の異常とみなす。
GIT_TIMEOUT_SECONDS = 30.0

#: 1ファイルの上限。実データは大きくても数KBで、これを超えるblobは読まずに参照を読めないものとする。
MAX_BLOB_BYTES = 1024 * 1024

#: Scene/Shotの応答に付けるschemaの名前。`tools/ai-media/schema/<name>.schema.json`を指す。
SCHEMA_NAMES = ("scene", "shot")

_GITHUB_REMOTE = re.compile(
    r"^(?:git@github\.com:|ssh://git@github\.com/|https://github\.com/)"
    r"(?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?/?$"
)


class _NoAliasLoader(yaml.SafeLoader):
    """aliasを拒むloader。aliasはJSONへ直すときに展開され、小さなyamlでも膨大な応答になりうる。"""

    def compose_node(self, parent: Any, index: Any) -> Any:
        if self.check_event(yaml.AliasEvent):
            raise yaml.YAMLError("yamlのaliasは使えません")
        return super().compose_node(parent, index)


class GitRepositoryReferenceSource:
    """gitリポジトリの1つのrefから参照fixtureと同じ形の文書を組み立てて返す。

    refが別のcommitを指したら組み立て直す。応答はcommitごとに作った
    `FixtureReferenceSource`へ任せる。
    """

    def __init__(
        self,
        root: Path,
        *,
        ref: str = "origin/main",
        source_locator: str | None = None,
        projects_dir: str = "tools/ai-media/projects",
    ) -> None:
        # `-`始まりはgitにoptionとして解釈される。refは設定値だが、ここで弾いておく。
        if not ref or ref.startswith("-"):
            raise AiMediaUnavailable(f"参照するrefが不正です: {ref!r}")
        self._root = root
        self._ref = ref
        self._projects_dir = projects_dir.strip("/")
        self._lock = threading.Lock()
        self._cached: tuple[str, FixtureReferenceSource] | None = None
        self._locator = source_locator or _origin_locator(root)
        # 読めない設定は起動時に失敗させる。同梱fixtureの差し替えと同じ扱い。
        self._current()

    async def list_projects(self) -> dict[str, Any]:
        return await (await self._source()).list_projects()

    async def get_project(self, project_id: str) -> dict[str, Any]:
        return await (await self._source()).get_project(project_id)

    async def list_scenes(self, project_id: str) -> dict[str, Any]:
        return await (await self._source()).list_scenes(project_id)

    async def get_scene(self, project_id: str, scene_id: str) -> dict[str, Any]:
        return await (await self._source()).get_scene(project_id, scene_id)

    async def list_shots(self, project_id: str, scene_id: str) -> dict[str, Any]:
        return await (await self._source()).list_shots(project_id, scene_id)

    async def get_shot(
        self, project_id: str, scene_id: str, shot_id: str
    ) -> dict[str, Any]:
        return await (await self._source()).get_shot(project_id, scene_id, shot_id)

    async def list_canon(self, project_id: str) -> dict[str, Any]:
        return await (await self._source()).list_canon(project_id)

    async def get_canon(self, project_id: str, canon_id: str) -> dict[str, Any]:
        return await (await self._source()).get_canon(project_id, canon_id)

    async def aclose(self) -> None:
        return None

    async def _source(self) -> FixtureReferenceSource:
        # gitの呼出しは同期処理のため、イベントループを止めないよう別threadで行う。
        return await asyncio.to_thread(self._current)

    def _current(self) -> FixtureReferenceSource:
        """refが今指すcommitの文書を返す。commitが変わったときだけ組み立て直す。

        commitが変わらない間は、rev-parseだけでロックを取らずに返す。変わったときは
        組み立てをロックで直列にし、待っていた要求は組み立て済みの文書を受け取る。
        """
        cached = self._cached
        if cached is not None and cached[0] == self._revision():
            return cached[1]
        with self._lock:
            # 待つ間に別の要求が組み立てているか、refがさらに進んでいることがある。
            # ロックを取ってから引き直し、古いcommitで最新の文書を上書きしない。
            revision = self._revision()
            cached = self._cached
            if cached is not None and cached[0] == revision:
                return cached[1]
            document = _validated(self._build(revision), self._root)
            source = FixtureReferenceSource(document=document)
            self._cached = (revision, source)
            logger.info(
                "gitリポジトリから参照データを組み立てました。root=%s ref=%s revision=%s",
                self._root,
                self._ref,
                revision,
            )
            return source

    def _revision(self) -> str:
        return (
            self._git(
                "rev-parse",
                "--verify",
                "--end-of-options",
                f"{self._ref}^{{commit}}",
            )
            .decode()
            .strip()
        )

    def _build(self, revision: str) -> dict[str, Any]:
        try:
            return _DocumentBuilder(self, revision).build()
        # ValueErrorはUTF-8でないblobと、cat-fileの出力が想定の形でないときに出る。
        except (
            KeyError,
            TypeError,
            AttributeError,
            ValueError,
            yaml.YAMLError,
        ) as error:
            raise AiMediaUnavailable(
                f"参照データの形式が想定外です: {self._root} ({revision[:8]}): {error!r}"
            ) from error

    def _git(self, *args: str, stdin: bytes | None = None) -> bytes:
        # GIT_OPTIONAL_LOCKS=0で、読取り系コマンドでもindexを書き換えないようにする。
        environment = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}
        try:
            completed = subprocess.run(
                ["git", "-C", str(self._root), *args],
                input=stdin,
                capture_output=True,
                check=True,
                env=environment,
                timeout=GIT_TIMEOUT_SECONDS,
            )
        except (OSError, subprocess.SubprocessError) as error:
            detail = ""
            if isinstance(error, subprocess.CalledProcessError):
                detail = error.stderr.decode(errors="replace").strip()
            raise AiMediaUnavailable(
                f"gitリポジトリを読めません: {self._root} git {args[0]} {detail}"
            ) from error
        return completed.stdout

    def _blobs(self, revision: str, paths: list[str]) -> dict[str, bytes | None]:
        """pathごとのblobの内容。commitに無いpathは`None`にする。"""
        for path in paths:
            _require_repository_path(path)
        wanted = [path for path in dict.fromkeys(paths) if "\n" not in path]
        if not wanted:
            return {}
        request = "".join(f"{revision}:{path}\n" for path in wanted).encode()
        # 内容を取る前に大きさだけを見て、上限を超えるblobがあれば読まない。
        checks = self._git("cat-file", "--batch-check", stdin=request).splitlines()
        for path, line in zip(wanted, checks, strict=True):
            header = line.decode().split()
            if len(header) == 3 and int(header[2]) > MAX_BLOB_BYTES:
                raise AiMediaUnavailable(
                    f"参照データが大きすぎます: {path} ({header[2]} bytes)"
                )
        output = self._git("cat-file", "--batch", stdin=request)
        blobs: dict[str, bytes | None] = {}
        offset = 0
        for path in wanted:
            end = output.index(b"\n", offset)
            header = output[offset:end].decode().split()
            offset = end + 1
            if len(header) != 3 or header[1] != "blob":
                blobs[path] = None
                continue
            size = int(header[2])
            blobs[path] = output[offset : offset + size]
            # 内容の後ろに改行が1つ付く。
            offset += size + 1
        return blobs


class _DocumentBuilder:
    """1つのcommitから、同梱fixtureと同じ6キーの文書を組み立てる。"""

    def __init__(self, source: GitRepositoryReferenceSource, revision: str) -> None:
        self._source = source
        self._revision = revision
        self._blobs: dict[str, bytes | None] = {}
        self._excluded: set[str] = set()
        self._parsed: dict[str, dict[str, Any]] = {}

    def build(self) -> dict[str, Any]:
        projects_dir = self._source._projects_dir
        names = self._source._git(
            "ls-tree", "-r", "--name-only", "-z", self._revision, "--", projects_dir
        ).decode()
        files = [name for name in names.split("\0") if name]
        project_ids = sorted(
            {
                name[len(projects_dir) + 1 :].split("/", 1)[0]
                for name in files
                if name.startswith(projects_dir + "/")
            }
        )
        schema_dir = posixpath.join(posixpath.dirname(projects_dir), "schema")
        schema_paths = {
            name: f"{schema_dir}/{name}.schema.json" for name in SCHEMA_NAMES
        }
        yaml_files = [name for name in files if name.endswith(".yaml")]
        self._load([*yaml_files, *schema_paths.values()])
        # 参照先の実体はScene/Shotを読むまで分からない。本文を読んだ後にまとめて取る。
        self._load(self._declared_paths(project_ids, files))
        self._schemas = {
            name: self._required(path) for name, path in schema_paths.items()
        }

        document: dict[str, Any] = {
            "projects": [],
            "scenes": {},
            "scene_envelopes": {},
            "shots": {},
            "shot_envelopes": {},
            "canon": {},
        }
        for project_id in project_ids:
            self._add_project(document, project_id, files)
        if self._excluded:
            logger.warning(
                "参照先がリポジトリ(%s)に無いため、Canonと参照から除外しました: %s",
                self._revision[:8],
                ", ".join(sorted(self._excluded)),
            )
        return document

    def _add_project(
        self, document: dict[str, Any], project_id: str, files: list[str]
    ) -> None:
        base = f"{self._source._projects_dir}/{project_id}"
        canon: dict[str, dict[str, Any]] = {}
        scenes: list[dict[str, Any]] = []
        for path in _yaml_files(files, f"{base}/scenes/"):
            scene = self._yaml(path)
            scene_id = scene["id"]
            declared = _canon_refs(scene, "")
            location = scene.get("location")
            if location:
                location_refs = _canon_refs(location, "/location")
                declared += location_refs
                self._add_canon(
                    canon, "location", location["display_name"], location_refs
                )
            for index, character in enumerate(scene.get("characters", [])):
                character_refs = _canon_refs(character, f"/characters/{index}")
                declared += character_refs
                self._add_canon(
                    canon, "character", character["display_name"], character_refs
                )
            document["scene_envelopes"][scene_id] = self._envelope(
                "scene", scene, path, declared
            )
            shot_ids = scene.get("shots", [])
            scenes.append(
                {
                    "id": scene_id,
                    "project_id": project_id,
                    "sequence": scene["sequence"],
                    "summary": scene["summary"],
                    "shot_count": len(shot_ids),
                    "reference": self._required(path),
                }
            )
            shots: list[dict[str, Any]] = []
            for shot_id in shot_ids:
                shot_path = f"{base}/shots/{shot_id}.yaml"
                shot = self._yaml(shot_path)
                document["shot_envelopes"][shot_id] = self._envelope(
                    "shot", shot, shot_path, _canon_refs(shot, "")
                )
                shots.append(
                    {
                        "id": shot_id,
                        "scene_id": scene_id,
                        "sequence": shot["sequence"],
                        "duration_sec": shot["duration_sec"],
                        "summary": shot["summary"],
                        "reference": self._required(shot_path),
                    }
                )
            document["shots"][scene_id] = shots

        for path in files:
            parts = path[len(base) + 1 :].split("/")
            if (
                path.startswith(base + "/")
                and parts[:2] == ["canon", "voices"]
                and (len(parts) == 4 and parts[3] == "voice.yaml")
            ):
                reference = self._required(path)
                canon.setdefault(
                    canon_id(reference),
                    {
                        "canon_id": canon_id(reference),
                        "kind": "voice",
                        "display_name": parts[2],
                        "reference": reference,
                    },
                )

        document["projects"].append(
            {
                "id": project_id,
                "title": project_id,
                "source": {
                    "source_locator": self._source._locator,
                    "revision": self._revision,
                },
                "scene_count": len(scenes),
                "canon_count": len(canon),
            }
        )
        document["scenes"][project_id] = scenes
        document["canon"][project_id] = list(canon.values())

    def _declared_paths(self, project_ids: list[str], files: list[str]) -> list[str]:
        paths: list[str] = []
        for project_id in project_ids:
            base = f"{self._source._projects_dir}/{project_id}"
            for path in _yaml_files(files, f"{base}/scenes/"):
                scene = self._yaml(path)
                paths += [item["path"] for _, item in _canon_refs(scene, "")]
                if scene.get("location"):
                    location = scene["location"]
                    paths += [item["path"] for _, item in _canon_refs(location, "")]
                for character in scene.get("characters", []):
                    paths += [item["path"] for _, item in _canon_refs(character, "")]
                for shot_id in scene.get("shots", []):
                    shot = self._yaml(f"{base}/shots/{shot_id}.yaml")
                    paths += [item["path"] for _, item in _canon_refs(shot, "")]
        return paths

    def _load(self, paths: list[str]) -> None:
        missing = [path for path in dict.fromkeys(paths) if path not in self._blobs]
        self._blobs.update(self._source._blobs(self._revision, missing))

    def _yaml(self, path: str) -> dict[str, Any]:
        """yamlを読む。参照先の収集と文書の組み立てで2回読むため、解釈結果を持つ。"""
        if path not in self._parsed:
            self._parsed[path] = self._parse(path)
        return self._parsed[path]

    def _parse(self, path: str) -> dict[str, Any]:
        blob = self._blobs.get(path)
        if blob is None:
            raise AiMediaUnavailable(f"参照データがリポジトリにありません: {path}")
        data = yaml.load(blob.decode("utf-8"), Loader=_NoAliasLoader)
        if not isinstance(data, dict):
            raise AiMediaUnavailable(f"参照データの形式が想定外です: {path}")
        # 応答はJSONで返す。yamlの日付などはJSONで表せないため、文字列へ寄せる。
        return json.loads(json.dumps(data, ensure_ascii=False, default=str))

    def _reference(
        self, path: str, anchor: Any = None, note: Any = None
    ) -> dict[str, Any] | None:
        """不変参照を作る。リポジトリに実体が無いpathは`None`を返す。"""
        blob = self._blobs.get(path)
        if blob is None:
            return None
        raw = {
            "source_locator": self._source._locator,
            "revision": self._revision,
            "path": path,
            "sha256": _sha256(blob),
            "anchor": anchor,
            "note": note,
        }
        try:
            return immutable_reference(raw)
        except ReferenceError:
            return None

    def _required(self, path: str) -> dict[str, Any]:
        reference = self._reference(path)
        if reference is None:
            raise AiMediaUnavailable(f"参照データがリポジトリにありません: {path}")
        return reference

    def _declared(self, item: dict[str, Any]) -> dict[str, Any] | None:
        reference = self._reference(item["path"], item.get("anchor"), item.get("note"))
        if reference is None:
            self._excluded.add(str(item["path"]))
        return reference

    def _add_canon(
        self,
        canon: dict[str, dict[str, Any]],
        kind: str,
        display_name: str,
        declared: list[tuple[str, dict[str, Any]]],
    ) -> None:
        for _, item in declared:
            reference = self._declared(item)
            if reference is None:
                continue
            canon.setdefault(
                canon_id(reference),
                {
                    "canon_id": canon_id(reference),
                    "kind": kind,
                    "display_name": display_name,
                    "reference": reference,
                },
            )

    def _envelope(
        self,
        kind: str,
        data: dict[str, Any],
        path: str,
        declared: list[tuple[str, dict[str, Any]]],
    ) -> dict[str, Any]:
        references = []
        for pointer, item in declared:
            reference = self._declared(item)
            if reference is None:
                continue
            references.append(
                {
                    "json_pointer": pointer,
                    "declared_path": item["path"],
                    "reference": reference,
                }
            )
        return {
            "kind": kind,
            "data": data,
            "provenance": {
                "resource": self._required(path),
                "schema": {"name": kind, "reference": self._schemas[kind]},
                "references": references,
            },
        }


def _canon_refs(data: dict[str, Any], prefix: str) -> list[tuple[str, dict[str, Any]]]:
    """本文が宣言するcanon_refsを、JSON Pointerと組にして返す。"""
    return [
        (f"{prefix}/canon_refs/{index}", item)
        for index, item in enumerate(data.get("canon_refs", []))
    ]


def _yaml_files(files: list[str], directory: str) -> list[str]:
    return sorted(
        path
        for path in files
        if path.startswith(directory)
        and "/" not in path[len(directory) :]
        and path.endswith(".yaml")
    )


def _require_repository_path(path: Any) -> None:
    """リポジトリのroot起点で正規化済みのpathだけを通す。

    参照先は作品正本の外 (`works/`など) を指す実データがあるため、範囲は
    `projects_dir`に絞らずリポジトリ全体とする。`..`や絶対pathは、`cat-file`の
    `<rev>:<path>`で作業ディレクトリ起点の解釈になり、書いた場所と別の
    blobを読みうるため拒む。
    """
    if (
        not isinstance(path, str)
        or not path
        or path.startswith("/")
        or posixpath.normpath(path) != path
        or path == ".."
        or path.startswith("../")
    ):
        raise AiMediaUnavailable(f"参照データのpathが不正です: {path!r}")


def _sha256(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def _origin_locator(root: Path) -> str:
    """remote.origin.urlを参照契約のsource_locatorへ正規化する。

    GitHubのURLはSSH形式でもHTTPS形式でも`https://github.com/<owner>/<repo>`へそろえる。
    canon_idにsource_locatorが入るため、clone方法の違いでIDが変わらないようにする。
    """
    try:
        url = subprocess.run(
            ["git", "-C", str(root), "config", "--get", "remote.origin.url"],
            capture_output=True,
            check=True,
            text=True,
            timeout=GIT_TIMEOUT_SECONDS,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError) as error:
        raise AiMediaUnavailable(
            f"source_locatorを決められません。remote.origin.urlが無いため、"
            f"aimedia_repository_locatorを設定してください: {root}"
        ) from error
    matched = _GITHUB_REMOTE.match(url)
    if matched:
        return f"https://github.com/{matched['owner']}/{matched['repo']}"
    return url
