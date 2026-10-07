"""画像prompt案を採点し、違反があれば1回だけ作り直させる。

`routers.py`の`image_prompt`提案と画像promptの補完、`apps/api/scripts/prompt_eval.py`の
評価scriptから同じ関数を呼ぶ。Providerの呼出しと後処理をまとめて扱う。後処理は経路
ごとに違うため、呼出し側からcallbackで受け取る。

Providerを再度呼ぶのは次の2つだけで、どちらも1回に限る。

- 後処理済みの案に`prompt_checks`の違反がある (`unknown_tag`の参考値は数えない)
- 応答の形が壊れていた (`AgentInvalidResponse`)

`AgentUnavailable`は接続の失敗で、作り直させても直らないため再度呼ばない。
"""

from __future__ import annotations

import dataclasses
import math
from collections.abc import Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from mycomfyui_api.adapters.agent import prompt_checks
from mycomfyui_api.adapters.agent.base import (
    AgentError,
    AgentInvalidResponse,
    AgentProvider,
    ProposalRequest,
    ProposalResult,
)

#: 採点して作り直させる提案の種類。`batch_generation_plan`は、1件ずつ直すか計画全体を
#: 作り直すかの判断が要るため対象にしない。
RETRY_KINDS = frozenset({"image_prompt"})

#: 指示文と記録へ入れる誤りの説明1件あたりの上限文字数。
_CLIP_CHARS = 300

#: Providerの結果から、採点と保存に使う最終の案を作る。
Postprocess = Callable[[ProposalResult], Awaitable[dict[str, Any]]]


@dataclass(frozen=True)
class CheckedProposal:
    """採点を経た案。`usage`は呼んだ回の合計で、作り直させたときは`retry`も含む。"""

    output: dict[str, Any]
    model: str | None
    usage: dict[str, Any]
    #: 作り直させた理由と1回目の誤り。作り直させなかったときは`None`。
    retry: dict[str, Any] | None = None


async def propose_checked(
    provider: AgentProvider,
    request: ProposalRequest,
    postprocess: Postprocess,
    *,
    enabled: bool,
) -> CheckedProposal:
    """案を1回求めて採点し、必要なら1回だけ作り直させる。

    2回とも案を得たときは違反の少ない方を採り、同数なら1回目を採る。作り直しが
    失敗しても1回目の案は使えるため、その失敗は記録だけして1回目を返す。

    `enabled`が偽か対象外の種類なら、Providerを1回だけ呼ぶ (#396より前の挙動)。
    失敗した回のトークン使用量はProviderから受け取れないため、合計に含めない。
    """
    if not enabled or request.kind not in RETRY_KINDS:
        result, output = await _attempt(provider, request, postprocess)
        return CheckedProposal(output, result.model, dict(result.usage))
    try:
        first, first_output = await _attempt(provider, request, postprocess)
    except AgentInvalidResponse as error:
        first_error = _clip(str(error))
        retry = {"reason": "invalid_response", "first_error": first_error}
        try:
            second, second_output = await _attempt(
                provider,
                _with_feedback(
                    request, "前回の出力は応答の形式に合わなかった。", [first_error]
                ),
                postprocess,
            )
        except AgentInvalidResponse as second_error:
            # 失敗した提案の記録にも、呼び直したことと1回目の誤りを残す。記録は
            # 先頭500文字で切られるため、呼び直しの事実を先に置き、2回目も切り詰める。
            raise AgentInvalidResponse(
                f"1回呼び直しても直らなかった。1回目: {first_error}"
                f" / 2回目: {_clip(str(second_error))}"
            ) from second_error
        return _checked(second, second_output, [second.usage], retry)
    violations = _violations(request, first_output)
    if not violations:
        return _checked(first, first_output, [first.usage], None)
    retry = {
        "reason": "violations",
        "first_violations": [_violation_record(item) for item in violations],
    }
    try:
        second, second_output = await _attempt(
            provider,
            _with_feedback(
                request,
                "前回の出力は次の規則に反した。",
                (_violation_line(item) for item in violations),
            ),
            postprocess,
        )
    except AgentError as error:
        retry |= {"chosen": 1, "retry_error": _clip(str(error))}
        return _checked(first, first_output, [first.usage], retry)
    second_violations = _violations(request, second_output)
    retry["second_violations"] = [_violation_record(item) for item in second_violations]
    usages = [first.usage, second.usage]
    if len(second_violations) < len(violations):
        retry["chosen"] = 2
        return _checked(second, second_output, usages, retry)
    retry["chosen"] = 1
    return _checked(first, first_output, usages, retry)


async def _attempt(
    provider: AgentProvider, request: ProposalRequest, postprocess: Postprocess
) -> tuple[ProposalResult, dict[str, Any]]:
    result = await provider.propose(request)
    return result, await postprocess(result)


def _violations(
    request: ProposalRequest, output: Mapping[str, Any]
) -> list[prompt_checks.Violation]:
    # 辞書を渡さないため`unknown_tag`は出ないが、参考値は合否に数えない約束に従う。
    return [
        violation
        for violation in prompt_checks.check_output(
            request.kind, output, context=request.context
        )
        if not violation.reference
    ]


def _with_feedback(
    request: ProposalRequest, lead: str, lines: Iterable[str]
) -> ProposalRequest:
    """利用者の指示の末尾へ、前回の誤りと直す依頼を足した要求を作る。"""
    feedback = "\n".join(
        [lead, *(f"- {line}" for line in lines), "同じ誤りをせずに出力し直す。"]
    )
    return dataclasses.replace(
        request, instruction=f"{request.instruction}\n\n{feedback}"
    )


def _violation_line(violation: prompt_checks.Violation) -> str:
    text = f"{violation.rule}: {violation.message}"
    return f"{text} ({_clip(violation.detail)})" if violation.detail else text


def _violation_record(violation: prompt_checks.Violation) -> dict[str, str]:
    return {
        "rule": violation.rule,
        "message": violation.message,
        "detail": _clip(violation.detail),
    }


def _clip(text: str) -> str:
    """改行を畳み、長さを`_CLIP_CHARS`までに切る。

    検証エラーの全文や違反の抜粋にはモデルの出力が丸ごと入ることがある。そのまま
    指示文と記録へ入れると、指示が膨らみ、出力の断片を次の回へ持ち込むためである。
    """
    text = " ".join(text.split())
    return text if len(text) <= _CLIP_CHARS else f"{text[: _CLIP_CHARS - 1]}…"


def _checked(
    result: ProposalResult,
    output: dict[str, Any],
    usages: list[Mapping[str, Any]],
    retry: dict[str, Any] | None,
) -> CheckedProposal:
    usage = _sum_usage(usages)
    if retry is not None:
        # Providerのusageが`retry`を持つときは、消さずに作り直しの記録へ入れる
        record = dict(retry)
        if "retry" in usage:
            record["provider_retry"] = usage["retry"]
        usage["retry"] = record
    return CheckedProposal(output, result.model, usage, retry)


def _sum_usage(usages: list[Mapping[str, Any]]) -> dict[str, Any]:
    """数値の項目は足し、入れ子の辞書は再帰して合算し、それ以外は最初に現れた値を残す。

    項目名はProviderごとに違う (Qwenはトークン数、Claude Codeは費用と所要時間) ため、
    名前を決め打ちせずに合算する。`NaN`と`inf`はJSON列へ保存できないため合算に入れず、
    その要素を捨てる。同じ項目で型が食い違うときは、最初に現れた値を残す。
    """
    total: dict[str, Any] = {}
    for usage in usages:
        _merge_usage(total, usage)
    return total


def _merge_usage(total: dict[str, Any], usage: Mapping[str, Any]) -> None:
    for key, value in usage.items():
        current = total.get(key)
        if isinstance(value, Mapping):
            if key not in total:
                total[key] = {}
                current = total[key]
            if isinstance(current, dict):
                _merge_usage(current, value)
        elif _is_number(value):
            if isinstance(value, float) and not math.isfinite(value):
                continue
            if key not in total:
                total[key] = value
            elif _is_number(current):
                total[key] = current + value
        else:
            total.setdefault(key, value)


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)
