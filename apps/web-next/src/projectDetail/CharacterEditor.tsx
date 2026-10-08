import {
  Button,
  Card,
  FileButton,
  Group,
  SimpleGrid,
  Stack,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconMicrophone, IconPlus, IconUpload } from "@tabler/icons-react";
import { useState } from "react";

import type { StoryCharacter, StoryCharacterBody, StoryCostume } from "../api/client";
import { NAME_MAX, TAG_MAX, TAGS_MAX, TEXT_MAX } from "./CostumeDrawer";
import { MediaThumb } from "./MediaThumb";
import { useReportDirty } from "./unsavedGuard";
import { inputMediaKey, useSaveCharacter, useUploadImageReference, useUploadVoiceReference } from "./useStory";

type CharacterDraft = {
  name: string;
  fixed_tags: string[];
  negative_tags: string[];
  profile: string;
  portrait_media_key: string | null;
  voice_media_key: string | null;
  voice_transcript: string;
};

const EMPTY_DRAFT: CharacterDraft = {
  name: "",
  fixed_tags: [],
  negative_tags: [],
  profile: "",
  portrait_media_key: null,
  voice_media_key: null,
  voice_transcript: "",
};

function toDraft(character: StoryCharacter | null): CharacterDraft {
  if (!character) return EMPTY_DRAFT;
  return {
    name: character.name,
    fixed_tags: character.fixed_tags,
    negative_tags: character.negative_tags,
    profile: character.profile,
    portrait_media_key: character.portrait_media_key,
    voice_media_key: character.voice_media_key,
    voice_transcript: character.voice_transcript ?? "",
  };
}

function notifyError(title: string, error: unknown) {
  notifications.show({ color: "red", title, message: error instanceof Error ? error.message : String(error) });
}

function PortraitField({
  draft,
  candidates,
  onChange,
}: {
  draft: CharacterDraft;
  /** そのキャラの衣装の参照画像。代表画像はここから選べる。 */
  candidates: string[];
  onChange: (key: string | null) => void;
}) {
  const upload = useUploadImageReference();
  const current = draft.portrait_media_key;
  return (
    <Stack gap="xs">
      <Text fw={500} size="sm">
        代表画像
      </Text>
      <Group align="flex-start">
        <MediaThumb mediaKey={current} size={96} alt="代表画像" />
        <Stack gap="xs">
          <Group gap="xs">
            <FileButton
              accept="image/png,image/jpeg,image/webp"
              onChange={(file) => {
                if (!file) return;
                upload.mutate(file, {
                  onSuccess: (reference) => onChange(inputMediaKey(reference.relative_path)),
                  onError: (error) => notifyError("代表画像をアップロードできません", error),
                });
              }}
            >
              {(props) => (
                <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />} loading={upload.isPending}>
                  アップロード
                </Button>
              )}
            </FileButton>
            <Button size="xs" variant="default" disabled={current === null} onClick={() => onChange(null)}>
              外す
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            衣装の参照画像から選ぶ
          </Text>
          {candidates.length === 0 ? (
            <Text size="xs" c="dimmed">
              衣装に参照画像を追加すると、ここから選べます。
            </Text>
          ) : (
            <Group gap="xs">
              {candidates.map((key) => (
                <UnstyledButton
                  key={key}
                  aria-label={`代表にする: ${key}`}
                  aria-pressed={key === current}
                  data-testid="portrait-candidate"
                  onClick={() => onChange(key)}
                  style={{
                    outline: key === current ? "3px solid var(--mantine-color-blue-6)" : "1px solid var(--mantine-color-default-border)",
                    borderRadius: 4,
                  }}
                >
                  <MediaThumb mediaKey={key} size={48} />
                </UnstyledButton>
              ))}
            </Group>
          )}
        </Stack>
      </Group>
    </Stack>
  );
}

function VoiceField({
  draft,
  onChange,
}: {
  draft: CharacterDraft;
  onChange: (patch: Partial<CharacterDraft>) => void;
}) {
  const upload = useUploadVoiceReference();
  const key = draft.voice_media_key;
  return (
    <Stack gap="xs">
      <Text fw={500} size="sm">
        声の参照
      </Text>
      <Group gap="xs">
        <FileButton
          accept="audio/wav,audio/x-wav,.wav"
          onChange={(file) => {
            if (!file) return;
            upload.mutate(file, {
              onSuccess: (reference) => onChange({ voice_media_key: inputMediaKey(reference.relative_path) }),
              onError: (error) => notifyError("参照音声をアップロードできません", error),
            });
          }}
        >
          {(props) => (
            <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />} loading={upload.isPending}>
              参照音声をアップロード
            </Button>
          )}
        </FileButton>
        <Button size="xs" variant="default" disabled={key === null} onClick={() => onChange({ voice_media_key: null })}>
          外す
        </Button>
      </Group>
      <Group gap="xs" data-testid="voice-key">
        <IconMicrophone size={16} />
        <Text size="sm" c={key ? undefined : "dimmed"}>
          {key ?? "参照音声は未設定です"}
        </Text>
      </Group>
      <Textarea
        label="書き起こし"
        description="参照音声で話している内容を、そのまま書き起こします。"
        autosize
        minRows={2}
        maxRows={6}
        maxLength={TEXT_MAX}
        value={draft.voice_transcript}
        onChange={(event) => onChange({ voice_transcript: event.currentTarget.value })}
      />
    </Stack>
  );
}

function CostumeCards({
  costumes,
  onOpen,
}: {
  costumes: StoryCostume[];
  /** `null`なら新規。 */
  onOpen: (costume: StoryCostume | null) => void;
}) {
  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Title order={5}>衣装</Title>
        <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => onOpen(null)}>
          衣装を追加
        </Button>
      </Group>
      {costumes.length === 0 ? (
        <Text size="sm" c="dimmed">
          衣装はありません。
        </Text>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          {costumes.map((costume) => (
            <Card
              key={costume.id}
              withBorder
              padding="sm"
              component="button"
              type="button"
              data-testid="costume-card"
              onClick={() => onOpen(costume)}
              style={{ textAlign: "left", cursor: "pointer" }}
            >
              <Group wrap="nowrap">
                <MediaThumb mediaKey={costume.reference_images[0] ?? null} size={56} />
                <Stack gap={0} style={{ minWidth: 0 }}>
                  <Text fw={500} truncate>
                    {costume.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    参照画像{costume.reference_images.length}枚 / タグ{costume.tags.length}件
                  </Text>
                </Stack>
              </Group>
            </Card>
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}

/** キャラクターの編集欄。`character`が`null`なら新規。保存ボタンで確定する。 */
export function CharacterEditor({
  projectId,
  character,
  onSaved,
  onOpenCostume,
}: {
  projectId: string;
  character: StoryCharacter | null;
  onSaved: (saved: StoryCharacter) => void;
  onOpenCostume: (costume: StoryCostume | null) => void;
}) {
  const [draft, setDraft] = useState<CharacterDraft>(() => toDraft(character));
  const save = useSaveCharacter(projectId);

  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(character));
  useReportDirty("character", dirty);

  const update = (patch: Partial<CharacterDraft>) => setDraft((previous) => ({ ...previous, ...patch }));
  const name = draft.name.trim();
  const candidates = [...new Set((character?.costumes ?? []).flatMap((costume) => costume.reference_images))];

  const submit = () => {
    const body: StoryCharacterBody = {
      name,
      fixed_tags: draft.fixed_tags,
      negative_tags: draft.negative_tags,
      profile: draft.profile,
      portrait_media_key: draft.portrait_media_key,
      voice_media_key: draft.voice_media_key,
      voice_transcript: draft.voice_transcript.trim() === "" ? null : draft.voice_transcript,
    };
    save.mutate(
      { id: character?.id ?? null, body },
      {
        onSuccess: (saved) => {
          notifications.show({ color: "green", message: "キャラクターを保存しました" });
          // サーバーが整えた値 (タグの前後の空白など) を取り込み、保存直後に未保存扱いにならないようにする。
          setDraft(toDraft(saved));
          onSaved(saved);
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
        label="固定タグ"
        description="どの衣装でも常にプロンプトへ入るタグ (髪型、髪色、目の色、体格など)"
        value={draft.fixed_tags}
        maxTags={TAGS_MAX}
        maxLength={TAG_MAX}
        onChange={(fixed_tags) => update({ fixed_tags })}
      />
      <TagsInput
        label="ネガティブタグ"
        value={draft.negative_tags}
        maxTags={TAGS_MAX}
        maxLength={TAG_MAX}
        onChange={(negative_tags) => update({ negative_tags })}
      />
      <Textarea
        label="性格・設定"
        autosize
        minRows={3}
        maxRows={10}
        maxLength={TEXT_MAX}
        value={draft.profile}
        onChange={(event) => update({ profile: event.currentTarget.value })}
      />
      <PortraitField draft={draft} candidates={candidates} onChange={(portrait_media_key) => update({ portrait_media_key })} />
      <VoiceField draft={draft} onChange={update} />
      {save.error ? (
        <Text c="red" size="sm">
          {save.error.message}
        </Text>
      ) : null}
      <Group>
        <Button onClick={submit} loading={save.isPending} disabled={name === "" || !dirty}>
          {character ? "保存" : "作成"}
        </Button>
      </Group>
      {character ? (
        <CostumeCards costumes={character.costumes} onOpen={onOpenCostume} />
      ) : (
        <Text size="sm" c="dimmed">
          キャラクターを作成すると、衣装を追加できます。
        </Text>
      )}
    </Stack>
  );
}
