/**
 * プロンプト文字列のマージ。
 *
 * 既に入力されているプロンプトを保ったまま、AI補完やタグ抽出で得た内容を追記する。
 * 追記位置は Anima 系モデルで推奨されるタグ順に従う。
 *
 *   [quality / meta / year / rating] [count] [character] [series] [artist] [general tags]
 *
 * 自然文は関係を担う部分なので、タグより後ろへ原文のまま置く。
 */

/**
 * タグ順のブロック。数値が小さいものほど前に置く。
 *
 * character と series は語彙から機械的に判別できないため枠を設けず、general tags として
 * 扱う。判別できる quality / count / artist だけを前方へ寄せる。
 */
const BLOCK_QUALITY = 0;
const BLOCK_COUNT = 1;
const BLOCK_ARTIST = 2;
const BLOCK_GENERAL = 3;
const BLOCK_SENTENCE = 4;

/** quality / meta / year / rating 枠として扱う既知語。 */
const QUALITY_TAGS = new Set([
  "masterpiece",
  "best quality",
  "high quality",
  "normal quality",
  "low quality",
  "worst quality",
  "amazing quality",
  "great quality",
  "very awa",
  "highres",
  "absurdres",
  "lowres",
  "anime screenshot",
  "official art",
  "newest",
  "recent",
  "mid",
  "early",
  "old",
  "safe",
  "sensitive",
  "nsfw",
  "explicit",
  "questionable",
  "general",
]);

const COUNT_PATTERN = /^\d+(girls?|boys?|others?|koma)$/;
const SCORE_PATTERN = /^score_\d+(_up)?$/;
const YEAR_PATTERN = /^year[ _]\d{4}$/;

/** 自然文とみなす語数の下限。Danbooru のタグは長くても4語程度に収まる。 */
const SENTENCE_WORD_THRESHOLD = 5;

export interface PromptSegment {
  /** 元の文字列。前後の空白だけ落とした形で保つ。 */
  readonly text: string;
  /** 重複判定に使う正規化済みの文字列。 */
  readonly key: string;
  /** タグ順のブロック。 */
  readonly block: number;
}

/**
 * プロンプトをカンマ区切りのセグメントへ分解する。
 *
 * `hoshino ai \(oshi no ko\)` のようなエスケープ済みの括弧と、`(chibi:2)` のような
 * 重み付けの括弧の内側にあるカンマでは区切らない。
 */
export function splitPrompt(prompt: string): string[] {
  const segments: string[] = [];
  let current = "";
  let depth = 0;
  for (let index = 0; index < prompt.length; index += 1) {
    const char = prompt[index];
    if (char === "\\" && index + 1 < prompt.length) {
      current += char + prompt[index + 1];
      index += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/** 重複判定用の正規化。前後の空白と大文字小文字の違いを無視する。 */
export function normalizeSegment(segment: string): string {
  return segment.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** 重み付けと括弧を外した、分類のための素の文字列を返す。 */
function bareTag(segment: string): string {
  let text = segment.trim();
  // 重み付け `(tag:1.2)` から中身だけを取り出す。入れ子は外側から順に剥がす。
  let previous = "";
  while (previous !== text) {
    previous = text;
    text = text.replace(/^\((.*):\s*-?\d+(?:\.\d+)?\)$/s, "$1").trim();
    text = text.replace(/^\[(.*)\]$/s, "$1").trim();
  }
  return text.replace(/\s+/g, " ").toLocaleLowerCase();
}

/** セグメントを自然文として扱うか判定する。 */
function isSentence(segment: string): boolean {
  const text = bareTag(segment);
  if (/[.!?]/.test(text)) return true;
  return text.split(" ").filter(Boolean).length >= SENTENCE_WORD_THRESHOLD;
}

/**
 * セグメントが属するタグ順のブロックを返す。
 */
export function classifySegment(segment: string): number {
  if (isSentence(segment)) return BLOCK_SENTENCE;
  const text = bareTag(segment);
  if (text.startsWith("@")) return BLOCK_ARTIST;
  if (
    QUALITY_TAGS.has(text) ||
    SCORE_PATTERN.test(text) ||
    YEAR_PATTERN.test(text)
  ) {
    return BLOCK_QUALITY;
  }
  if (COUNT_PATTERN.test(text.replace(/\s+/g, ""))) return BLOCK_COUNT;
  return BLOCK_GENERAL;
}

function toSegment(text: string): PromptSegment {
  const trimmed = text.trim();
  return {
    text: trimmed,
    key: normalizeSegment(trimmed),
    block: classifySegment(trimmed),
  };
}

/** プロンプト文字列をセグメントの列へ変換する。 */
export function parsePrompt(prompt: string): PromptSegment[] {
  return splitPrompt(prompt).map(toSegment);
}

/**
 * 既存プロンプトへ追加分をマージする。
 *
 * - 既存セグメントどうしの並び順は変えない。
 * - 追加分は同じブロックの既存セグメントの直後へ入れる。該当ブロックが無ければ、
 *   自分より前のブロックの直後へ入れる。前のブロックも無ければ先頭へ置く。
 * - 既に同じセグメントがあるときは追加しない。追加分どうしの重複も1つにまとめる。
 */
export function mergePrompt(current: string, incoming: string): string {
  const segments = parsePrompt(current);
  const additions = parsePrompt(incoming);
  const seen = new Set(segments.map((segment) => segment.key));

  for (const addition of additions) {
    if (seen.has(addition.key)) continue;
    seen.add(addition.key);
    let insertAt = -1;
    for (let index = 0; index < segments.length; index += 1) {
      if (segments[index].block <= addition.block) {
        insertAt = index;
      }
    }
    segments.splice(insertAt + 1, 0, addition);
  }

  return segments.map((segment) => segment.text).join(", ");
}
