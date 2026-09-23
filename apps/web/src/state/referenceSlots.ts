/**
 * 参照画像セットの役割枠 (F-16 #155)。
 *
 * novel-writer側の検証結果 (`検証_minimax/11_ref_images/必要な画像リスト.md`) に合わせた
 * 7枚構成の枠を定義し、キャラクターの参照セット検索・枠の生成プロンプト組立・場面で
 * 使う参照画像の抽出を行う。API・DBは変えない純関数。
 */
import type {
  ProjectCharacterProfile,
  ProjectReferenceSet,
  ReferenceSlotKey,
} from "../api/client";
import type { PickedMedia } from "../components/MediaPicker";
import type { NamedItem } from "./productionPlan";
import { findLocalCharacter } from "./characterPrompt";
import type { SceneOutfits } from "./characterPrompt";

export interface ReferenceSlotDef {
  key: ReferenceSlotKey;
  /** 画面表示用の日本語名。 */
  label: string;
  /** 生成プロンプトへ足す英語の補足。 */
  hint: string;
}

export const REFERENCE_SLOTS: readonly ReferenceSlotDef[] = [
  { key: "face_closed", label: "閉口", hint: "face closeup, front view, closed mouth, smile" },
  { key: "face_open", label: "開口", hint: "face closeup, front view, open mouth, showing teeth" },
  { key: "face_angle", label: "斜め", hint: "face closeup, three-quarter view, closed mouth" },
  { key: "bust", label: "バストアップ", hint: "bust shot, front view" },
  { key: "full_body", label: "全身", hint: "full body, standing, front view" },
  { key: "pose", label: "ポーズ", hint: "full body, dynamic pose" },
  { key: "background", label: "背景", hint: "background only, no humans" },
];

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
 * 枠の生成プロンプトを組む。人物を写さない背景枠は枠の補足だけを使う。
 * それ以外の枠は「名前, 外見, 衣装プロンプト, 枠の補足」を空要素を除いて連結する。
 */
export function slotPrompt(
  character: ProjectCharacterProfile,
  outfitId: string | null,
  slotKey: ReferenceSlotKey,
): string {
  const hint = REFERENCE_SLOTS.find((item) => item.key === slotKey)?.hint ?? "";
  if (slotKey === "background") return hint;
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
