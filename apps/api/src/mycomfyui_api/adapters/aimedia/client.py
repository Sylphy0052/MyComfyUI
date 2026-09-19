"""ai-media参照API v1のクライアントと、上流が無いときのfixture実装。

契約は`contracts/ai-media/v1/openapi.yaml`とする。応答本文はそのまま中継し、本文の
解釈はUIへ委ねる。読取りだけを提供し、更新系のメソッドは持たない。

上流(novel-writer#17)は未実装のため、接続先が未設定のときは同梱fixtureを返す。
fixtureは代表Scene`hirohito-arc02-ep005-sc01`だけを含む。
"""

import copy
import json
import logging
from functools import lru_cache
from pathlib import Path
from types import TracebackType
from typing import Any, Protocol, Self, runtime_checkable
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

#: 参照APIは軽い読取りしか行わないため、生成系より短い上限で打ち切る。
REQUEST_TIMEOUT_SECONDS = 10.0

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "reference.json"

#: fixtureが持つべきトップレベル項目と、その型。
FIXTURE_KEYS: dict[str, type] = {
    "projects": list,
    "scenes": dict,
    "scene_envelopes": dict,
    "shots": dict,
    "shot_envelopes": dict,
    "canon": dict,
}


def _segment(value: str) -> str:
    """IDを1つのパスセグメントとして埋め込む。

    IDは画面からのパスパラメータをそのまま受け取る。`/`を含む値が来ても上流の別
    Endpointを指さないよう、区切り文字ごとエンコードする。

    `.`と`..`はURLのセグメントとして特別な意味を持ち、`quote`もエンコードしない。
    HTTPクライアントがパスを正規化すると、意図したProject/Sceneの配下から外れた
    Endpointへ要求が飛ぶため、エンコードに頼らずここで拒否する。
    """
    if value in (".", ".."):
        raise AiMediaNotFound(f"参照できないIDです: {value}")
    return quote(value, safe="")


class AiMediaError(Exception):
    """ai-media参照Adapterが返す例外の基底。"""


class AiMediaUnavailable(AiMediaError):
    """参照APIへ接続できない、または応答を解釈できない。"""


class AiMediaNotFound(AiMediaError):
    """指定したProject、Scene、Shotが参照元に無い。"""


@runtime_checkable
class ReferenceSource(Protocol):
    """Scene/Shot参照の取得元。HTTP実装とfixture実装が満たす。"""

    async def list_projects(self) -> dict[str, Any]: ...

    async def get_project(self, project_id: str) -> dict[str, Any]: ...

    async def list_scenes(self, project_id: str) -> dict[str, Any]: ...

    async def get_scene(self, project_id: str, scene_id: str) -> dict[str, Any]: ...

    async def list_shots(self, project_id: str, scene_id: str) -> dict[str, Any]: ...

    async def get_shot(
        self, project_id: str, scene_id: str, shot_id: str
    ) -> dict[str, Any]: ...

    async def list_canon(self, project_id: str) -> dict[str, Any]: ...

    async def get_canon(self, project_id: str, canon_id: str) -> dict[str, Any]: ...

    async def aclose(self) -> None: ...


class AiMediaClient:
    """ai-media参照APIへHTTPで問い合わせる。

    `transport`はテストでhttpxのMockTransportを差し込むための拡張点であり、通常利用
    では指定しない。
    """

    def __init__(
        self,
        base_url: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS),
            transport=transport,
        )

    @property
    def base_url(self) -> str:
        return self._base_url

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def list_projects(self) -> dict[str, Any]:
        return await self._get("/projects")

    async def get_project(self, project_id: str) -> dict[str, Any]:
        return await self._get(f"/projects/{_segment(project_id)}")

    async def list_scenes(self, project_id: str) -> dict[str, Any]:
        return await self._get(f"/projects/{_segment(project_id)}/scenes")

    async def get_scene(self, project_id: str, scene_id: str) -> dict[str, Any]:
        return await self._get(
            f"/projects/{_segment(project_id)}/scenes/{_segment(scene_id)}"
        )

    async def list_shots(self, project_id: str, scene_id: str) -> dict[str, Any]:
        return await self._get(
            f"/projects/{_segment(project_id)}/scenes/{_segment(scene_id)}/shots"
        )

    async def get_shot(
        self, project_id: str, scene_id: str, shot_id: str
    ) -> dict[str, Any]:
        return await self._get(
            f"/projects/{_segment(project_id)}/scenes/{_segment(scene_id)}"
            f"/shots/{_segment(shot_id)}"
        )

    async def list_canon(self, project_id: str) -> dict[str, Any]:
        return await self._get(f"/projects/{_segment(project_id)}/canon")

    async def get_canon(self, project_id: str, canon_id: str) -> dict[str, Any]:
        return await self._get(
            f"/projects/{_segment(project_id)}/canon/{_segment(canon_id)}"
        )

    async def _get(self, path: str) -> dict[str, Any]:
        try:
            response = await self._client.get(path)
        except httpx.HTTPError as error:
            raise AiMediaUnavailable(
                f"ai-media参照APIへ接続できません: {self._base_url}"
            ) from error
        if response.status_code == httpx.codes.NOT_FOUND:
            raise AiMediaNotFound(f"参照元に存在しません: {path}")
        if response.status_code >= httpx.codes.BAD_REQUEST:
            raise AiMediaUnavailable(
                f"ai-media参照APIがエラーを返しました"
                f"(HTTP {response.status_code}): {path}"
            )
        try:
            payload = response.json()
        except ValueError as error:
            raise AiMediaUnavailable(
                f"ai-media参照APIの応答を解釈できません: {path}"
            ) from error
        if not isinstance(payload, dict):
            raise AiMediaUnavailable(f"ai-media参照APIの応答形式が想定外です: {path}")
        return payload


class FixtureReferenceSource:
    """同梱fixtureを参照APIの形で返す。上流が稼働していない間の代替。

    呼び出し側が返り値を書き換えても元データへ影響しないよう複製して返す。
    """

    def __init__(
        self,
        document: dict[str, Any] | None = None,
        *,
        path: Path | None = None,
    ) -> None:
        self._path = path
        self._fixed = _validated(document) if document is not None else None
        if self._fixed is None:
            # 読み込めない設定は起動時に失敗させる。参照のたびに503を返す状態で
            # 立ち上がると、原因が設定にあることが分かりにくい。
            _load_fixture(path)

    @property
    def _document(self) -> dict[str, Any]:
        """参照のたびにfixtureを読む。

        このsourceはアプリの起動時に1つだけ作り、以後使い回す。読み込んだ内容を
        保持すると、検証中に差し替えfixtureを書き換えてもプロセスを再起動するまで
        反映されない。同梱fixtureは`_read_bundled_fixture`がキャッシュするため、
        読み直しの実費が出るのは差し替え時だけである。
        """
        if self._fixed is not None:
            return self._fixed
        return _load_fixture(self._path)

    async def list_projects(self) -> dict[str, Any]:
        return copy.deepcopy({"items": self._document["projects"]})

    async def get_project(self, project_id: str) -> dict[str, Any]:
        for project in self._document["projects"]:
            if project["id"] == project_id:
                return copy.deepcopy(project)
        raise AiMediaNotFound(f"Projectがfixtureにありません: {project_id}")

    async def list_scenes(self, project_id: str) -> dict[str, Any]:
        await self.get_project(project_id)
        scenes = self._document["scenes"].get(project_id, [])
        return copy.deepcopy({"items": scenes})

    async def get_scene(self, project_id: str, scene_id: str) -> dict[str, Any]:
        await self._require_scene(project_id, scene_id)
        return copy.deepcopy(self._document["scene_envelopes"][scene_id])

    async def list_shots(self, project_id: str, scene_id: str) -> dict[str, Any]:
        await self._require_scene(project_id, scene_id)
        shots = self._document["shots"].get(scene_id, [])
        return copy.deepcopy({"items": shots})

    async def get_shot(
        self, project_id: str, scene_id: str, shot_id: str
    ) -> dict[str, Any]:
        await self._require_scene(project_id, scene_id)
        envelope = self._document["shot_envelopes"].get(shot_id)
        if envelope is None or envelope["data"]["scene_id"] != scene_id:
            raise AiMediaNotFound(f"Shotがfixtureにありません: {shot_id}")
        return copy.deepcopy(envelope)

    async def list_canon(self, project_id: str) -> dict[str, Any]:
        await self.get_project(project_id)
        return copy.deepcopy({"items": self._document["canon"].get(project_id, [])})

    async def get_canon(self, project_id: str, canon_id: str) -> dict[str, Any]:
        await self.get_project(project_id)
        for descriptor in self._document["canon"].get(project_id, []):
            if descriptor.get("canon_id") == canon_id:
                return copy.deepcopy(descriptor)
        raise AiMediaNotFound(f"Canonがfixtureにありません: {canon_id}")

    async def aclose(self) -> None:
        return None

    async def _require_scene(self, project_id: str, scene_id: str) -> None:
        """Sceneが対象Projectに属していることまで確かめる。

        Project配下のパスで別Projectのsceneを引けてしまうと、UIが表示中のProjectと
        取得内容がずれる。
        """
        await self.get_project(project_id)
        envelope = self._document["scene_envelopes"].get(scene_id)
        if envelope is None or envelope["data"]["project_id"] != project_id:
            raise AiMediaNotFound(f"Sceneがfixtureにありません: {scene_id}")


def _load_fixture(path: Path | None = None) -> dict[str, Any]:
    """参照fixtureを読む。

    同梱fixtureは起動中に変わらないため一度だけ読む。差し替えたfixtureは検証中に内容を
    書き換えるため、キャッシュせず呼ばれるたびに読み直す。
    """
    if path is not None:
        return _read_fixture(path)
    return _read_bundled_fixture()


@lru_cache
def _read_bundled_fixture() -> dict[str, Any]:
    return _read_fixture(FIXTURE_PATH)


def _read_fixture(source: Path) -> dict[str, Any]:
    try:
        document = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise AiMediaUnavailable(f"参照fixtureを読み込めません: {source}") from error
    return _validated(document, source)


def _validated(document: Any, source: Path = FIXTURE_PATH) -> dict[str, Any]:
    """fixtureの形を読み込み時に確かめる。

    構造が壊れていると参照のたびにKeyErrorが出て、利用者へは内部エラーとしか伝わらな
    い。参照データ側の不整合だと分かる例外へここで変換する。
    """
    if not isinstance(document, dict):
        raise AiMediaUnavailable(f"参照fixtureの形式が想定外です: {source}")
    missing = [key for key in FIXTURE_KEYS if key not in document]
    if missing:
        raise AiMediaUnavailable(
            f"参照fixtureに必要な項目がありません: {', '.join(missing)}"
        )
    # 型まで見る。項目はあるが形が違う場合、参照のたびにAttributeErrorが出て
    # 内部エラーとしか伝わらない。
    malformed = [
        key
        for key, expected in FIXTURE_KEYS.items()
        if not isinstance(document[key], expected)
    ]
    if malformed:
        raise AiMediaUnavailable(
            f"参照fixtureの項目の形式が想定外です: {', '.join(malformed)}"
        )
    return document


def create_reference_source(
    base_url: str | None, fixture_path: Path | None = None
) -> ReferenceSource:
    """接続先の設定有無で、HTTP実装とfixture実装を切り替える。"""
    if base_url:
        logger.info("ai-media参照APIへ接続します。base_url=%s", base_url)
        return AiMediaClient(base_url)
    if fixture_path is not None:
        logger.info("差し替えた参照fixtureを読みます。path=%s", fixture_path)
        return FixtureReferenceSource(path=fixture_path)
    logger.info(
        "ai-media参照APIの接続先が未設定のため、同梱fixtureを参照します。"
        "実データを使うにはMYCOMFYUI_AIMEDIA_BASE_URLを設定してください。"
    )
    return FixtureReferenceSource()
