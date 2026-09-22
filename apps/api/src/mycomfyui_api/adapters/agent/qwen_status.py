"""Qwenを起動させずにBackendの状態だけを読む。

Remote GPU Hostでは、推論サーバーの手前にgpu-proxyが入る。proxyはL4で素通しするため、
TCP接続の確立そのものが`systemctl --user start qwen-llm.service`の起動トリガになる。
`qwen-llm.service`は`Conflicts=comfyui.service`を持つため、接続しただけでComfyUIが止まる。

このため、可用性の確認に推論サーバーの`/models`を使えない。確認のつもりの接続が
Qwenを起動してComfyUIを落とすうえ、起動完了を待てずに「利用不可」と判定してしまう。
proxy側が別portへ用意した状態照会口は`systemctl start`を呼ばず、`is-active`と、既に
起きているプロセスへのloopback GETだけで応答を組み立てる。本モジュールはその照会口を読む。

照会先を設定していない構成では本モジュールを使わない。推論サーバーをローカルへ常駐させる
場合やproxyを挟まない場合は、従来どおり`/models`で到達性を確かめる。
"""

import json
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from mycomfyui_api.settings import Settings

logger = logging.getLogger(__name__)

#: 照会の応答として読む上限。応答は真偽値がいくつか入るだけで1KBに満たない。
#: 照会先が壊れた場合や別のサービスを指してしまった場合に、画面を描画するたびに
#: 大きな本文を読み込むことがないようにする。
MAX_STATUS_BYTES = 64 * 1024


@dataclass(frozen=True)
class BackendStatus:
    """状態照会口が返したBackendの状態。接続先と認証情報を持たない。"""

    #: 推論要求を受け付けられる。sleep中も真であり、要求すれば自動で復帰する。
    ready: bool
    #: VRAMを解放したsleep状態かどうか。判別できないときはNone。
    sleeping: bool | None
    #: 状態照会口の側で起動処理が進行中かどうか。
    starting: bool
    #: Qwenの起動で停止する側(ComfyUI)が現在動いているかどうか。
    conflicts_running: bool


def _as_bool(payload: Any, key: str) -> bool:
    value = payload.get(key) if isinstance(payload, dict) else None
    return value if isinstance(value, bool) else False


def _as_optional_bool(payload: Any, key: str) -> bool | None:
    value = payload.get(key) if isinstance(payload, dict) else None
    return value if isinstance(value, bool) else None


def parse_status(payload: Any) -> BackendStatus | None:
    """照会口の応答をBackendStatusへ直す。形が違えばNoneを返す。

    応答はApplication APIの外で組み立てられるため、欠けた項目と型違いを許容する。
    読めなかった項目は「起動していない」側へ倒し、起動を促す表示にしない。
    """
    if not isinstance(payload, dict):
        return None
    qwen = payload.get("qwen")
    if not isinstance(qwen, dict):
        return None
    return BackendStatus(
        ready=_as_bool(qwen, "ready"),
        sleeping=_as_optional_bool(qwen, "sleeping"),
        starting=_as_bool(payload, "starting"),
        conflicts_running=_as_bool(payload.get("comfyui"), "active"),
    )


async def fetch_status(
    settings: Settings,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> BackendStatus | None:
    """状態照会口を1回読む。未設定・到達不可・解釈不能のいずれもNoneを返す。

    照会は画面を描画するたびに走るため、待たせない方を優先して短い時間で打ち切る。
    照会口は`systemctl start`を呼ばないので、この呼び出しでBackendは起動しない。

    照会先は運用者が環境変数で与える固定値であり、利用者の入力からは決まらない。この
    前提が崩れる変更(接続先をAPIやDBから受け取る等)を入れる場合は、任意の宛先へ要求を
    出せる経路になるため、宛先の制限をここへ足す必要がある。

    `httpx.InvalidURL`は`httpx.HTTPError`の系統に属さない。`http://host:port/`のように
    portへ数値以外を書いた設定ミスで送出されるため、同じく捕捉して他のProviderの一覧まで
    巻き込まないようにする。
    """
    url = settings.agent_qwen_status_url
    if not url:
        return None
    try:
        async with (
            httpx.AsyncClient(
                timeout=httpx.Timeout(settings.agent_qwen_status_timeout_seconds),
                transport=transport,
            ) as client,
            client.stream("GET", url) as response,
        ):
            if not response.is_success:
                logger.info(
                    "Qwenの状態照会がHTTP %sを返しました。", response.status_code
                )
                return None
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_STATUS_BYTES:
                    logger.info(
                        "Qwenの状態照会の応答が%dバイトを超えました。",
                        MAX_STATUS_BYTES,
                    )
                    return None
    except (httpx.HTTPError, httpx.InvalidURL) as error:
        logger.info("Qwenの状態照会に失敗しました。(%s)", type(error).__name__)
        return None
    try:
        payload = json.loads(bytes(body))
    except ValueError:
        logger.info("Qwenの状態照会の応答を解釈できません。")
        return None
    status = parse_status(payload)
    if status is None:
        logger.info("Qwenの状態照会の応答に必要な項目がありません。")
    return status
