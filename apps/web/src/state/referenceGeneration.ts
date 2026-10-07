/**
 * 参照画像つき生成 (#474)。生成フォームの入力を参照Recipe (`anima_ref_incontext`) へ合わせる純関数。
 */
import type { LookProfile, ProjectReferenceImage, Recipe } from "../api/client";

export const DEFAULT_REFERENCE_STRENGTH = 1.0;

/**
 * 入力を参照Recipeの`input_schema`のキーに絞り、`source_image`と`reference_strength`を足す。
 * APIの`validate_against_input_schema`がschema外のキーを拒否するため。絞って外したキーも返す。
 */
export function toReferenceInputs(
  inputs: Record<string, unknown>,
  referenceRecipe: Recipe,
  image: ProjectReferenceImage,
  strength: number,
): { inputs: Record<string, unknown>; dropped: string[] } {
  const schema = referenceRecipe.input_schema as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(inputs)) {
    if (name in schema) kept[name] = value;
    else dropped.push(name);
  }
  kept.source_image = { relative_path: image.relative_path, sha256: image.sha256 };
  kept.reference_strength = strength;
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
): { kept: string[]; dropped: LookProfile[] } {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const kept: string[] = [];
  const dropped: LookProfile[] = [];
  for (const id of selectedIds) {
    const profile = byId.get(id);
    // 一覧に無いProfileは合うか判断できない。送ると422になりうるため外す。
    if (!profile) continue;
    const compatible =
      profile.kind === referenceRecipe.kind &&
      (profile.recipe_id === null || profile.recipe_id === referenceRecipe.id) &&
      [...Object.keys(profile.inputs)].every((name) => name in referenceRecipe.input_schema);
    if (compatible) kept.push(id);
    else dropped.push(profile);
  }
  return { kept, dropped };
}
