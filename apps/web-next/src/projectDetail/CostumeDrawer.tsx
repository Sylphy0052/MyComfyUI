import { Button, Drawer, Group, Stack, TagsInput, Text, Textarea, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";

import type { StoryCharacter, StoryCostume, StoryCostumeBody } from "../api/client";
import { NAME_MAX, TAG_MAX, TAGS_MAX, TEXT_MAX } from "./limits";
import { artifactIdOf } from "./MediaThumb";
import { EditFieldset, useReadOnly } from "./readOnly";
import { ReferenceImageList, type MemoEdits } from "./ReferenceImageList";
import { TagExtractor } from "./TagExtractor";
import { useReportDirty } from "./unsavedGuard";
import { useSaveCostume } from "./useStory";

type CostumeDraft = {
  name: string;
  tags: string[];
  negative_tags: string[];
  description: string;
  reference_images: string[];
  /** アップロードした参照画像 (`input:`) のメモ。キーは参照のキー。 */
  reference_image_memos: Record<string, string>;
};

const EMPTY_DRAFT: CostumeDraft = {
  name: "",
  tags: [],
  negative_tags: [],
  description: "",
  reference_images: [],
  reference_image_memos: {},
};

function toDraft(costume: StoryCostume | null): CostumeDraft {
  if (!costume) return EMPTY_DRAFT;
  return {
    name: costume.name,
    tags: costume.tags,
    negative_tags: costume.negative_tags,
    description: costume.description,
    reference_images: costume.reference_images,
    reference_image_memos: costume.reference_image_memos ?? {},
  };
}

/** 未保存の比較用。メモのキーの並びは編集の順で変わるので、並びに依らない形にしてから文字列にする。 */
function draftSignature(draft: CostumeDraft): string {
  return JSON.stringify({ ...draft, reference_image_memos: Object.entries(draft.reference_image_memos).sort() });
}

function CostumeForm({
  projectId,
  character,
  costume,
  onCreated,
  onSaved,
  onCancel,
}: {
  projectId: string;
  character: StoryCharacter;
  costume: StoryCostume | null;
  onCreated: (costume: StoryCostume) => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<CostumeDraft>(() => toDraft(costume));
  const [memoEdits, setMemoEdits] = useState<MemoEdits>({});
  const save = useSaveCostume(projectId);
  // 保存中に入力すると、保存後の取り込みで消えるので止める。
  const readOnly = useReadOnly();
  const locked = readOnly || save.isPending;

  // 外した画像のメモは保存しない。
  const liveMemoEdits = Object.fromEntries(
    Object.entries(memoEdits).filter(([artifactId]) =>
      draft.reference_images.some((key) => artifactIdOf(key) === artifactId),
    ),
  );
  const liveInputMemos = Object.fromEntries(
    Object.entries(draft.reference_image_memos).filter(([key]) => draft.reference_images.includes(key)),
  );
  const dirty =
    draftSignature({ ...draft, reference_image_memos: liveInputMemos }) !== draftSignature(toDraft(costume)) ||
    Object.keys(liveMemoEdits).length > 0;
  useReportDirty("costume", dirty);

  const update = (patch: Partial<CostumeDraft>) => setDraft((previous) => ({ ...previous, ...patch }));
  const changeMemo = (artifactId: string, value: string | null) =>
    setMemoEdits((previous) => {
      const { [artifactId]: _removed, ...rest } = previous;
      return value === null ? rest : { ...rest, [artifactId]: value };
    });

  const changeInputMemo = (key: string, value: string) =>
    setDraft((previous) => {
      const { [key]: _removed, ...rest } = previous.reference_image_memos;
      return { ...previous, reference_image_memos: value === "" ? rest : { ...rest, [key]: value } };
    });

  const name = draft.name.trim();
  const submit = () => {
    // 空白だけのメモは送らない (サーバーも捨てる)。
    const sendInputMemos = Object.fromEntries(Object.entries(liveInputMemos).filter(([, memo]) => memo.trim() !== ""));
    const body: StoryCostumeBody = { ...draft, name, reference_image_memos: sendInputMemos };
    save.mutate(
      { characterId: character.id, costumeId: costume?.id ?? null, body, memos: liveMemoEdits, onCreated },
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
      <EditFieldset disabled={locked}>
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
        <TagExtractor
          imageKeys={draft.reference_images}
          tags={draft.tags}
          onChange={(tags) => update({ tags })}
          emptyHint="参照画像を追加すると、画像から衣装タグを抽出できます。"
          targetLabel="衣装タグ"
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
          inputMemos={draft.reference_image_memos}
          onInputMemoChange={changeInputMemo}
          disabled={locked}
        />
      </EditFieldset>
      {save.error ? (
        <Text c="red" size="sm">
          {save.error.message}
        </Text>
      ) : null}
      <Group justify="flex-end">
        <Button variant="default" onClick={onCancel}>
          閉じる
        </Button>
        <Button onClick={submit} loading={save.isPending} disabled={readOnly || name === "" || !dirty}>
          保存
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * 衣装の編集ドロワー。`costume`が`null`なら新規。閉じている間はフォームを描画せず、開くたびに保存済みの値から始める。
 * 新規の保存で`costume`が作成した衣装に切り替わっても、フォームは作り直さず入力 (メモの編集) を保つ。
 */
export function CostumeDrawer({
  opened,
  projectId,
  character,
  costume,
  onRequestClose,
  onCreated,
  onSaved,
}: {
  opened: boolean;
  projectId: string;
  character: StoryCharacter;
  costume: StoryCostume | null;
  /** 閉じる操作。未保存の確認は呼び出し側が挟む。 */
  onRequestClose: () => void;
  /** 新規の衣装を作成できた (メモの更新はまだ)。以後の対象をこの衣装にする。 */
  onCreated: (costume: StoryCostume) => void;
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
          projectId={projectId}
          character={character}
          costume={costume}
          onCreated={onCreated}
          onSaved={onSaved}
          onCancel={onRequestClose}
        />
      ) : null}
    </Drawer>
  );
}
