"""prompt案の出力を、複数の入力Caseに対してProviderへ実際に問い合わせて採点する。

`routers.py`のprompt案系Endpoint (`image_prompt`、`batch_generation_plan`) と同じ
組み立て・後処理 (`ProposalRequest`の構築 → `provider.propose` → `apply_prompt_style`
→ `restrict_output`) を経た出力を`prompt_checks.check_output`へ渡し、規則ごとの
違反率を集計する。DBもFastAPI appも起こさず、Case定義
(`apps/api/scripts/prompt_eval/cases.json`)だけで動く。

    uv run --project apps/api python apps/api/scripts/prompt_eval.py \\
        --provider stub --repeat 1 --out stub.json

    uv run --project apps/api python apps/api/scripts/prompt_eval.py \\
        --compare base.json head.json

Providerの推論サーバーへ接続できず`AgentUnavailable`が起きたときは、そこまでの結果を
`--out`へ書き出してexit code 1で終える。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from mycomfyui_api import routers
from mycomfyui_api.adapters import tag_preflight
from mycomfyui_api.adapters.agent import base as agent_base
from mycomfyui_api.adapters.agent import (
    create_agent_providers,
    prompt_checks,
    proposals,
)
from mycomfyui_api.settings import get_settings

REPO_ROOT = Path(__file__).resolve().parents[3]
CASES_PATH = Path(__file__).resolve().parent / "prompt_eval" / "cases.json"

#: `--provider`で選べるProviderのID。Providerの生成自体は`create_agent_providers`に委ねる。
PROVIDER_IDS = ("qwen", "codex", "claude_code", "stub")

#: 集計する規則のID。`prompt_checks`の規則に、Caseの`expect`との照合を足す。
#: `expect`は評価セットにだけある期待値のため、`prompt_checks`には置かない。
EVAL_RULE_IDS = (*prompt_checks.RULE_IDS, "expect")


def load_cases() -> list[dict[str, Any]]:
    """`cases.json`のCase一覧を読む。"""
    data = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    cases = data.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError(f"{CASES_PATH}にcasesが無い")
    for case in cases:
        # 手で書く値は、問い合わせを始める前に確かめる。途中で落ちると結果が残らない。
        min_rating = case.get("expect", {}).get("min_rating")
        if min_rating is not None and min_rating not in proposals.RATING_LEVELS:
            raise ValueError(
                f"{case.get('id')}: expect.min_ratingは"
                f"{', '.join(proposals.RATING_LEVELS)}のどれか: {min_rating}"
            )
    return cases


def build_context(case: dict[str, Any]) -> dict[str, Any]:
    """`routers._agent_context`と同じ組み立てを、CaseのScene/Shot定義から行う。"""
    context: dict[str, Any] = {"scene": proposals.scene_context(case.get("scene"))}
    if case.get("shot") is not None:
        context["shot"] = proposals.shot_context(case["shot"])
    prompt_style = case.get("prompt_style")
    if case["kind"] in proposals.PROMPT_STYLE_KINDS and prompt_style is not None:
        context["prompt_style"] = prompt_style
    if case["kind"] == "batch_generation_plan":
        context["shots"] = proposals.shot_list_context(case.get("shots", []))
    return context


def check_expect(
    case: dict[str, Any], output: dict[str, Any]
) -> list[prompt_checks.Violation]:
    """Caseの`expect` (人数、必須タグ、ratingの下限、件数) と出力を照合する。"""
    expect = case.get("expect") or {}
    if case["kind"] == "batch_generation_plan":
        items = output.get("items")
        count = len(items) if isinstance(items, list) else 0
        wanted = expect.get("item_count")
        if wanted is not None and count != wanted:
            return [
                prompt_checks.Violation(
                    "expect", f"expected {wanted} items, got {count}."
                )
            ]
        return []
    violations: list[prompt_checks.Violation] = []
    subject_tags = [
        tag_preflight.normalize_tag(tag)
        for tag in output.get("subject_tags") or []
        if isinstance(tag, str)
    ]
    wanted_people = expect.get("person_count")
    if wanted_people is not None:
        people = prompt_checks.total_subject_count(subject_tags)
        if people != wanted_people:
            violations.append(
                prompt_checks.Violation(
                    "expect",
                    f"expected {wanted_people} people, got {people}.",
                    detail=", ".join(subject_tags),
                )
            )
    positive = {
        tag_preflight.normalize_tag(tag)
        for tag in tag_preflight.split_prompt(output.get("tag_line") or "")
    }
    missing = [
        tag
        for tag in expect.get("required_tags", [])
        if tag_preflight.normalize_tag(tag) not in positive
    ]
    if missing:
        violations.append(
            prompt_checks.Violation(
                "expect", "required tags are missing.", detail=", ".join(missing)
            )
        )
    min_rating = expect.get("min_rating")
    if min_rating is not None:
        ratings = [tag for tag in positive if tag in proposals.RATING_LEVELS]
        floor = proposals.RATING_LEVELS.index(min_rating)
        if not any(proposals.RATING_LEVELS.index(tag) >= floor for tag in ratings):
            violations.append(
                prompt_checks.Violation(
                    "expect",
                    f"expected rating {min_rating} or higher.",
                    detail=", ".join(ratings),
                )
            )
    return violations


async def run_attempt(
    provider: agent_base.AgentProvider,
    case: dict[str, Any],
    tag_dictionary_path: Path | None,
) -> dict[str, Any]:
    """1回分の問い合わせと、`routers.py`と同じ後処理・判定を行う。

    `AgentUnavailable`はここで揉み消さず、呼び出し側へ伝えて評価全体を打ち切らせる。
    それ以外の`AgentError` (応答の形が壊れているなど) は1回分の失敗として記録する。
    """
    context = build_context(case)
    # guidanceとShot IDはroutersの実体を呼び、Endpointとの食い違いを作らない。
    # contextの組み立てだけはDB sessionを要するため`build_context`で代える。
    guidance = await routers._prompt_guidance(
        case["kind"], case["instruction"], context
    )
    request = agent_base.ProposalRequest(
        kind=case["kind"],
        instruction=case["instruction"],
        context=context,
        guidance=guidance,
    )
    started = time.monotonic()
    try:
        result = await provider.propose(request)
    except agent_base.AgentUnavailable:
        raise
    except agent_base.AgentError as error:
        return {
            "output": None,
            "violations": [],
            "exception": {"type": type(error).__name__, "message": str(error)},
            "duration_sec": round(time.monotonic() - started, 3),
        }
    output = proposals.apply_prompt_style(
        case["kind"], result.output, context.get("prompt_style")
    )
    output = proposals.restrict_output(
        case["kind"],
        output,
        artifact_ids=set(),
        shot_ids=routers._context_shot_ids(context),
        recipe_input_names=set(),
    )
    violations = prompt_checks.check_output(
        case["kind"], output, context=context, tag_dictionary_path=tag_dictionary_path
    )
    violations.extend(check_expect(case, output))
    return {
        "output": output,
        "violations": [asdict(violation) for violation in violations],
        "exception": None,
        "duration_sec": round(time.monotonic() - started, 3),
    }


def summarize(cases: list[dict[str, Any]]) -> dict[str, Any]:
    """規則ごとの違反率と例外件数を集計する。分母は出力を得られた試行数のみとする。"""
    total_attempts = 0
    ok_attempts = 0
    exception_counts: dict[str, int] = {}
    rule_hits: dict[str, int] = {rule: 0 for rule in EVAL_RULE_IDS}
    durations: list[float] = []
    for case in cases:
        for attempt in case["attempts"]:
            total_attempts += 1
            durations.append(attempt["duration_sec"])
            if attempt["exception"] is not None:
                exception_type = attempt["exception"]["type"]
                exception_counts[exception_type] = (
                    exception_counts.get(exception_type, 0) + 1
                )
                continue
            ok_attempts += 1
            hit_rules = {violation["rule"] for violation in attempt["violations"]}
            for rule in hit_rules:
                rule_hits[rule] = rule_hits.get(rule, 0) + 1
    rule_rates = {
        rule: (round(hits / ok_attempts, 4) if ok_attempts else None)
        for rule, hits in rule_hits.items()
    }
    return {
        "total_attempts": total_attempts,
        "ok_attempts": ok_attempts,
        "exception_counts": exception_counts,
        "rule_hits": rule_hits,
        "rule_rates": rule_rates,
        "mean_duration_sec": (
            round(sum(durations) / len(durations), 3) if durations else None
        ),
    }


async def run_eval(provider_id: str, repeat: int, out_path: Path) -> int:
    settings = get_settings()
    providers = create_agent_providers(settings)
    provider = providers[provider_id]
    cases = load_cases()
    report: dict[str, Any] = {
        "provider": provider_id,
        "repeat": repeat,
        "generated_at": datetime.now(UTC).isoformat(),
        "cases": [],
        "partial": True,
    }
    exit_code = 0
    try:
        for case in cases:
            case_report: dict[str, Any] = {
                "case_id": case["id"],
                "kind": case["kind"],
                "attempts": [],
            }
            report["cases"].append(case_report)
            for _ in range(repeat):
                try:
                    attempt = await run_attempt(
                        provider, case, settings.tag_dictionary_path
                    )
                except agent_base.AgentUnavailable as error:
                    report["fatal_error"] = {
                        "type": type(error).__name__,
                        "message": str(error),
                    }
                    exit_code = 1
                    break
                case_report["attempts"].append(attempt)
            if "fatal_error" in report:
                break
        report["partial"] = "fatal_error" in report
    finally:
        # 想定外の例外で抜けるときも、済んだ試行はここで書き出す。例外はそのまま伝わる。
        # `partial`は最後まで回り切ったときだけFalseへ戻るため、その場合はTrueのまま残る。
        await provider.aclose()
        report["summary"] = summarize(report["cases"])
        write_report(report, out_path)
        print_summary(report)
        if report["partial"]:
            print(
                f"途中で打ち切った。ここまでの結果を{out_path}へ書き出した。",
                file=sys.stderr,
            )
    return exit_code


def write_report(report: dict[str, Any], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def print_summary(report: dict[str, Any]) -> None:
    summary = report["summary"]
    print(
        f"=== prompt_eval: provider={report['provider']} repeat={report['repeat']} ==="
    )
    print(
        f"cases={len(report['cases'])} attempts={summary['total_attempts']} "
        f"ok={summary['ok_attempts']} exceptions={sum(summary['exception_counts'].values())}"
    )
    print(f"mean duration: {summary.get('mean_duration_sec')} sec")
    if summary["exception_counts"]:
        for exception_type, count in sorted(summary["exception_counts"].items()):
            print(f"  exception {exception_type}: {count}")
    print("rule violation rates (分母は出力を得られた試行数):")
    for rule in EVAL_RULE_IDS:
        rate = summary["rule_rates"].get(rule)
        hits = summary["rule_hits"].get(rule, 0)
        label = f"{rule} (reference)" if rule == "unknown_tag" else rule
        rate_text = "n/a" if rate is None else f"{rate:.2f}"
        print(f"  {label:<24}: {rate_text} ({hits}/{summary['ok_attempts']})")
    if report.get("partial"):
        print(f"partial=true fatal_error={report.get('fatal_error')}")


def compare_reports(base_path: Path, head_path: Path) -> int:
    try:
        base = json.loads(base_path.read_text(encoding="utf-8"))
        head = json.loads(head_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"レポートを読めない: {error}", file=sys.stderr)
        return 1
    base_rates = base.get("summary", {}).get("rule_rates", {})
    head_rates = head.get("summary", {}).get("rule_rates", {})
    print(f"=== compare: base={base_path.name} head={head_path.name} ===")
    print(f"{'rule':<24}{'base':>8}{'head':>8}{'diff':>8}")
    for rule in EVAL_RULE_IDS:
        base_rate = base_rates.get(rule)
        head_rate = head_rates.get(rule)
        diff_text = "n/a"
        if base_rate is not None and head_rate is not None:
            diff_text = f"{head_rate - base_rate:+.2f}"
        base_text = "n/a" if base_rate is None else f"{base_rate:.2f}"
        head_text = "n/a" if head_rate is None else f"{head_rate:.2f}"
        print(f"{rule:<24}{base_text:>8}{head_text:>8}{diff_text:>8}")
    base_summary = base.get("summary", {})
    head_summary = head.get("summary", {})
    for key in ("ok_attempts", "mean_duration_sec"):
        print(f"{key:<24}{base_summary.get(key)!s:>8}{head_summary.get(key)!s:>8}")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=PROVIDER_IDS)
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--out", type=Path)
    parser.add_argument(
        "--compare", nargs=2, metavar=("BASE", "HEAD"), type=Path, default=None
    )
    args = parser.parse_args(argv)
    if args.compare is None:
        if args.provider is None or args.out is None:
            parser.error("--provider と --out は --compare を使わないとき必須")
        if args.repeat < 1:
            parser.error("--repeat は1以上")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.compare is not None:
        return compare_reports(args.compare[0], args.compare[1])
    return asyncio.run(run_eval(args.provider, args.repeat, args.out))


if __name__ == "__main__":
    raise SystemExit(main())
