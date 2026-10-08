/**
 * 参照画像セットの役割枠 (F-16 #155)。
 *
 * 衣装ごとに全身画像1枚だけを持つ (#493)。キャラクターの参照セット検索・枠の生成プロンプト
 * 組立・場面で使う参照画像の抽出を行う。API・DBは変えない純関数。
 */
import type { ProjectCharacterProfile, ProjectReferenceImage, ProjectReferenceSet } from "../api/client";
import type { PickedMedia } from "../components/MediaPicker";
import type { NamedItem } from "./productionPlan";
import { findLocalCharacter } from "./characterPrompt";
import type { SceneOutfits } from "./characterPrompt";

export interface ReferenceSlotDef {
  key: string;
  /** 画面表示用の日本語名。 */
  label: string;
  /** 生成プロンプトへ足す英語の補足。 */
  hint: string;
}

/**
 * 枠の一覧。web側の枠のキーはここだけで定義し、`ReferenceSlotKey`はここから導出する。
 * APIの`schemas.py`の`ReferenceSlotKey`はLiteralだが、`dict[Literal[...], ...]`は
 * openapi-typescriptで文字列dictへ落ちて生成型に残らない。枠を増やすときはAPI側も手で合わせる。
 */
export const REFERENCE_SLOTS = [
  { key: "full_body", label: "全身", hint: "full body, standing, front view" },
] as const satisfies readonly ReferenceSlotDef[];

export type ReferenceSlotKey = (typeof REFERENCE_SLOTS)[number]["key"];

/**
 * キャラクターの参照セットから、指定した衣装に対応するものを探す。
 * `outfitId`がnullなら「衣装指定なし」のセットを探す。
 */
export function findReferenceSet(
  character: ProjectCharacterProfile,
  outfitId: string | null,
): ProjectReferenceSet | undefined {
  return (character.reference_sets ?? []).find(
    (item) => (item.outfit_id ?? null) === outfitId,
  );
}

/**
 * 枠の生成プロンプトを組む。「名前, 外見, 衣装プロンプト, 枠の補足」を空要素を除いて連結する。
 */
export function slotPrompt(
  character: ProjectCharacterProfile,
  outfitId: string | null,
  slotKey: ReferenceSlotKey,
): string {
  const hint = REFERENCE_SLOTS.find((item) => item.key === slotKey)?.hint ?? "";
  const outfitPrompt = outfitId
    ? (character.outfits ?? []).find((item) => item.id === outfitId)?.prompt ?? ""
    : "";
  return [character.name, character.appearance ?? "", outfitPrompt, hint]
    .filter((part) => part.trim().length > 0)
    .join(", ");
}

/**
 * 場面で使う参照画像を抽出する。制作計画に載ったキャラクターごとに、場面で選んだ衣装
 * (無ければ既定の衣装) に対応する参照セットから、埋まっている枠の画像を枠の順に集める。
 * 衣装の違うセットで代用すると別の衣装が映るため、対応するセットが無ければ何も足さない。
 * 動画の参照画像候補 (`suggestedReferences`) の先頭へ足す。
 */
export function sceneReferenceImages(
  items: readonly NamedItem[],
  characters: readonly ProjectCharacterProfile[],
  sceneOutfits: SceneOutfits,
  sceneId: string | null,
): PickedMedia[] {
  const outfitSelections = (sceneId && sceneOutfits[sceneId]) || {};
  const result: PickedMedia[] = [];
  for (const item of items) {
    const character = findLocalCharacter(item, characters);
    if (!character) continue;
    const outfitId = outfitSelections[character.id] ?? character.default_outfit_id ?? null;
    const referenceSet = findReferenceSet(character, outfitId);
    if (!referenceSet) continue;
    for (const def of REFERENCE_SLOTS) {
      const image = referenceSet.slots?.[def.key]?.image;
      if (!image) continue;
      result.push({
        key: `input:${image.relative_path}`,
        label: image.file_name,
        source: { relative_path: image.relative_path, sha256: image.sha256 },
        mediaType: image.media_type,
      });
    }
  }
  return result;
}

/** 生成フォームが参照画像として自動で使う枠の優先順 (#474)。枠は全身だけになった (#493)。 */
export const AUTO_REFERENCE_SLOT_ORDER = ["full_body"] as const satisfies readonly ReferenceSlotKey[];

export interface CharacterReferenceImage {
  slotKey: ReferenceSlotKey;
  image: ProjectReferenceImage;
  /** サムネイル表示用のArtifact。無ければnull。 */
  artifactId: string | null;
}

/**
 * 生成フォームで自動で使う参照画像を返す。衣装の探し方は`sceneReferenceImages`と同じで、
 * 選んだ衣装 (無ければ既定の衣装) の参照セットだけを見る。別の衣装のセットでは代用しない。
 */
export function characterReferenceImage(
  character: ProjectCharacterProfile,
  outfitId: string | null,
): CharacterReferenceImage | null {
  const referenceSet = findReferenceSet(character, outfitId ?? character.default_outfit_id ?? null);
  if (!referenceSet) return null;
  for (const slotKey of AUTO_REFERENCE_SLOT_ORDER) {
    const slot = referenceSet.slots?.[slotKey];
    if (slot?.image) return { slotKey, image: slot.image, artifactId: slot.artifact_id ?? null };
  }
  return null;
}

/**
 * 参照画像のsha256から、その画像を自動参照に使うキャラクターと衣装を探す。参照付きJobを
 * 復元するとき、投入時と同じ参照になる選択へ戻すために使う (#480)。見つからなければnull。
 */
export function findReferenceSelection(
  characters: readonly ProjectCharacterProfile[],
  sha256s: readonly string[],
): { characterId: string; outfitId: string | null } | null {
  if (sha256s.length === 0) return null;
  for (const character of characters) {
    for (const referenceSet of character.reference_sets ?? []) {
      const outfitId = referenceSet.outfit_id ?? null;
      // 削除済みの衣装のsetは、フォームで選べず別の衣装の参照に置き換わるため使わない。
      if (outfitId && !(character.outfits ?? []).some((item) => item.id === outfitId)) continue;
      const image = characterReferenceImage(character, outfitId)?.image;
      if (image && sha256s.includes(image.sha256)) return { characterId: character.id, outfitId };
    }
  }
  return null;
}
