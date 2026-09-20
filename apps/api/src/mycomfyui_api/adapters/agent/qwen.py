"""ローカルLLM QwenをOpenAI互換HTTP経由で呼ぶ提案Provider。

CLIをsubprocessで起動する`claude_code`/`codex`と違い、別プロセスで常駐している推論
サーバー(vLLM、llama.cpp server、Ollamaの互換Endpointなど)へHTTPで問い合わせる。
接続先はComfyUIとvoice-runnerと同じ扱いとし、ローカル構成とRemote GPU Host構成の差は
`MYCOMFYUI_AGENT_QWEN_BASE_URL`の値だけに閉じ込める。

提案以外の副作用を持たせないため、次の条件で呼ぶ。

- 使うEndpointは`POST {base_url}/chat/completions`と`GET {base_url}/models`だけとする。
  ツール実行もfunction callingも渡さないため、Providerが行えるのは本文の生成だけになる。
- 出力形式は`response_format`の`json_schema`で固定する。OpenAI互換のstrict
  JSON Schemaは`properties`の全項目が`required`に無いと拒否されるため、Codexと同じ
  `proposals.strict_json_schema`を使う。
- 推論サーバー側がschema強制に対応していない場合でも、応答は
  `proposals.validate_output`(Pydantic側)を通すため、形が違う応答は履歴へ残さない。

認証情報は設定にもDBにも置かない。ローカルまたはLAN内の推論サーバーへ`127.0.0.1`か
Remote PCのURLで直接つなぐ前提とし、APIキーを要求するホスト型サービスは対象外とする。
このため、提案の入力・出力・監査履歴・ログに認証情報が入る経路を作らない。
"""

import json
import logging
from typing import Any

import httpx

from mycomfyui_api.adapters.agent import proposals
from mycomfyui_api.adapters.agent.base import (
    AgentInvalidResponse,
    AgentUnavailable,
    ProposalRequest,
    ProposalResult,
)
from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

PROVIDER_ID = "qwen"
PROVIDER_LABEL = "Qwen (OpenAI互換)"

#: 到達性の確認は提案本体より短い時間で打ち切る。voice-runnerの疎通確認と同じ値。
HEALTH_TIMEOUT_SECONDS = 10.0

#: 応答から履歴へ残す実測値。接続先も認証情報も含まない項目だけを並べる。
USAGE_KEYS = ("prompt_tokens", "completion_tokens", "total_tokens")


class QwenProvider:
    """推論サーバーへ1回問い合わせて提案を1件返す。

    `transport`はhttpxのMockTransportを差し込むための拡張点であり、通常利用では
    指定しない。
    """

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._base_url = self._settings.agent_qwen_base_url.rstrip("/")
        self._timeout = self._settings.agent_qwen_timeout_seconds
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(self._timeout),
            transport=transport,
        )

    @property
    def id(self) -> str:
        return PROVIDER_ID

    @property
    def label(self) -> str:
        return PROVIDER_LABEL

    async def available(self) -> bool:
        """推論サーバーへ到達できるかだけを返す。

        モデルが載っているかは確かめない。`/models`が応答すればサーバーは起きており、
        提案を試せる状態とみなす。未起動の環境ではここでFalseになり、提案取得を
        要求するまで失敗しない。
        """
        try:
            response = await self._client.get("/models", timeout=HEALTH_TIMEOUT_SECONDS)
        except httpx.HTTPError:
            return False
        return response.is_success

    async def aclose(self) -> None:
        await self._client.aclose()

    async def propose(self, request: ProposalRequest) -> ProposalResult:
        payload, usage = await self._chat(request)
        output = proposals.validate_output(request.kind, payload)
        return ProposalResult(
            output=output, model=self._settings.agent_qwen_model, usage=usage
        )

    def _body(self, request: ProposalRequest) -> dict[str, Any]:
        """OpenAI互換の`chat/completions`へ渡す本文。

        ツールもfunction callingも渡さない。Providerが持てるのは本文を返す経路だけに
        なり、承認を経ない副作用が起きる余地を残さない。
        """
        return {
            "model": self._settings.agent_qwen_model,
            "messages": [
                {"role": "system", "content": proposals.SYSTEM_PROMPT},
                {"role": "user", "content": proposals.build_prompt(request)},
            ],
            "stream": False,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": f"{request.kind}_output",
                    "strict": True,
                    "schema": proposals.strict_json_schema(request.kind),
                },
            },
        }

    async def _chat(
        self, request: ProposalRequest
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        try:
            response = await self._client.post(
                "/chat/completions", json=self._body(request)
            )
        except httpx.TimeoutException as error:
            raise AgentUnavailable(
                f"提案の取得が{self._timeout}秒で終わりませんでした。"
            ) from error
        except httpx.HTTPError as error:
            # 接続先URLは失敗理由へ載せない。この文言は提案の履歴へ保存され、APIから
            # 読み出せるため、ローカル固有の値を残さない。
            raise AgentUnavailable("提案Providerへ接続できません。") from error
        if not response.is_success:
            # 応答本文は残さない。判定に使うstatusだけをログへ出す。
            logger.warning(
                "提案Providerがエラーを返しました。provider=%s status=%s",
                PROVIDER_ID,
                response.status_code,
            )
            raise AgentUnavailable(self._failure_reason(response.status_code))
        try:
            envelope = response.json()
        except ValueError as error:
            raise AgentInvalidResponse(
                "提案Providerの応答を解釈できません。"
            ) from error
        if not isinstance(envelope, dict):
            raise AgentInvalidResponse(
                "提案Providerの応答がJSON objectではありません。"
            )
        return self._payload(envelope), self._extract_usage(envelope)

    def _failure_reason(self, status_code: int) -> str:
        """非2xx応答の理由。statusの種別だけを載せ、応答本文は載せない。

        4xxは要求の作り方かモデル名の設定違いであり、再試行しても直らない。5xxは
        推論サーバー側の一時的な失敗で、再試行で通ることがある。利用者が次に何を
        すべきかを分けられるよう、同じ`AgentUnavailable`でも文言を変える。
        """
        if 400 <= status_code < 500:
            return (
                f"提案Providerが要求を拒否しました(HTTP {status_code})。"
                "モデル名と、推論サーバーがJSON Schema指定に対応しているかを"
                "確認してください。"
            )
        return (
            f"提案Providerがエラーを返しました(HTTP {status_code})。"
            "推論サーバーの状態を確認してください。"
        )

    def _payload(self, envelope: dict[str, Any]) -> dict[str, Any]:
        """`choices[0].message.content`のJSONを取り出す。"""
        choices = envelope.get("choices")
        if not isinstance(choices, list) or not choices:
            raise AgentInvalidResponse("提案Providerの応答に本文がありません。")
        first = choices[0]
        message = first.get("message") if isinstance(first, dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise AgentInvalidResponse("提案Providerの応答に本文がありません。")
        try:
            payload = json.loads(content)
        except json.JSONDecodeError as error:
            raise AgentInvalidResponse(
                "提案Providerの応答を解釈できません。"
            ) from error
        if not isinstance(payload, dict):
            raise AgentInvalidResponse(
                "提案Providerの応答がJSON objectではありません。"
            )
        return payload

    def _extract_usage(self, envelope: dict[str, Any]) -> dict[str, Any]:
        """`usage`のトークン数だけを拾う。取れなくても提案の成否は変えない。"""
        raw_usage = envelope.get("usage")
        if not isinstance(raw_usage, dict):
            return {}
        return {
            key: raw_usage[key]
            for key in USAGE_KEYS
            if isinstance(raw_usage.get(key), int | float)
        }
