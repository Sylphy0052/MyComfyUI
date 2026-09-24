"""利用者が編集したWorkflowグラフの検証。

Issue #110: 固定Workflowの再現性を維持しながら、利用者が許可済みnodeだけでグラフを
編集し、検証済みWorkflow版として登録できるようにする。任意のComfyUI graphをそのまま
実行しないため、登録前にこの検証を必ず通す。

グラフの形はComfyUIのAPI形式(`{node_id: {"class_type": str, "inputs": {...}}}`)に
揃える。`adapters/comfyui/workflow.py`の`_validate_structure`は既知の固定bindingに
対する検証で、node数・構成があらかじめ分かっている前提のため流用できない。ここでは
任意の構成を受け取り、node class allowlist・循環・不正link・出力不足を汎用的に検査
する。

node class allowlistは同梱テンプレート(`adapters/comfyui/workflow.py:ALLOWED_TEMPLATES`)
が使っている既知のclass_typeを土台にする。未審査のcustom nodeやtypoによる未知class_type
は、ここに無ければ理由を問わず拒否する。ファイル・外部通信・プロセス実行能力を持つ
node種別は現時点でallowlistに含めていない。将来含める場合は`NodeCapability`で明示し、
安全側(能力タグ無し)を既定にする。
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from enum import Flag, auto
from typing import Any

#: 検証を受け付けるグラフのnode数上限。同梱テンプレートの最大構成(数十node)の
#: 数倍を見込む。再帰DFSに依らない構造にしても、上限が無いと巨大グラフによる
#: DoSの余地が残るため、`validate_graph`側で先に拒否する。
MAX_GRAPH_NODES = 500
#: `model_slots`/`inputs`/`outputs`それぞれの宣言件数の上限。node数と同じ考え方で置く。
MAX_SLOT_ENTRIES = MAX_GRAPH_NODES


class NodeCapability(Flag):
    """node classが持ちうる、審査対象の能力。既定は無し(SAFE)。"""

    NONE = 0
    FILE_IO = auto()
    NETWORK = auto()
    PROCESS_EXEC = auto()


@dataclass(frozen=True)
class AllowedNodeClass:
    class_type: str
    capabilities: NodeCapability = NodeCapability.NONE
    #: このnodeをWorkflowの出力(生成物の確定点)とみなすか。
    is_output: bool = False


#: 審査済みnode classの登録簿。同梱テンプレートで実績のある構成要素だけを許可する。
#: 新しいnode classを足すときは、ファイル・外部通信・プロセス実行能力を確認してから
#: `capabilities`を明示する。無審査での追加を避けるため、既定値の緩和はしない。
ALLOWED_NODE_CLASSES: dict[str, AllowedNodeClass] = {
    node.class_type: node
    for node in (
        AllowedNodeClass("CheckpointLoaderSimple"),
        AllowedNodeClass("CLIPLoader"),
        AllowedNodeClass("CLIPTextEncode"),
        AllowedNodeClass("Canny"),
        AllowedNodeClass("ControlNetApplyAdvanced"),
        AllowedNodeClass("ControlNetLoader"),
        AllowedNodeClass("CreateVideo"),
        AllowedNodeClass("EmptyAceStepLatentAudio"),
        AllowedNodeClass("EmptyLatentImage"),
        AllowedNodeClass("ImageUpscaleWithModel"),
        AllowedNodeClass("KSampler"),
        AllowedNodeClass("KSamplerSelect"),
        AllowedNodeClass("LoadAudio"),
        AllowedNodeClass("LoadImage"),
        AllowedNodeClass("LoadImageMask"),
        AllowedNodeClass("MiniMaxH3AddGuide"),
        AllowedNodeClass("MiniMaxH3ImageToVideo"),
        AllowedNodeClass("MiniMaxH3ReferenceToVideo"),
        AllowedNodeClass("RandomNoise"),
        AllowedNodeClass("SamplerCustomAdvanced"),
        AllowedNodeClass("BasicGuider"),
        AllowedNodeClass("BasicScheduler"),
        AllowedNodeClass("SaveAudio", is_output=True),
        AllowedNodeClass("SaveImage", is_output=True),
        AllowedNodeClass("SaveVideo", is_output=True),
        AllowedNodeClass("TextEncodeAceStepAudio"),
        AllowedNodeClass("UNETLoader"),
        AllowedNodeClass("UpscaleModelLoader"),
        AllowedNodeClass("VAEDecode"),
        AllowedNodeClass("VAEDecodeAudio"),
        AllowedNodeClass("VAEEncode"),
        AllowedNodeClass("VAEEncodeForInpaint"),
        AllowedNodeClass("VAELoader"),
    )
}


class GraphValidationError(Exception):
    """登録前検証で拒否した。`issues`に理由を人が読める形でまとめる。"""

    def __init__(self, issues: list[str]) -> None:
        super().__init__("; ".join(issues) if issues else "不正なWorkflowグラフです。")
        self.issues = issues


@dataclass(frozen=True)
class GraphValidationResult:
    node_classes: frozenset[str]
    capability_warnings: tuple[str, ...] = field(default_factory=tuple)


def _is_link_ref(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[0], str)
        and isinstance(value[1], int)
    )


def validate_graph(graph: dict[str, Any]) -> GraphValidationResult:
    """グラフを検証し、拒否理由が無ければnode class集合と能力警告を返す。

    検査項目 (受入基準に対応):
    - 未知node、許可外nodeの拒否
    - 循環の拒否
    - 存在しないnode/slotを指すlinkの拒否
    - 出力nodeが1つも無いグラフの拒否
    """
    issues: list[str] = []

    if not isinstance(graph, dict) or not graph:
        raise GraphValidationError(["グラフが空、または不正な形式です。"])
    if len(graph) > MAX_GRAPH_NODES:
        raise GraphValidationError(
            [f"グラフのnode数が上限({MAX_GRAPH_NODES})を超えています。"]
        )

    node_classes: set[str] = set()
    capability_warnings: list[str] = []
    adjacency: dict[str, set[str]] = {node_id: set() for node_id in graph}
    has_output = False

    for node_id, entry in graph.items():
        if not isinstance(entry, dict):
            issues.append(f"node {node_id} の定義が不正です。")
            continue
        class_type = entry.get("class_type")
        inputs = entry.get("inputs")
        if not isinstance(class_type, str) or not class_type:
            issues.append(f"node {node_id} にclass_typeがありません。")
            continue
        allowed = ALLOWED_NODE_CLASSES.get(class_type)
        if allowed is None:
            issues.append(
                f"node {node_id} のclass_type '{class_type}' は許可されていません。"
            )
            continue
        node_classes.add(class_type)
        if allowed.is_output:
            has_output = True
        if allowed.capabilities is not NodeCapability.NONE:
            capability_warnings.append(
                f"node {node_id} ({class_type}) は審査対象の能力を持ちます: "
                f"{allowed.capabilities!s}"
            )
        if inputs is None:
            continue
        if not isinstance(inputs, dict):
            issues.append(f"node {node_id} のinputsが不正です。")
            continue
        for input_name, value in inputs.items():
            if not _is_link_ref(value):
                continue
            target_id, _slot = value
            if target_id not in graph:
                issues.append(
                    f"node {node_id} の入力 '{input_name}' が存在しないnode "
                    f"{target_id} を参照しています。"
                )
                continue
            adjacency[node_id].add(target_id)

    if not has_output:
        issues.append("出力node(SaveImage等)が1つもありません。")

    cycle = _find_cycle(adjacency)
    if cycle is not None:
        issues.append(f"グラフに循環があります: {' -> '.join(cycle)}")

    if issues:
        raise GraphValidationError(issues)

    return GraphValidationResult(
        node_classes=frozenset(node_classes),
        capability_warnings=tuple(capability_warnings),
    )


def _find_cycle(adjacency: dict[str, set[str]]) -> list[str] | None:
    """深さ優先探索で循環を1つ見つける。無ければNone。

    再帰は使わない。`MAX_GRAPH_NODES`で上限を設けていても、直列に長く繋がった
    グラフでは再帰DFSが`RecursionError`を起こしうるため、明示的なスタックで
    深さ優先探索を行う。
    """
    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[str, int] = dict.fromkeys(adjacency, WHITE)

    for start in adjacency:
        if color[start] != WHITE:
            continue
        path: list[str] = [start]
        stack: list[tuple[str, Iterator[str]]] = [
            (start, iter(adjacency.get(start, ())))
        ]
        color[start] = GRAY
        while stack:
            node_id, neighbors = stack[-1]
            advanced = False
            for neighbor in neighbors:
                if color.get(neighbor, WHITE) == GRAY:
                    cycle_start = path.index(neighbor)
                    return [*path[cycle_start:], neighbor]
                if color.get(neighbor, WHITE) == WHITE:
                    color[neighbor] = GRAY
                    path.append(neighbor)
                    stack.append((neighbor, iter(adjacency.get(neighbor, ()))))
                    advanced = True
                    break
            if not advanced:
                color[node_id] = BLACK
                path.pop()
                stack.pop()
    return None


def canonical_graph_json(graph: dict[str, Any]) -> str:
    """SHA-256計算・保存に使う正規化JSON。キー順と空白を固定する。"""
    return json.dumps(graph, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def graph_sha256(graph: dict[str, Any]) -> str:
    """グラフ内容のSHA-256。版のimmutableな識別子として使う。"""
    return hashlib.sha256(canonical_graph_json(graph).encode("utf-8")).hexdigest()


def diff_graphs(old_graph: dict[str, Any], new_graph: dict[str, Any]) -> dict[str, Any]:
    """2つのグラフの差分。承認前にnode/edgeの変更点を確認できるようにする。"""
    old_ids = set(old_graph)
    new_ids = set(new_graph)
    added_nodes = sorted(new_ids - old_ids)
    removed_nodes = sorted(old_ids - new_ids)
    changed_nodes = sorted(
        node_id
        for node_id in old_ids & new_ids
        if old_graph.get(node_id) != new_graph.get(node_id)
    )
    old_classes = {
        entry.get("class_type")
        for entry in old_graph.values()
        if isinstance(entry, dict)
    }
    new_classes = {
        entry.get("class_type")
        for entry in new_graph.values()
        if isinstance(entry, dict)
    }
    return {
        "added_nodes": added_nodes,
        "removed_nodes": removed_nodes,
        "changed_nodes": changed_nodes,
        "added_node_classes": sorted(c for c in (new_classes - old_classes) if c),
        "removed_node_classes": sorted(c for c in (old_classes - new_classes) if c),
    }


def validate_slot_references(
    graph: dict[str, Any],
    node_classes: frozenset[str],
    *,
    model_slots: list[dict[str, Any]],
    inputs: list[dict[str, Any]],
    outputs: list[dict[str, Any]],
) -> None:
    """登録要求の`model_slots`/`inputs`/`outputs`が`graph`と矛盾しないか確かめる。

    宣言したnode id・node classがgraphに実在しないと、Recipe接続後の値の差し替えや
    モデル在庫確認が解決できず失敗する。フィールド構造全体は検証せず、参照先の実在
    だけを確かめる最小限の照合に留める。`node_classes`は`validate_graph`が返した
    グラフ内の既知class_type集合を再利用する。件数は各リストに`MAX_SLOT_ENTRIES`の
    上限を設け、巨大な宣言による過剰な走査を先に拒否する。
    """
    for label, entries in (
        ("model_slots", model_slots),
        ("inputs", inputs),
        ("outputs", outputs),
    ):
        if len(entries) > MAX_SLOT_ENTRIES:
            raise GraphValidationError(
                [f"{label}の件数が上限({MAX_SLOT_ENTRIES})を超えています。"]
            )
    issues: list[str] = []
    for slot in model_slots:
        if not isinstance(slot, dict):
            continue
        node_class = slot.get("node_class")
        if isinstance(node_class, str) and node_class not in node_classes:
            issues.append(
                f"model_slots '{slot.get('variable')}' が参照するnode_class "
                f"'{node_class}' はグラフに存在しません。"
            )
    for label, entries in (("inputs", inputs), ("outputs", outputs)):
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            node_id = entry.get("node_id")
            if isinstance(node_id, str) and node_id not in graph:
                issues.append(
                    f"{label}が参照するnode {node_id} はグラフに存在しません。"
                )
    if issues:
        raise GraphValidationError(issues)
