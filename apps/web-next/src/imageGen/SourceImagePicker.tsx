import { Button, FileButton, Group, Image, Loader, SegmentedControl, Select, SimpleGrid, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconUpload } from "@tabler/icons-react";
import { useState } from "react";

import { artifactContentUrl, imageReferenceUrl, type StoryCharacter } from "../api/client";
import { notifyError } from "../notifications";
import { artifactIdOf } from "../projectDetail/MediaThumb";
import {
  sourceFromArtifact,
  sourceFromCostume,
  sourceFromUpload,
  uploadedImage,
  type SourceImage,
} from "./deriveForm";
import type { ImageTarget } from "./imageForm";
import { reimportInputImage, useRecentGeneratedImages, useUploadInputImage } from "./useImageGen";

type Origin = "artifact" | "costume" | "upload";

const ORIGIN_LABELS: { value: Origin; label: string }[] = [
  { value: "artifact", label: "生成物" },
  { value: "costume", label: "衣装の参照画像" },
  { value: "upload", label: "アップロード" },
];

const INPUT_PREFIX = "input:";

/** 選べる画像のサムネイル。 */
function Thumb({ url, label, selected, onClick }: { url: string; label: string; selected: boolean; onClick: () => void }) {
  return (
    <UnstyledButton
      onClick={onClick}
      aria-label={label}
      data-testid="source-candidate"
      style={{
        outline: selected ? "2px solid var(--mantine-color-blue-6)" : undefined,
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      <Image src={url} alt="" h={80} fit="cover" loading="lazy" />
    </UnstyledButton>
  );
}

/** 最近の生成物から選ぶ。 */
function ArtifactSource({ projectId, source, onPick }: { projectId: string | null; source: SourceImage | null; onPick: (source: SourceImage) => void }) {
  const recent = useRecentGeneratedImages(projectId, true);
  if (recent.isPending) return <Loader size="xs" />;
  if (recent.error) return <Text size="xs" c="red">{recent.error.message}</Text>;
  const items = recent.data ?? [];
  if (items.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        {projectId === null ? "生成物がまだありません" : "このProjectの生成物がまだありません"}
      </Text>
    );
  }
  return (
    <SimpleGrid cols={4} spacing="xs">
      {items.map((item) => (
        <Thumb
          key={item.key}
          url={artifactContentUrl(item.artifact_id as string)}
          label="この生成物を元画像にする"
          selected={source?.origin === "artifact" && "artifact_id" in source.ref && source.ref.artifact_id === item.artifact_id}
          onClick={() => onPick(sourceFromArtifact({ id: item.artifact_id as string, ...linksOf(item) }))}
        />
      ))}
    </SimpleGrid>
  );
}

function linksOf(item: {
  assigned_project_id?: string | null;
  story_scene_id?: string | null;
  story_character_id?: string | null;
  story_costume_id?: string | null;
}) {
  return {
    assigned_project_id: item.assigned_project_id,
    story_scene_id: item.story_scene_id,
    story_character_id: item.story_character_id,
    story_costume_id: item.story_costume_id,
  };
}

/** Projectの衣装の参照画像から選ぶ。 */
function CostumeSource({
  projectId,
  characters,
  defaultCostumeId,
  onPick,
}: {
  projectId: string | null;
  characters: StoryCharacter[];
  defaultCostumeId: string | null;
  onPick: (source: SourceImage) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const upload = useUploadInputImage();
  const costumes = characters.flatMap((character) =>
    character.costumes.map((costume) => ({ costume, label: `${character.name} / ${costume.name}` })),
  );
  if (projectId === null) {
    return (
      <Text size="xs" c="dimmed">
        上の対象でProjectを選ぶと、そのProjectの衣装の参照画像を選べます。
      </Text>
    );
  }
  const costumeId = chosen ?? defaultCostumeId ?? costumes[0]?.costume.id ?? null;
  const current = costumes.find((entry) => entry.costume.id === costumeId)?.costume ?? null;

  const pick = async (key: string) => {
    if (current === null) return;
    const artifactId = artifactIdOf(key);
    if (artifactId !== null) {
      onPick(sourceFromCostume({ artifact_id: artifactId }, artifactContentUrl(artifactId), current, projectId));
      return;
    }
    if (!key.startsWith(INPUT_PREFIX)) return;
    const path = key.slice(INPUT_PREFIX.length);
    setBusyKey(key);
    try {
      const reference = await reimportInputImage(path, upload.mutateAsync);
      onPick(
        sourceFromCostume(
          { relative_path: reference.relative_path, sha256: reference.sha256 },
          imageReferenceUrl(reference.relative_path),
          current,
          projectId,
        ),
      );
    } catch (error) {
      notifyError("参照画像を元画像にできませんでした", error);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Stack gap="xs">
      <Select
        aria-label="衣装"
        placeholder={costumes.length === 0 ? "衣装がありません" : "衣装を選ぶ"}
        data={costumes.map((entry) => ({ value: entry.costume.id, label: entry.label }))}
        value={costumeId}
        onChange={setChosen}
        size="xs"
        searchable
      />
      {current !== null && current.reference_images.length === 0 ? (
        <Text size="xs" c="dimmed">
          この衣装には参照画像がありません。
        </Text>
      ) : null}
      <SimpleGrid cols={4} spacing="xs">
        {(current?.reference_images ?? []).map((key) => {
          const artifactId = artifactIdOf(key);
          const url = artifactId !== null ? artifactContentUrl(artifactId) : imageReferenceUrl(key.slice(INPUT_PREFIX.length));
          return (
            <Stack key={key} gap={0} pos="relative">
              <Thumb url={url} label="この参照画像を元画像にする" selected={false} onClick={() => void pick(key)} />
              {busyKey === key ? <Loader size="xs" pos="absolute" top={4} left={4} /> : null}
            </Stack>
          );
        })}
      </SimpleGrid>
    </Stack>
  );
}

/** 手元の画像をアップロードして選ぶ。 */
function UploadSource({ onPick }: { onPick: (source: SourceImage) => void }) {
  const upload = useUploadInputImage();
  return (
    <FileButton
      accept="image/png,image/jpeg,image/webp"
      onChange={(file) => {
        if (file === null) return;
        upload.mutate(file, {
          onSuccess: (reference) => onPick(sourceFromUpload(uploadedImage(reference, file.name))),
          onError: (error) => notifyError(`${file.name}を取り込めません`, error),
        });
      }}
    >
      {(props) => (
        <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />} loading={upload.isPending} w="fit-content">
          画像をアップロード
        </Button>
      )}
    </FileButton>
  );
}

/**
 * 参照と修正の元画像を1枚選ぶ。出どころは、生成物、衣装の参照画像、アップロードのいずれか。
 * 生成物と衣装の参照画像を選ぶと、その紐づけを上の対象へ引き継ぐ (呼び出し側が行う)。
 */
export function SourceImagePicker({
  source,
  onPick,
  onClear,
  target,
  characters,
}: {
  source: SourceImage | null;
  onPick: (source: SourceImage) => void;
  onClear: () => void;
  target: ImageTarget;
  characters: StoryCharacter[];
}) {
  const [origin, setOrigin] = useState<Origin>("artifact");
  return (
    <Stack gap="xs" data-testid="source-picker">
      <Text size="sm" fw={500}>
        元画像
      </Text>
      {source !== null ? (
        <Group gap="sm" wrap="nowrap" data-testid="source-selected">
          <Image src={source.previewUrl} alt="選んだ元画像" h={96} w="auto" fit="contain" />
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              {source.label}
            </Text>
            <Button size="compact-xs" variant="default" onClick={onClear}>
              選び直す
            </Button>
          </Stack>
        </Group>
      ) : (
        <Text size="xs" c="dimmed">
          元画像が未選択です。下から1枚選んでください。
        </Text>
      )}
      <SegmentedControl size="xs" data={ORIGIN_LABELS} value={origin} onChange={(value) => setOrigin(value as Origin)} />
      {origin === "artifact" ? <ArtifactSource projectId={target.projectId} source={source} onPick={onPick} /> : null}
      {origin === "costume" ? (
        <CostumeSource
          projectId={target.projectId}
          characters={characters}
          defaultCostumeId={target.costumeId}
          onPick={onPick}
        />
      ) : null}
      {origin === "upload" ? <UploadSource onPick={onPick} /> : null}
      <Text size="xs" c="dimmed">
        生成物と衣装の参照画像を選ぶと、その画像のProject・Scene・キャラ・衣装が上の対象に入り、結果にも引き継がれます。
      </Text>
    </Stack>
  );
}
