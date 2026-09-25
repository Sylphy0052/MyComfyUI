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
/** 空行で区切られた自然文の段落。カンマ区切りの文よりも後ろに置く。 */
const BLOCK_PARAGRAPH = 5;

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
  /** 空行で区切られた自然文の段落を、カンマで分けずに1つとして持つか。 */
  readonly paragraph: boolean;
}

/**
 * プロンプトをカンマ区切りのセグメントへ分解する。
 *
 * `hoshino ai \(oshi no ko\)` のようなエスケープ済みの括弧と、`(chibi:2)` のような
 * 重み付けの括弧の内側にあるカンマでは区切らない。
 */
export function splitPrompt(prompt: string): string[] {
  // 型の上では string だが、API の応答が欠けた場合でも例外にしない。
  if (!prompt) return [];
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
  // 絵師タグは `@` を前置する決まりなので、`@` の有無だけで判別する。
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

function toSegment(text: string, paragraph = false): PromptSegment {
  const trimmed = text.trim();
  return {
    text: trimmed,
    key: normalizeSegment(trimmed),
    block: paragraph ? BLOCK_PARAGRAPH : classifySegment(trimmed),
    paragraph,
  };
}

/**
 * プロンプト文字列をセグメントの列へ変換する。
 *
 * タグ行と自然文は空行で区切って組み立てる (API の`compose_positive_prompt`)。空行で
 * 段落に分け、先頭の段落はタグ行としてカンマで区切る。2つ目以降の段落は、文の区切りを
 * 1つでも含めば自然文として1つのセグメントに保つ。先頭の段落を常にタグ行とするのは、
 * `hoshino ai \(oshi no ko\)`のような5語以上のタグで始まるタグ行を自然文と取り違え
 * ないためで、API がタグ行を読むとき (`_current_tags`) と同じ扱いになる。
 */
export function parsePrompt(prompt: string): PromptSegment[] {
  if (!prompt) return [];
  return prompt.split(/\n[^\S\n]*\n/).flatMap((paragraph, index) => {
    const parts = splitPrompt(paragraph);
    if (index > 0 && parts.some(isSentence)) return [toSegment(paragraph, true)];
    return parts.map((part) => toSegment(part));
  });
}

/** セグメントをプロンプト文字列へ戻す。自然文の段落の前後は空行で区切る。 */
function joinSegments(segments: readonly PromptSegment[]): string {
  return segments
    .map((segment, index) => {
      if (index === 0) return segment.text;
      const previous = segments[index - 1];
      const separator = previous.paragraph || segment.paragraph ? "\n\n" : ", ";
      return separator + segment.text;
    })
    .join("");
}

/** 並び順を保ったまま、同じセグメントの2つ目以降を落とす。 */
function dedupe(segments: PromptSegment[]): PromptSegment[] {
  const seen = new Set<string>();
  const unique: PromptSegment[] = [];
  for (const segment of segments) {
    if (seen.has(segment.key)) continue;
    seen.add(segment.key);
    unique.push(segment);
  }
  return unique;
}

export interface MergeResult {
  /** マージ後のプロンプト文字列。 */
  readonly prompt: string;
  /** 実際に追加されたセグメントの数。0 なら内容は変わっていない。 */
  readonly added: number;
}

/**
 * 既存プロンプトへ追加分をマージする。
 *
 * - 既存セグメントどうしの並び順は変えない。
 * - 追加分は同じブロックの既存セグメントの直後へ入れる。該当ブロックが無ければ、
 *   自分より前のブロックの直後へ入れる。前のブロックも無ければ先頭へ置く。
 * - 既に同じセグメントがあるときは追加しない。追加分どうしの重複も1つにまとめる。
 * - 既存が空のときは、追加分を並べ替えず原文のまま入れる。
 */
export function mergePrompt(current: string, incoming: string): MergeResult {
  if (!current || !current.trim()) {
    // 並べ替えはせず受け取った順のまま入れる。重複と空のセグメントだけを落とす。
    const unique = dedupe(parsePrompt(incoming));
    return {
      prompt: joinSegments(unique),
      added: unique.length,
    };
  }

  const segments = parsePrompt(current);
  const additions = parsePrompt(incoming);
  const seen = new Set(segments.map((segment) => segment.key));
  let added = 0;

  for (const addition of additions) {
    if (seen.has(addition.key)) continue;
    seen.add(addition.key);
    added += 1;
    let insertAt = -1;
    for (let index = 0; index < segments.length; index += 1) {
      if (segments[index].block <= addition.block) {
        insertAt = index;
      }
    }
    segments.splice(insertAt + 1, 0, addition);
  }

  // 追加が無いときは既存の表記をそのまま返し、空白やカンマの書き方を変えない。
  if (added === 0) return { prompt: current.trim(), added: 0 };
  return { prompt: joinSegments(segments), added };
}

/**
 * プロンプトの差分。
 *
 * - `add`: `after`のセグメントを新たに入れる。`before`は無い。
 * - `remove`: `before`のセグメントを取り除く。`after`は無い。
 * - `change`: 重み付けなど、素の語は同じだが表記が変わったセグメントを`before`から
 *   `after`へ置き換える。
 *
 * `id`は同じ`current`と`proposed`の組み合わせなら常に同じ値になる。採否の状態を
 * `id`をキーに保持し、`applyPromptDiff`へそのまま渡せるようにするためである。
 *
 * `id`自体は配列内の位置 (`change:${match}` 等) から作るが、`parsePrompt`と重複除去の
 * 出力順序は入力が同じなら常に同じになるため、同じ`current`と`proposed`からは常に同じ
 * 位置に同じ内容が並び、結果として`id`も安定する。
 */
export interface DiffHunk {
  readonly id: string;
  readonly kind: "add" | "remove" | "change";
  readonly before: PromptSegment | null;
  readonly after: PromptSegment | null;
}

/** セグメント配列を、キー関数の値ごとの出現位置一覧へまとめる。 */
function groupIndices(
  segments: readonly PromptSegment[],
  keyOf: (segment: PromptSegment) => string,
): Map<string, number[]> {
  const map = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    const key = keyOf(segment);
    const list = map.get(key);
    if (list) {
      list.push(index);
    } else {
      map.set(key, [index]);
    }
  });
  return map;
}

/**
 * 既存プロンプトと提案プロンプトを比較し、追加・削除・変更の単位へ分解する。
 *
 * 既存プロンプトを保ったまま、どの単位を反映するかを利用者が選べるようにするための
 * 前段になる。マッチングは次の順で行う。
 *
 * 1. 完全一致 (`key`が同じ) は変更なしとして扱い、どちらのhunkにもしない。
 * 2. 素の語 (`bareTag`) が一致するものは、重み付けなどが変わった`change`にする。
 * 3. 既存側だけに残ったものは`remove`、提案側だけに残ったものは`add`にする。
 *
 * 既存セグメントどうしの並び順や、既存・提案それぞれの中の重複は
 * `applyPromptDiff`側で吸収するため、ここでは判定だけを行う。
 */
export function diffPrompt(current: string, proposed: string): DiffHunk[] {
  const currentSegments = parsePrompt(current);
  const proposedSegments = dedupe(parsePrompt(proposed));

  const consumedCurrent = new Set<number>();
  const consumedProposed = new Set<number>();

  const currentByExact = groupIndices(currentSegments, (segment) => segment.key);
  proposedSegments.forEach((segment, index) => {
    const candidates = currentByExact.get(segment.key);
    const match = candidates?.find((value) => !consumedCurrent.has(value));
    if (match === undefined) return;
    consumedCurrent.add(match);
    consumedProposed.add(index);
  });

  const currentByBase = groupIndices(currentSegments, (segment) => bareTag(segment.text));
  const changeHunks: DiffHunk[] = [];
  proposedSegments.forEach((segment, index) => {
    if (consumedProposed.has(index)) return;
    const candidates = currentByBase.get(bareTag(segment.text));
    const match = candidates?.find((value) => !consumedCurrent.has(value));
    if (match === undefined) return;
    consumedCurrent.add(match);
    consumedProposed.add(index);
    changeHunks.push({
      id: `change:${match}`,
      kind: "change",
      before: currentSegments[match],
      after: segment,
    });
  });

  const removeHunks: DiffHunk[] = currentSegments.reduce<DiffHunk[]>(
    (hunks, segment, index) => {
      if (consumedCurrent.has(index)) return hunks;
      hunks.push({ id: `remove:${index}`, kind: "remove", before: segment, after: null });
      return hunks;
    },
    [],
  );

  const addHunks: DiffHunk[] = proposedSegments.reduce<DiffHunk[]>(
    (hunks, segment, index) => {
      if (consumedProposed.has(index)) return hunks;
      hunks.push({ id: `add:${index}`, kind: "add", before: null, after: segment });
      return hunks;
    },
    [],
  );

  return [...changeHunks, ...removeHunks, ...addHunks];
}

/**
 * `diffPrompt`が返したhunkのうち、`acceptedIds`にあるものだけを既存プロンプトへ反映
 * する。
 *
 * - 不採用のhunkは既存の記述をそのまま残す。`remove`を不採用にすれば消えず、
 *   `change`を不採用にすれば元の表記のまま残る。
 * - `add`の反映位置は`mergePrompt`と同じ規約 (タグ順のブロックに沿って既存セグメント
 *   の直後へ挿入) に従う。
 * - 既存プロンプトが空のときは、`mergePrompt`同様に並べ替えず提案側の順のまま入れる。
 * - 採用したhunkが1つも無いときは`current`をそのまま返す。分解して組み直すと、差分を
 *   見せていない欄でも空白やカンマの書き方が変わってしまうため。
 */
export function applyPromptDiff(
  current: string,
  hunks: readonly DiffHunk[],
  acceptedIds: ReadonlySet<string>,
): string {
  if (!hunks.some((hunk) => acceptedIds.has(hunk.id))) return current;

  const currentSegments = parsePrompt(current);

  if (currentSegments.length === 0) {
    const seen = new Set<string>();
    const ordered: PromptSegment[] = [];
    for (const hunk of hunks) {
      if (hunk.kind !== "add" || !hunk.after) continue;
      if (!acceptedIds.has(hunk.id)) continue;
      if (seen.has(hunk.after.key)) continue;
      seen.add(hunk.after.key);
      ordered.push(hunk.after);
    }
    return joinSegments(ordered);
  }

  // `id`は`diffPrompt`が付けた`remove:<index>`/`change:<index>`の形式で、`index`は
  // `currentSegments`上の位置を指す。重複するセグメントが複数あっても、キーではなく
  // 位置で引き当てるため取り違えない。
  const working: (PromptSegment | null)[] = [...currentSegments];
  for (const hunk of hunks) {
    if (hunk.kind === "add") continue;
    if (!acceptedIds.has(hunk.id)) continue;
    const index = Number(hunk.id.split(":")[1]);
    if (!Number.isInteger(index) || index < 0 || index >= working.length) continue;
    if (hunk.kind === "remove") {
      working[index] = null;
    } else if (hunk.kind === "change" && hunk.after) {
      working[index] = hunk.after;
    }
  }

  let result = working.filter((segment): segment is PromptSegment => segment !== null);
  const seen = new Set(result.map((segment) => segment.key));

  for (const hunk of hunks) {
    if (hunk.kind !== "add" || !hunk.after) continue;
    if (!acceptedIds.has(hunk.id)) continue;
    if (seen.has(hunk.after.key)) continue;
    seen.add(hunk.after.key);
    const addition = hunk.after;
    let insertAt = -1;
    for (let index = 0; index < result.length; index += 1) {
      if (result[index].block <= addition.block) insertAt = index;
    }
    result = [...result.slice(0, insertAt + 1), addition, ...result.slice(insertAt + 1)];
  }

  return joinSegments(result);
}
