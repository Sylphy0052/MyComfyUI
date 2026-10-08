import type { StoryCharacter, StoryCostume, StoryScene } from "../api/client";

/** 複数人のときの、キャラ1人分の補完タグ。`label`はキャラ名。 */
export type SupplementGroup = { label: string; tags: string[] };

/**
 * 補完タグ。投入時は自由欄の前に置く。
 * 2人以上のときだけ`head` (人数・背景・時間帯) と`groups` (キャラごと) を持ち、`positive`は表示と外す操作用にそれらを平らに並べたもの。
 * 1人以下は`groups`が`null`で、`head`は空。
 */
export type SupplementTags = {
  positive: string[];
  negative: string[];
  head: string[];
  groups: SupplementGroup[] | null;
};

/** 複数人の組み合わせに使うキャラと衣装。 */
export type CastEntry = { character: StoryCharacter; costume: StoryCostume | null };

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
 * 投入するポジティブ。`groups`が無ければ`composePrompt`と同じ。
 * `groups`があるときは「先頭行・キャラごとの行・自由欄」を改行で連結し、行の中はカンマ区切りにする。
 * 重複は行の中だけで除き、外したタグは全行から除く。自由欄は補完タグのどれかと重なるタグを除く。空の行は出さない。
 * 行をまたぐ重複を残すのは、同じタグ (例: `long hair`) を持つキャラがそれぞれの行に書かれている必要があるため。
 * 自由欄はキャラに属さないので、どの行にあるタグも書き足す意味が無い。
 */
export function composePositive(supplement: SupplementTags, excluded: readonly string[], free: string): string {
  if (supplement.groups === null) return composePrompt(supplement.positive, excluded, free);
  const removed = new Set(excluded.map(tagKey));
  const lines = [supplement.head, ...supplement.groups.map((group) => group.tags)].map((tags) =>
    uniqueTags(tags.filter((tag) => !removed.has(tagKey(tag)))),
  );
  const keptKeys = new Set(lines.flat().map(tagKey));
  const freeTags = uniqueTags(splitPrompt(free)).filter((tag) => !keptKeys.has(tagKey(tag)));
  return [...lines, freeTags]
    .filter((tags) => tags.length > 0)
    .map((tags) => tags.join(", "))
    .join("\n");
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
  return { positive: uniqueTags(positive), negative: uniqueTags(negative), head: [], groups: null };
}

/** 人数を表すタグ。複数人では先頭行の人数タグへまとめるため、キャラごとの行からは除く。 */
const HEADCOUNT_TAG = /^(?:1girl|1boy|1other|solo|\d+\+?(?:girls|boys|others))$/;

/** 人数タグの数え方。並びは boys → girls → others。 */
const HEADCOUNT_KINDS = [
  { single: "1boy", plural: "boys" },
  { single: "1girl", plural: "girls" },
  { single: "1other", plural: "others" },
] as const;
/** Danbooruの人数タグは`6+girls`のように6人で頭打ちになる。 */
const HEADCOUNT_CAP = 6;

/** 各キャラの固定タグにある`1girl` / `1boy` / `1other`を数えて、`2girls`のような人数タグにする。無ければ空。 */
function headcountTags(characters: readonly StoryCharacter[]): string[] {
  const tags: string[] = [];
  for (const { single, plural } of HEADCOUNT_KINDS) {
    const count = characters.filter((character) => character.fixed_tags.some((tag) => tagKey(tag) === single)).length;
    if (count === 0) continue;
    if (count === 1) tags.push(single);
    else tags.push(count >= HEADCOUNT_CAP ? `${HEADCOUNT_CAP}+${plural}` : `${count}${plural}`);
  }
  return tags;
}

/**
 * 複数人の補完タグ。0〜1人は`buildSupplementTags`と同じ。
 * 2人以上は、先頭行 (人数タグ+背景+時間帯) と、キャラごとの行 (固定タグ-人数系タグ+衣装+ポーズ+表情) に分ける。
 * ネガティブは全員分と全衣装の和集合。
 */
export function buildCastSupplementTags(cast: readonly CastEntry[], scene: StoryScene | null): SupplementTags {
  const lead = cast[0];
  if (cast.length <= 1) return buildSupplementTags(lead?.character ?? null, lead?.costume ?? null, scene);
  const head = uniqueTags([
    ...headcountTags(cast.map((entry) => entry.character)),
    ...(scene?.background_tags ?? []),
    ...(scene?.time_of_day ? [TIME_OF_DAY_TAGS[scene.time_of_day]] : []),
  ]);
  const groups = cast.map(({ character, costume }): SupplementGroup => {
    const sceneCast = scene?.cast.find((entry) => entry.character_id === character.id);
    return {
      label: character.name,
      tags: uniqueTags([
        ...character.fixed_tags.filter((tag) => !HEADCOUNT_TAG.test(tagKey(tag))),
        ...(costume?.tags ?? []),
        ...(sceneCast?.pose_tags ?? []),
        ...(sceneCast?.expression_tags ?? []),
      ]),
    };
  });
  const negative = cast.flatMap(({ character, costume }) => [...character.negative_tags, ...(costume?.negative_tags ?? [])]);
  return {
    positive: uniqueTags([...head, ...groups.flatMap((group) => group.tags)]),
    negative: uniqueTags(negative),
    head,
    groups,
  };
}
