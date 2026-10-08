import type { StoryCharacter, StoryCostume, StoryScene } from "../api/client";

/** 補完タグ。投入時は自由欄の前に置く。 */
export type SupplementTags = {
  positive: string[];
  negative: string[];
};

/** 重複の判定に使う形。大文字・小文字、`_`と空白、連続する空白の違いは同じタグとみなす。 */
export function tagKey(tag: string): string {
  return tag.trim().replace(/_/g, " ").replace(/\s+/g, " ").toLowerCase();
}

/** 先に出たものを残して重複を除く。空のタグも落とす。 */
export function uniqueTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    const key = tagKey(tag);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

/** 自由欄をカンマと改行で区切ってタグの並びにする。 */
export function splitPrompt(text: string): string[] {
  return text.split(/[,\n]/).map((part) => part.trim()).filter((part) => part !== "");
}

/** 投入するプロンプト。「補完タグ (外したものを除く)+自由欄」を、重複を除いてカンマで連結する。 */
export function composePrompt(supplement: readonly string[], excluded: readonly string[], free: string): string {
  const removed = new Set(excluded.map(tagKey));
  const kept = supplement.filter((tag) => !removed.has(tagKey(tag)));
  return uniqueTags([...kept, ...splitPrompt(free)]).join(", ");
}

/**
 * 投入済みのプロンプトを、今の補完タグを基準に「自由欄」と「外した補完タグ」へ分け直す。
 * 入力欄へ戻すときに使う。補完タグに無いタグは自由欄へ、プロンプトに無い補完タグは外したものとする。
 */
export function partitionPrompt(prompt: string, supplement: readonly string[]): { free: string; excluded: string[] } {
  const tokens = splitPrompt(prompt);
  const supplementKeys = new Set(supplement.map(tagKey));
  const tokenKeys = new Set(tokens.map(tagKey));
  return {
    free: tokens.filter((token) => !supplementKeys.has(tagKey(token))).join(", "),
    excluded: supplement.filter((tag) => !tokenKeys.has(tagKey(tag))),
  };
}

/** 自由欄の差分の1項目。 */
export type TagDiffEntry = { kind: "added" | "removed" | "same"; tag: string };

/** 変換前後のプロンプトをタグ単位で比べる。前にあって後に無いものは`removed`、逆は`added`。後の並びを基準に、消えたタグを末尾へ足す。 */
export function diffTags(before: string, after: string): TagDiffEntry[] {
  const beforeTags = uniqueTags(splitPrompt(before));
  const afterTags = uniqueTags(splitPrompt(after));
  const beforeKeys = new Set(beforeTags.map(tagKey));
  const afterKeys = new Set(afterTags.map(tagKey));
  return [
    ...afterTags.map((tag): TagDiffEntry => ({ kind: beforeKeys.has(tagKey(tag)) ? "same" : "added", tag })),
    ...beforeTags.filter((tag) => !afterKeys.has(tagKey(tag))).map((tag): TagDiffEntry => ({ kind: "removed", tag })),
  ];
}

/** 外したタグか。 */
export function isExcluded(tag: string, excluded: readonly string[]): boolean {
  const key = tagKey(tag);
  return excluded.some((entry) => tagKey(entry) === key);
}

/** 時間帯はそのままDanbooruのタグ名として使える。 */
const TIME_OF_DAY_TAGS: Record<NonNullable<StoryScene["time_of_day"]>, string> = {
  morning: "morning",
  day: "day",
  sunset: "sunset",
  night: "night",
};

/**
 * Projectの設定から補完タグを合成する。
 * キャラの固定タグ+衣装タグ、Sceneがあれば背景・時間帯と、そのキャラのポーズ・表情を足す。
 * ネガティブはキャラと衣装のネガティブタグを合わせる。
 */
export function buildSupplementTags(
  character: StoryCharacter | null,
  costume: StoryCostume | null,
  scene: StoryScene | null,
): SupplementTags {
  const cast = scene && character ? scene.cast.find((entry) => entry.character_id === character.id) : undefined;
  const positive = [
    ...(character?.fixed_tags ?? []),
    ...(costume?.tags ?? []),
    ...(scene?.background_tags ?? []),
    ...(scene?.time_of_day ? [TIME_OF_DAY_TAGS[scene.time_of_day]] : []),
    ...(cast?.pose_tags ?? []),
    ...(cast?.expression_tags ?? []),
  ];
  const negative = [...(character?.negative_tags ?? []), ...(costume?.negative_tags ?? [])];
  return { positive: uniqueTags(positive), negative: uniqueTags(negative) };
}
