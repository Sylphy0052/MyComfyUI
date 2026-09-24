/**
 * 「変えたい要素」の選択から、投入するテンプレートと参照強度を決める対応表 (Issue #159)。
 *
 * 採用値の正本は `novel-writer/検証_reference/029_final_synthesis/README.md:20-25`。
 * モードBの画面ではdenoise/参照強度といった技術語を出さないため、対応はここに
 * 1か所へ集約し、`ImageChangePanel`はこの結果だけを使ってJobを組み立てる。
 */

export const CHANGE_OPERATION_VALUES = ["pose", "expression", "outfit"] as const;
export type ChangeOperation = (typeof CHANGE_OPERATION_VALUES)[number];

export const CHANGE_OPERATION_LABELS: Record<ChangeOperation, string> = {
  pose: "ポーズ",
  expression: "表情",
  outfit: "衣装",
};

export const CHANGE_OPERATIONS: { value: ChangeOperation; label: string }[] =
  CHANGE_OPERATION_VALUES.map((value) => ({
    value,
    label: CHANGE_OPERATION_LABELS[value],
  }));

export type ChangeTemplateName = "anima_ref_siglip" | "anima_ref_incontext";

/** Recipe名は `bootstrap.py` 側の登録名と合わせる。テンプレートが見つからないときの案内に使う。 */
export const CHANGE_TEMPLATE_RECIPE_LABELS: Record<ChangeTemplateName, string> = {
  anima_ref_siglip: "Anima 参照 ポーズ・表情",
  anima_ref_incontext: "Anima 参照 衣装",
};

/**
 * 参照強度の入力上限。`apps/api/src/mycomfyui_api/adapters/comfyui/workflow.py`の
 * `_coerce`が持つreference_strengthの上限 (2.0) と揃える。コード共有はしていないため、
 * どちらかを変えたらもう一方も直す。
 */
export const REFERENCE_STRENGTH_MAX = 2;

export interface ChangePlan {
  templateName: ChangeTemplateName;
  referenceStrength: number;
}

/**
 * 変えたい要素の選択からテンプレートと参照強度を決める。
 * - 衣装を含まない (ポーズ・表情のどちらか/両方) → anima_ref_siglip, 0.5
 * - 衣装だけ → anima_ref_incontext, 1.0
 * - 衣装 + ポーズか表情 (両方でも) → anima_ref_incontext, 1.5
 * 未選択はnullを返し、呼び出し側で投入不可にする。
 */
export function planForOperations(
  operations: ReadonlySet<ChangeOperation>,
): ChangePlan | null {
  if (operations.size === 0) return null;
  const hasOutfit = operations.has("outfit");
  const hasPoseOrExpression = operations.has("pose") || operations.has("expression");
  if (!hasOutfit) return { templateName: "anima_ref_siglip", referenceStrength: 0.5 };
  if (!hasPoseOrExpression) return { templateName: "anima_ref_incontext", referenceStrength: 1.0 };
  return { templateName: "anima_ref_incontext", referenceStrength: 1.5 };
}
