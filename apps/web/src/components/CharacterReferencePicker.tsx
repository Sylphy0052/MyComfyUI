import { api } from "../api/client";
import type { ProjectCharacterProfile } from "../api/client";
import type { CharacterReferenceImage } from "../state/referenceSlots";

/** 変更タブで元画像に使うキャラクターと衣装の選択。未選択は空文字。 */
export interface CharacterReferenceSelection {
  characterId: string;
  outfitId: string;
}

interface Props {
  projectId: string | null;
  characters: readonly ProjectCharacterProfile[];
  value: CharacterReferenceSelection;
  onChange: (next: CharacterReferenceSelection) => void;
  /** 選んだ衣装の参照セットから決めた画像。`characterReferenceImage`の結果をそのまま渡す。 */
  reference: CharacterReferenceImage | null;
  disabled?: boolean;
}

/**
 * キャラクターと衣装を選び、その衣装の参照セットの全身画像を元画像として示す (#497)。
 * 画像を使えないときは理由を出す。投入できるかの判定は呼び出し側が`reference`で行う。
 */
export function CharacterReferencePicker({
  projectId,
  characters,
  value,
  onChange,
  reference,
  disabled = false,
}: Props) {
  const character = characters.find((item) => item.id === value.characterId);
  const outfits = character?.outfits ?? [];

  const selectCharacter = (characterId: string) => {
    const next = characters.find((item) => item.id === characterId);
    const defaultOutfitId = next?.default_outfit_id ?? "";
    // 既定の衣装が衣装一覧に無い (削除済みなど) ときは選ばずに始める。
    const outfitId = (next?.outfits ?? []).some((item) => item.id === defaultOutfitId) ? defaultOutfitId : "";
    onChange({ characterId, outfitId });
  };

  let notice: string | null = null;
  if (!projectId) notice = "Projectを選ぶと、キャラクターから選べます。";
  else if (characters.length === 0) notice = "このProjectにはキャラクターが登録されていません。";
  else if (character && outfits.length === 0) notice = "このキャラクターには衣装が登録されていません。";
  else if (character && !value.outfitId) notice = "衣装を選んでください。";
  else if (character && !reference) {
    notice = "この衣装には参照画像 (全身) が登録されていません。キャラクター画面で登録すると使えます。";
  }

  return (
    <div className="stack">
      <div className="row">
        <select
          aria-label="キャラクター"
          value={value.characterId}
          disabled={disabled || characters.length === 0}
          onChange={(event) => selectCharacter(event.target.value)}
        >
          <option value="">キャラクターを選択</option>
          {characters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <select
          aria-label="衣装"
          value={value.outfitId}
          disabled={disabled || outfits.length === 0}
          onChange={(event) => onChange({ ...value, outfitId: event.target.value })}
        >
          <option value="">衣装を選択</option>
          {outfits.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>
      {reference && (
        <div className="row">
          <img
            src={
              reference.artifactId
                ? api.artifactContentUrl(reference.artifactId)
                : api.imageReferenceContentUrl(reference.image.relative_path)
            }
            alt="元画像 (参照セットの全身)"
            style={{ width: 96, height: 96, objectFit: "cover" }}
          />
          <div className="stack">
            <span>{reference.image.file_name}</span>
            <span className="muted">参照セットの全身画像</span>
          </div>
        </div>
      )}
      {notice && <p className="muted">{notice}</p>}
    </div>
  );
}
