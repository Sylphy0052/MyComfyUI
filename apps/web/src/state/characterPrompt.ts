/**
 * キャラクター工程の生成プロンプトを組む (F-15 #154 Web側)。
 *
 * 計画で選んだキャラクター (`NamedItem`) を、Projectのローカルキャラクター定義
 * (`ProjectCharacterProfile`) と場面ごとの衣装指定 (`scene_outfits`) へ突き合わせ、
 * 「名前, 外見, prompt, 衣装プロンプト」を空要素を除いて連結する。API・DBは変えない純関数。
 * ネガティブプロンプトの合成は`characterNegativePrompt` (#287) を参照。
 */
import type { ProjectCharacterProfile } from "../api/client";
import type { NamedItem } from "./productionPlan";

/** `ProjectLocalOverrides.scene_outfits`: `{ [sceneId]: { [characterId]: outfitId } }` */
export type SceneOutfits = Record<string, Record<string, string>>;

/** idが一致しなければ名前で一致させる。どちらも一致しなければローカル定義なし。 */
export function findLocalCharacter(
  item: NamedItem,
  characters: readonly ProjectCharacterProfile[],
): ProjectCharacterProfile | undefined {
  return (
    characters.find((candidate) => candidate.id === item.id) ??
    characters.find((candidate) => candidate.name === item.name)
  );
}

/** 場面で選択中の衣装、無ければ既定の衣装のprompt。どちらも無ければ空文字。 */
export function selectedOutfitPrompt(
  character: ProjectCharacterProfile,
  selectedOutfitId: string | undefined,
): string {
  const outfits = character.outfits ?? [];
  const outfitId = selectedOutfitId ?? character.default_outfit_id ?? undefined;
  if (!outfitId) return "";
  return outfits.find((outfit) => outfit.id === outfitId)?.prompt ?? "";
}

/** キャラクター工程のプロンプトを組む。ローカル定義が無いキャラクターは名前だけ使う。 */
export function characterPrompt(
  items: readonly NamedItem[],
  characters: readonly ProjectCharacterProfile[],
  sceneOutfits: SceneOutfits,
  sceneId: string | null,
): string {
  const outfitSelections = (sceneId && sceneOutfits[sceneId]) || {};
  return items
    .map((item) => {
      const character = findLocalCharacter(item, characters);
      if (!character) return item.name;
      const parts = [
        character.name,
        character.appearance ?? "",
        character.prompt ?? "",
        selectedOutfitPrompt(character, outfitSelections[character.id]),
      ].filter((part) => part.trim().length > 0);
      return parts.join(", ");
    })
    .filter((part) => part.length > 0)
    .join(", ");
}

/**
 * キャラクター工程のネガティブプロンプトを組む。選択中キャラの`negative_prompt`を
 * 空要素を除いて連結する。ローカル定義が無いキャラクターは寄与しない。
 */
export function characterNegativePrompt(
  items: readonly NamedItem[],
  characters: readonly ProjectCharacterProfile[],
): string {
  return items
    .map((item) => findLocalCharacter(item, characters)?.negative_prompt ?? "")
    .filter((part) => part.trim().length > 0)
    .join(", ");
}
