/**
 * 参照画像つき生成 (#474)。生成フォームの入力を参照Recipe (`anima_ref_incontext`) へ合わせる純関数。
 */
import type { LookProfile, ProjectReferenceImage, Recipe } from "../api/client";

export const DEFAULT_REFERENCE_STRENGTH = 1.0;

type SchemaMap = Record<string, unknown>;

function schemaOf(recipe: Recipe): SchemaMap {
  return recipe.input_schema as SchemaMap;
}

function specOf(recipe: Recipe, name: string): SchemaMap {
  const raw = schemaOf(recipe)[name];
  return typeof raw === "object" && raw !== null ? (raw as SchemaMap) : {};
}

/**
 * 参照Recipeを使えない理由。使えるなら`null`。`source_image`が無いRecipeは参照を受けられない。
 * 参照Recipeの必須入力 (既定値なし) のうち、通常のRecipeにも無いものは埋められないため使えない。
 */
export function referenceRecipeBlocker(referenceRecipe: Recipe, baseRecipe: Recipe): string | null {
  if (!("source_image" in schemaOf(referenceRecipe))) {
    return "参照Recipeに参照画像の入力 (source_image) が無いため、参照画像は使いません。";
  }
  const missing = Object.keys(schemaOf(referenceRecipe)).filter((name) => {
    if (name === "source_image" || name === "reference_strength") return false;
    const spec = specOf(referenceRecipe, name);
    return spec.required === true && spec.default === undefined && !(name in schemaOf(baseRecipe));
  });
  if (missing.length > 0) {
    return `参照Recipeの必須入力 (${missing.join(", ")}) を埋められないため、参照画像は使いません。`;
  }
  return null;
}

/** 参照強度の範囲。参照Recipeの`reference_strength`に最小・最大があればそれを使い、無ければ0〜2。 */
export function referenceStrengthRange(referenceRecipe: Recipe): { min: number; max: number } {
  const spec = specOf(referenceRecipe, "reference_strength");
  const pick = (...keys: string[]): number | null => {
    for (const key of keys) if (typeof spec[key] === "number") return spec[key] as number;
    return null;
  };
  return { min: pick("minimum", "min") ?? 0, max: pick("maximum", "max") ?? 2 };
}

/**
 * 入力を参照Recipeの`input_schema`のキーに絞り、`source_image`を足す。`reference_strength`は
 * schemaにあるときだけ足す。APIの`validate_against_input_schema`がschema外のキーを拒否するため。
 * 絞って外したキーも返す。
 */
export function toReferenceInputs(
  inputs: Record<string, unknown>,
  referenceRecipe: Recipe,
  image: ProjectReferenceImage,
  strength: number,
): { inputs: Record<string, unknown>; dropped: string[] } {
  const schema = schemaOf(referenceRecipe);
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(inputs)) {
    if (name in schema) kept[name] = value;
    else dropped.push(name);
  }
  kept.source_image = { relative_path: image.relative_path, sha256: image.sha256 };
  if ("reference_strength" in schema) kept.reference_strength = strength;
  return { inputs: kept, dropped };
}

/**
 * 選択中のLookProfileのうち、参照Recipeに合うものだけ残す。判定はAPIの検証 (別Recipe専用、
 * schema外の入力) と`LookProfileManager`の互換判定に合わせる。
 */
export function filterLookProfilesForRecipe(
  selectedIds: readonly string[],
  profiles: readonly LookProfile[],
  referenceRecipe: Recipe,
): { kept: string[]; dropped: string[] } {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const id of selectedIds) {
    const profile = byId.get(id);
    // 一覧に無いProfileは合うか判断できない。送ると422になりうるため、IDのまま外して知らせる。
    if (!profile) {
      dropped.push(id);
      continue;
    }
    const compatible =
      profile.kind === referenceRecipe.kind &&
      (profile.recipe_id === null || profile.recipe_id === referenceRecipe.id) &&
      [...Object.keys(profile.inputs)].every((name) => name in referenceRecipe.input_schema);
    if (compatible) kept.push(id);
    else dropped.push(profile.name);
  }
  return { kept, dropped };
}
