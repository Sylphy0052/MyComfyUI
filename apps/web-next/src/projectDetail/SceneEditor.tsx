import { Button, Group, Select, TagsInput, Text, Textarea, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconMovie, IconPhotoSearch } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router";

import type { StoryScene } from "../api/client";
import { NAME_MAX, TAG_MAX, TAGS_MAX, TEXT_MAX } from "./limits";
import { EditFieldset, useReadOnly } from "./readOnly";
import { SceneAdoptions } from "./SceneAdoptions";
import { SceneCastField } from "./SceneCastField";
import { SceneTagAssistButton } from "./SceneTagAssistButton";
import { SceneDialogueField } from "./SceneDialogueField";
import { isSavable, TIME_OF_DAY_OPTIONS, toBody, toDraft, type SceneDraft, type TimeOfDay } from "./sceneDraft";
import { useReportDirty } from "./unsavedGuard";
import { useCharacters, useSaveScene } from "./useStory";

/** シーンの編集欄。`scene`が`null`なら新規。保存ボタンで確定する。 */
export function SceneEditor({
  projectId,
  scene,
  onSaved,
}: {
  projectId: string;
  scene: StoryScene | null;
  onSaved: (saved: StoryScene) => void;
}) {
  const [draft, setDraft] = useState<SceneDraft>(() => toDraft(scene));
  const characters = useCharacters(projectId).data ?? [];
  const save = useSaveScene(projectId);
  const readOnly = useReadOnly();

  const dirty = JSON.stringify(toBody(draft)) !== JSON.stringify(toBody(toDraft(scene)));
  useReportDirty("scene", dirty);

  const update = (patch: Partial<SceneDraft>) => setDraft((previous) => ({ ...previous, ...patch }));
  const defaultSpeakerId = draft.cast[0]?.character_id ?? characters[0]?.id ?? "";

  const submit = () => {
    save.mutate(
      { id: scene?.id ?? null, body: toBody(draft) },
      {
        onSuccess: (saved) => {
          notifications.show({ color: "green", message: "シーンを保存しました" });
          // 保存した値を取り込み直す。台詞は新しく振られたIDが入り、以後の保存で送り返される。
          setDraft(toDraft(saved));
          onSaved(saved);
        },
      },
    );
  };

  return (
    // 保存中に入力すると、保存後の取り込みで消えるので止める。Viewerへのリンクと採用済みの再生は止めない。
    <EditFieldset disabled={readOnly || save.isPending}>
      <TextInput
        label="名前"
        required
        value={draft.name}
        maxLength={NAME_MAX}
        onChange={(event) => update({ name: event.currentTarget.value })}
      />
      <Textarea
        label="概要"
        autosize
        minRows={2}
        maxRows={8}
        maxLength={TEXT_MAX}
        value={draft.summary}
        onChange={(event) => update({ summary: event.currentTarget.value })}
      />
      <Textarea
        label="背景"
        autosize
        minRows={1}
        maxRows={6}
        maxLength={TEXT_MAX}
        value={draft.background_text}
        onChange={(event) => update({ background_text: event.currentTarget.value })}
      />
      <TagsInput
        label="背景のタグ"
        value={draft.background_tags}
        maxTags={TAGS_MAX}
        maxLength={TAG_MAX}
        onChange={(background_tags) => update({ background_tags })}
      />
      <Group>
        <SceneTagAssistButton
          subject="背景"
          text={draft.background_text}
          onTags={(background_tags) => update({ background_tags })}
        />
      </Group>
      <Select
        label="時間帯"
        placeholder="指定なし"
        clearable
        data={TIME_OF_DAY_OPTIONS}
        value={draft.time_of_day}
        onChange={(value) => update({ time_of_day: value as TimeOfDay | null })}
      />
      <SceneCastField cast={draft.cast} characters={characters} onChange={(cast) => update({ cast })} />
      <SceneDialogueField
        dialogues={draft.dialogues}
        characters={characters}
        defaultSpeakerId={defaultSpeakerId}
        onChange={(dialogues) => update({ dialogues })}
      />
      <Textarea
        label="BGMの雰囲気"
        autosize
        minRows={1}
        maxRows={4}
        maxLength={TEXT_MAX}
        value={draft.bgm_mood}
        onChange={(event) => update({ bgm_mood: event.currentTarget.value })}
      />
      <Textarea
        label="動画の動き"
        autosize
        minRows={1}
        maxRows={4}
        maxLength={TEXT_MAX}
        value={draft.video_motion}
        onChange={(event) => update({ video_motion: event.currentTarget.value })}
      />
      {save.error ? (
        <Text c="red" size="sm">
          {save.error.message}
        </Text>
      ) : null}
      <Group>
        <Button onClick={submit} loading={save.isPending} disabled={!isSavable(draft) || !dirty}>
          {scene ? "保存" : "作成"}
        </Button>
        {scene ? (
          <Button
            component={Link}
            to={`/scenes/${encodeURIComponent(scene.id)}/produce?${new URLSearchParams({ project: projectId })}`}
            variant="default"
            leftSection={<IconMovie size={16} />}
          >
            シーン生成へ
          </Button>
        ) : null}
        {scene ? (
          <Button
            component={Link}
            to={`/viewer?${new URLSearchParams({ project: projectId, scene: scene.id })}`}
            variant="default"
            leftSection={<IconPhotoSearch size={16} />}
          >
            Viewerで候補を見る
          </Button>
        ) : null}
      </Group>
      {scene ? <SceneAdoptions projectId={projectId} scene={scene} /> : null}
    </EditFieldset>
  );
}
