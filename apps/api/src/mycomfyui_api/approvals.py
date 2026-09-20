"""副作用のある操作の分類と、承認記録の突き合わせ。

許可リストは、許可する操作種別を並べる形で持つ。拒否したい種別を数え上げる形にすると、
新しい操作種別を足したときに既定で通ってしまうためである。ここに無い種別は実行しない。

承認は対象と内容ごとに1回だけ有効とする。記録した操作のdigestを実行直前に再計算し、
一致しない承認を使い回せないようにする。
"""

import hashlib
import json
from datetime import datetime, timedelta
from typing import Any, Literal

#: 承認記録の対象種別。
SUBJECT_TYPE_AGENT_PROPOSAL = "agent_proposal"

#: 提案の取得。外部へ問い合わせるだけで、MyComfyUI側の状態を変えない。
OPERATION_AGENT_PROPOSE = "agent.propose"
#: 生成Jobの投入。GPUを使い、Artifactと履歴を作る。
OPERATION_GENERATION_JOB_CREATE = "generation_job.create"
#: Recipeの登録。既存のWorkflow版に対する新しいRecipeを作る。実行できるWorkflow
#: テンプレートは増えない。
OPERATION_RECIPE_CREATE = "recipe.create"
#: Artifactのタグ付与・除去。ファイルには触れない。
OPERATION_ARTIFACT_TAG_UPDATE = "artifact_tag.update"
#: 資産ファイルの移動。Artifact store内でのみ動かし、store外へは出さない。
OPERATION_FILE_MOVE = "file.move"
#: Git操作。本Issueでは実装しない。
OPERATION_GIT_COMMIT = "git.commit"
#: 外部への送信。本Issueでは実装しない。
OPERATION_EXTERNAL_SEND = "external.send"

OperationEffect = Literal["no_side_effect", "requires_approval", "forbidden"]

#: 操作種別ごとの扱い。`forbidden`は承認があっても実行しない。
OPERATION_POLICIES: dict[str, OperationEffect] = {
    OPERATION_AGENT_PROPOSE: "no_side_effect",
    OPERATION_GENERATION_JOB_CREATE: "requires_approval",
    OPERATION_RECIPE_CREATE: "requires_approval",
    OPERATION_ARTIFACT_TAG_UPDATE: "requires_approval",
    OPERATION_FILE_MOVE: "requires_approval",
    OPERATION_GIT_COMMIT: "forbidden",
    OPERATION_EXTERNAL_SEND: "forbidden",
}


class OperationNotAllowed(Exception):
    """許可リストに無い、または実装していない操作を要求された。"""


class ApprovalInvalid(Exception):
    """承認が無い、内容が変わった、または期限が切れている。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def effect_of(operation_type: str) -> OperationEffect:
    """操作種別の扱いを返す。許可リストに無ければ拒否する。"""
    effect = OPERATION_POLICIES.get(operation_type)
    if effect is None:
        raise OperationNotAllowed(f"許可していない操作種別です: {operation_type}")
    return effect


def require_executable(operation_type: str) -> OperationEffect:
    """実行してよい操作かを確かめる。

    許可リストに無い種別と`forbidden`の種別は、承認があっても実行しない。
    """
    effect = effect_of(operation_type)
    if effect == "forbidden":
        raise OperationNotAllowed(f"実行を許可していない操作種別です: {operation_type}")
    return effect


def operation_digest(operation: dict[str, Any]) -> str:
    """操作内容のdigest。

    承認したときと実行するときで対象や差分が変わっていないことを、この値の一致で判定
    する。キー順と空白で値が変わらないよう、正規化したJSONから計算する。
    """
    canonical = json.dumps(
        operation, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def requested_operation(operation: dict[str, Any]) -> dict[str, Any]:
    """ApprovalLogへ保存する形。操作内容とそのdigestを一緒に残す。"""
    return {**operation, "digest": operation_digest(operation)}


def expires_at(decided_at: str, ttl_seconds: int) -> str:
    """承認の有効期限。判断時刻から一定時間で切れる。"""
    return (
        datetime.fromisoformat(decided_at) + timedelta(seconds=ttl_seconds)
    ).isoformat()


def is_expired(expiry: str | None, now: str) -> bool:
    """期限切れかを判定する。期限が無い記録は切れない扱いとする。

    期限の文字列を解釈できない記録は、期限切れとして扱う。壊れた値を無期限の承認へ
    読み替えないためである。
    """
    if expiry is None:
        return False
    try:
        deadline = datetime.fromisoformat(expiry)
        current = datetime.fromisoformat(now)
    except ValueError:
        return True
    return current > deadline


def verify(
    record: Any, operation: dict[str, Any], *, now: str, subject_id: str
) -> None:
    """承認記録が、今から実行する操作に対して有効かを確かめる。

    `record`はApprovalLogの1行とする。対象、判断、内容のdigest、期限のいずれかが
    合わなければ実行しない。承認を別の対象や別の内容へ使い回せないようにする。
    """
    if record is None:
        raise ApprovalInvalid("APPROVAL_REQUIRED", "承認の記録がありません。")
    if (
        getattr(record, "subject_type", None) != SUBJECT_TYPE_AGENT_PROPOSAL
        or getattr(record, "subject_id", None) != subject_id
    ):
        raise ApprovalInvalid("APPROVAL_REQUIRED", "承認の対象が一致しません。")
    if getattr(record, "decision", None) != "approved":
        raise ApprovalInvalid("APPROVAL_REQUIRED", "承認されていません。")
    stored = getattr(record, "requested_operation", None)
    recorded_digest = stored.get("digest") if isinstance(stored, dict) else None
    if recorded_digest != operation_digest(operation):
        raise ApprovalInvalid(
            "APPROVAL_STALE",
            "承認した操作の内容と一致しません。承認を取り直してください。",
        )
    if is_expired(getattr(record, "expires_at", None), now):
        raise ApprovalInvalid(
            "APPROVAL_EXPIRED",
            "承認の有効期限が切れています。承認し直してください。",
        )
