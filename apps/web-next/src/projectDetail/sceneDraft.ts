import type { StoryScene, StorySceneBody } from "../api/client";

export type TimeOfDay = NonNullable<StoryScene["time_of_day"]>;

export const TIME_OF_DAY_OPTIONS: { value: TimeOfDay; label: string }[] = [
  { value: "morning", label: "朝" },
  { value: "day", label: "昼" },
  { value: "sunset", label: "夕方" },
  { value: "night", label: "夜" },
];

/** 一覧の`key`に使う、画面内だけの識別子。APIには送らない。 */
let uidSeq = 0;
export function newUid(): string {
  uidSeq += 1;
  return `row-${uidSeq}`;
}

export type CastDraft = {
  uid: string;
  character_id: string;
  costume_id: string | null;
  pose_text: string;
  pose_tags: string[];
  expression_text: string;
  expression_tags: string[];
};

export type DialogueDraft = {
  uid: string;
  /** 既存の台詞のID。新しい台詞は`null`。省略して送ると新しい台詞になり、音声の採用が外れる。 */
  id: string | null;
  speaker_character_id: string;
  text: string;
  direction: string;
};

export type SceneDraft = {
  name: string;
  summary: string;
  background_text: string;
  background_tags: string[];
  time_of_day: TimeOfDay | null;
  cast: CastDraft[];
  dialogues: DialogueDraft[];
  bgm_mood: string;
  video_motion: string;
};

export function emptyCast(characterId: string): CastDraft {
  return {
    uid: newUid(),
    character_id: characterId,
    costume_id: null,
    pose_text: "",
    pose_tags: [],
    expression_text: "",
    expression_tags: [],
  };
}

export function emptyDialogue(speakerId: string): DialogueDraft {
  return { uid: newUid(), id: null, speaker_character_id: speakerId, text: "", direction: "" };
}

export function toDraft(scene: StoryScene | null): SceneDraft {
  return {
    name: scene?.name ?? "",
    summary: scene?.summary ?? "",
    background_text: scene?.background_text ?? "",
    background_tags: scene?.background_tags ?? [],
    time_of_day: scene?.time_of_day ?? null,
    cast: (scene?.cast ?? []).map((entry) => ({
      uid: newUid(),
      character_id: entry.character_id,
      costume_id: entry.costume_id ?? null,
      pose_text: entry.pose_text,
      pose_tags: entry.pose_tags ?? [],
      expression_text: entry.expression_text,
      expression_tags: entry.expression_tags ?? [],
    })),
    dialogues: (scene?.dialogues ?? []).map((entry) => ({
      uid: newUid(),
      id: entry.id ?? null,
      speaker_character_id: entry.speaker_character_id,
      text: entry.text,
      direction: entry.direction,
    })),
    bgm_mood: scene?.bgm_mood ?? "",
    video_motion: scene?.video_motion ?? "",
  };
}

/** 送信する形。未保存の判定も、保存済みの値とこの形で比べる (`uid`は含めない)。 */
export function toBody(draft: SceneDraft): StorySceneBody {
  return {
    name: draft.name.trim(),
    summary: draft.summary,
    background_text: draft.background_text,
    background_tags: draft.background_tags,
    time_of_day: draft.time_of_day,
    cast: draft.cast.map(({ uid: _uid, ...entry }) => entry),
    // 既存の台詞は`id`を送り返す。新しい台詞は`id`を付けない。
    dialogues: draft.dialogues.map(({ uid: _uid, id, ...entry }) => (id === null ? entry : { id, ...entry })),
    bgm_mood: draft.bgm_mood,
    video_motion: draft.video_motion,
  };
}

/** 保存できる状態か。APIが弾く空の名前・話者・台詞文を、先に画面で止める。 */
export function isSavable(draft: SceneDraft): boolean {
  return (
    draft.name.trim() !== "" &&
    draft.cast.every((entry) => entry.character_id !== "") &&
    draft.dialogues.every((entry) => entry.speaker_character_id !== "" && entry.text.trim() !== "")
  );
}
