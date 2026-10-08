import { Button, Drawer, Group, Stack, TagsInput, Text, Textarea, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";

import type { StoryCharacter, StoryCostume, StoryCostumeBody } from "../api/client";
import { artifactIdOf } from "./MediaThumb";
import { ReferenceImageList, type MemoEdits } from "./ReferenceImageList";
import { useReportDirty } from "./unsavedGuard";
import { useSaveCostume } from "./useStory";

/** `schemas.py`の`StoryName`・`StoryTags`・`StoryText`の上限に合わせる。 */
export const NAME_MAX = 120;
export const TAG_MAX = 128;
export const TAGS_MAX = 100;
export const TEXT_MAX = 4_000;

type CostumeDraft = {
  name: string;
  tags: string[];
  negative_tags: string[];
  description: string;
  reference_images: string[];
};

const EMPTY_DRAFT: CostumeDraft = { name: "", tags: [], negative_tags: [], description: "", reference_images: [] };

function toDraft(costume: StoryCostume | null): CostumeDraft {
  if (!costume) return EMPTY_DRAFT;
  return {
    name: costume.name,
    tags: costume.tags,
    negative_tags: costume.negative_tags,
    description: costume.description,
    reference_images: costume.reference_images,
  };
}

function CostumeForm({
  projectId,
  character,
  costume,
  onSaved,
  onCancel,
}: {
  projectId: string;
  character: StoryCharacter;
  costume: StoryCostume | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<CostumeDraft>(() => toDraft(costume));
  const [memoEdits, setMemoEdits] = useState<MemoEdits>({});
  const save = useSaveCostume(projectId);

  // 外した画像のメモは保存しない。
  const liveMemoEdits = Object.fromEntries(
    Object.entries(memoEdits).filter(([artifactId]) =>
      draft.reference_images.some((key) => artifactIdOf(key) === artifactId),
    ),
  );
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(toDraft(costume)) || Object.keys(liveMemoEdits).length > 0;
  useReportDirty("costume", dirty);

  const update = (patch: Partial<CostumeDraft>) => setDraft((previous) => ({ ...previous, ...patch }));
  const changeMemo = (artifactId: string, value: string | null) =>
    setMemoEdits((previous) => {
      const { [artifactId]: _removed, ...rest } = previous;
      return value === null ? rest : { ...rest, [artifactId]: value };
    });

  const name = draft.name.trim();
  const submit = () => {
    const body: StoryCostumeBody = { ...draft, name };
    save.mutate(
      { characterId: character.id, costumeId: costume?.id ?? null, body, memos: liveMemoEdits },
      {
        onSuccess: () => {
          notifications.show({ color: "green", message: "衣装を保存しました" });
          onSaved();
        },
      },
    );
  };

  return (
    <Stack>
      <TextInput
        label="名前"
        required
        value={draft.name}
        maxLength={NAME_MAX}
        onChange={(event) => update({ name: event.currentTarget.value })}
      />
      <TagsInput
        label="衣装タグ"
        value={draft.tags}
        maxTags={TAGS_MAX}
        maxLength={TAG_MAX}
        onChange={(tags) => update({ tags })}
      />
      <TagsInput
        label="ネガティブタグ"
        value={draft.negative_tags}
        maxTags={TAGS_MAX}
        maxLength={TAG_MAX}
        onChange={(negative_tags) => update({ negative_tags })}
      />
      <Textarea
        label="説明"
        autosize
        minRows={2}
        maxRows={8}
        maxLength={TEXT_MAX}
        value={draft.description}
        onChange={(event) => update({ description: event.currentTarget.value })}
      />
      <ReferenceImageList
        keys={draft.reference_images}
        onChange={(reference_images) => update({ reference_images })}
        memoEdits={memoEdits}
        onMemoChange={changeMemo}
      />
      {save.error ? (
        <Text c="red" size="sm">
          {save.error.message}
        </Text>
      ) : null}
      <Group justify="flex-end">
        <Button variant="default" onClick={onCancel}>
          閉じる
        </Button>
        <Button onClick={submit} loading={save.isPending} disabled={name === "" || !dirty}>
          保存
        </Button>
      </Group>
    </Stack>
  );
}

/** 衣装の編集ドロワー。`costume`が`null`なら新規。閉じている間はフォームを描画せず、開くたびに保存済みの値から始める。 */
export function CostumeDrawer({
  opened,
  projectId,
  character,
  costume,
  onRequestClose,
  onSaved,
}: {
  opened: boolean;
  projectId: string;
  character: StoryCharacter;
  costume: StoryCostume | null;
  /** 閉じる操作。未保存の確認は呼び出し側が挟む。 */
  onRequestClose: () => void;
  /** 保存が済んだ。確認なしで閉じてよい。 */
  onSaved: () => void;
}) {
  return (
    <Drawer
      opened={opened}
      onClose={onRequestClose}
      position="right"
      size="lg"
      title={costume ? `衣装を編集: ${costume.name}` : `衣装を追加 (${character.name})`}
    >
      {opened ? (
        <CostumeForm
          key={costume?.id ?? "new"}
          projectId={projectId}
          character={character}
          costume={costume}
          onSaved={onSaved}
          onCancel={onRequestClose}
        />
      ) : null}
    </Drawer>
  );
}
