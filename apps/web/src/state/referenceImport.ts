/**
 * 参照画像の一括取り込み (#473)。`<キャラ>_<衣装>.png`の立ち絵を、キャラクターの
 * 衣装の参照セット(`full_body`枠)へ振り分ける。API・DBは変えない純関数。
 *
 * 取り込みは2段階にする。`planReferenceImport`がアップロード前にファイル名だけで
 * スキップを判定し、対象だけをアップロードしたあと、`applyReferenceImport`が保存直前に
 * 取り直した最新の`local_overrides`へ振り分けて適用する。
 */
import type {
  ProjectCharacterOutfit,
  ProjectCharacterProfile,
  ProjectLocalOverrides,
  ProjectReferenceImage,
  ProjectReferenceSet,
} from "../api/client";
import type { ReferenceSlotKey } from "./referenceSlots";
import { findReferenceSet } from "./referenceSlots";

/** 取り込み先の枠。 */
export const IMPORT_SLOT_KEY: ReferenceSlotKey = "full_body";
/** 1キャラクターの衣装の上限 (`ProjectCharacterProfile.outfits`)。 */
export const MAX_OUTFITS = 100;

export interface ParsedReferenceName {
  character: string;
  outfit: string;
}

export interface ReferenceImportSkip {
  fileName: string;
  reason: string;
}

export interface ReferenceImportPlan {
  /** アップロードして取り込む対象のファイル名。 */
  targets: string[];
  skipped: ReferenceImportSkip[];
}

export interface ReferenceImportEntry {
  /** 元のファイル名 (振り分けの解析に使う)。 */
  fileName: string;
  image: ProjectReferenceImage;
}

export type ReferenceImportKind = "registered" | "overwritten" | "unchanged";

export interface ReferenceImportResult {
  fileName: string;
  kind: ReferenceImportKind;
  characterName: string;
  outfitName: string;
  newOutfit: boolean;
  /** 上書きした旧ファイル名。 */
  previousFileName?: string;
}

export interface ReferenceImportReport {
  results: ReferenceImportResult[];
  skipped: ReferenceImportSkip[];
}

const normalize = (value: string) => value.normalize("NFKC").trim();
const sortedChars = (value: string) => Array.from(value).sort().join("");

/** ファイル名を「キャラ部分」「衣装部分」へ分ける。命名規則外ならnull。 */
export function parseReferenceName(fileName: string): ParsedReferenceName | null {
  const stem = normalize(fileName).replace(/\.[^./]+$/, "");
  const index = stem.indexOf("_");
  if (index < 0) return null;
  const character = stem.slice(0, index).trim();
  const outfit = stem.slice(index + 1).trim();
  if (!character || !outfit) return null;
  return { character, outfit };
}

type CharacterMatch =
  | { kind: "found"; character: ProjectCharacterProfile }
  | { kind: "none" }
  | { kind: "ambiguous" };

/** 名前の完全一致を優先し、無ければ名前にキャラ部分を含むキャラクターを選ぶ。 */
function matchCharacter(
  part: string,
  characters: readonly ProjectCharacterProfile[],
): CharacterMatch {
  const exact = characters.filter((item) => normalize(item.name) === part);
  if (exact.length === 1) return { kind: "found", character: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous" };
  const partial = characters.filter((item) => normalize(item.name).includes(part));
  if (partial.length === 1) return { kind: "found", character: partial[0] };
  return partial.length === 0 ? { kind: "none" } : { kind: "ambiguous" };
}

/** 衣装を名前の完全一致、文字を並べ替えた一致の順で探す。 */
function matchOutfit(
  part: string,
  outfits: readonly ProjectCharacterOutfit[],
): ProjectCharacterOutfit | undefined {
  const exact = outfits.find((item) => normalize(item.name) === part);
  if (exact) return exact;
  const key = sortedChars(part);
  return outfits.find((item) => sortedChars(normalize(item.name)) === key);
}

/** 振り分けられない理由。取り込める名前ならnull。 */
function skipReason(
  fileName: string,
  characters: readonly ProjectCharacterProfile[],
): string | null {
  if (!/\.png$/i.test(normalize(fileName))) return "png以外";
  const parsed = parseReferenceName(fileName);
  if (!parsed) return "命名規則外";
  if (normalize(fileName).replace(/\.[^./]+$/, "").endsWith("比較")) return "比較ボード";
  const match = matchCharacter(parsed.character, characters);
  if (match.kind === "none") return "キャラ該当なし";
  if (match.kind === "ambiguous") return "キャラ曖昧";
  return null;
}

/** アップロード前に、ファイル名だけで取り込み対象とスキップを分ける。 */
export function planReferenceImport(
  fileNames: readonly string[],
  characters: readonly ProjectCharacterProfile[],
): ReferenceImportPlan {
  const plan: ReferenceImportPlan = { targets: [], skipped: [] };
  for (const fileName of fileNames) {
    const reason = skipReason(fileName, characters);
    if (reason) plan.skipped.push({ fileName, reason });
    else plan.targets.push(fileName);
  }
  return plan;
}

/**
 * アップロード済みの画像を最新の`local_overrides`へ振り分けて適用する。
 * 同じ取り込みで作った衣装は後続ファイルの照合対象に含める。
 */
export function applyReferenceImport(
  latest: ProjectLocalOverrides,
  entries: readonly ReferenceImportEntry[],
): { overrides: ProjectLocalOverrides; report: ReferenceImportReport } {
  const characters = new Map((latest.characters ?? []).map((item) => [item.id, item]));
  const report: ReferenceImportReport = { results: [], skipped: [] };
  const list = latest.characters ?? [];

  for (const entry of entries) {
    // 最新のキャラクターで照合し直す (取り込み中に他画面で変わっていても安全側に倒す)。
    const reason = skipReason(entry.fileName, list);
    const parsed = parseReferenceName(entry.fileName);
    if (reason || !parsed) {
      report.skipped.push({ fileName: entry.fileName, reason: reason ?? "命名規則外" });
      continue;
    }
    const match = matchCharacter(parsed.character, list);
    if (match.kind !== "found") continue;
    const character = characters.get(match.character.id) ?? match.character;

    const outfits = [...(character.outfits ?? [])];
    let outfit = matchOutfit(parsed.outfit, outfits);
    let newOutfit = false;
    if (!outfit) {
      if (outfits.length >= MAX_OUTFITS) {
        report.skipped.push({ fileName: entry.fileName, reason: "衣装上限" });
        continue;
      }
      outfit = {
        id: crypto.randomUUID(),
        name: parsed.outfit.slice(0, 120),
        prompt: "",
        tags: [],
        image: null,
      };
      outfits.push(outfit);
      newOutfit = true;
    }

    const sets = [...(character.reference_sets ?? [])];
    const existingSet = findReferenceSet({ ...character, reference_sets: sets }, outfit.id);
    const previous = existingSet?.slots?.[IMPORT_SLOT_KEY]?.image ?? null;
    const outfitId = outfit.id;
    const targetOutfit = outfit;

    let kind: ReferenceImportKind;
    if (previous && previous.sha256 === entry.image.sha256) {
      kind = "unchanged";
    } else {
      kind = previous ? "overwritten" : "registered";
      const nextSet: ProjectReferenceSet = existingSet
        ? { ...existingSet, slots: { ...existingSet.slots, [IMPORT_SLOT_KEY]: { image: entry.image } } }
        : {
            id: crypto.randomUUID(),
            outfit_id: outfitId,
            slots: { [IMPORT_SLOT_KEY]: { image: entry.image } },
          };
      if (existingSet) sets[sets.indexOf(existingSet)] = nextSet;
      else sets.push(nextSet);
    }

    const nextOutfits = outfits.map((item) =>
      item.id === outfitId && !item.image ? { ...item, image: entry.image } : item,
    );
    characters.set(character.id, { ...character, outfits: nextOutfits, reference_sets: sets });
    report.results.push({
      fileName: entry.fileName,
      kind,
      characterName: character.name,
      outfitName: targetOutfit.name,
      newOutfit,
      previousFileName: kind === "overwritten" ? previous?.file_name : undefined,
    });
  }

  return {
    overrides: {
      ...latest,
      characters: list.map((item) => characters.get(item.id) ?? item),
    },
    report,
  };
}
