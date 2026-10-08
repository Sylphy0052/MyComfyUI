import { Alert, Group, Loader, Stack, Text, Title } from "@mantine/core";

import { artifactContentUrl, type StoryScene, type StorySceneAdoption } from "../api/client";
import { MediaThumb } from "./MediaThumb";
import { useSceneAdoptions } from "./useStory";

const SLOT_LABELS: Record<StorySceneAdoption["slot"], string> = {
  scene_image: "シーン画像",
  voice: "台詞の音声",
  bgm: "BGM",
  video: "動画",
  compose: "統合",
};

function AdoptedMedia({ adoption }: { adoption: StorySceneAdoption }) {
  const url = artifactContentUrl(adoption.artifact_id);
  if (adoption.slot === "scene_image") return <MediaThumb mediaKey={`artifact:${adoption.artifact_id}`} size={96} alt="採用したシーン画像" />;
  if (adoption.slot === "voice" || adoption.slot === "bgm") return <audio controls src={url} style={{ width: 220 }} />;
  return <video controls muted src={url} style={{ width: 160, borderRadius: 4 }} />;
}

/** 採用済みの生成物。枠ごとに1件 (音声は台詞ごと) をサムネイル・プレーヤーで並べる。 */
export function SceneAdoptions({ projectId, scene }: { projectId: string; scene: StoryScene }) {
  const adoptions = useSceneAdoptions(projectId, scene.id);
  const dialogueText = (dialogueId: string | null) =>
    scene.dialogues.find((dialogue) => dialogue.id === dialogueId)?.text;

  return (
    <Stack gap="xs">
      <Title order={5}>採用済みの生成物</Title>
      {adoptions.isPending ? <Loader size="xs" /> : null}
      {adoptions.error ? <Alert color="red">{adoptions.error.message}</Alert> : null}
      {adoptions.data?.length === 0 ? (
        <Text size="sm" c="dimmed">
          採用済みの生成物はありません。
        </Text>
      ) : null}
      <Group align="flex-start">
        {adoptions.data?.map((adoption) => (
          <Stack key={adoption.id} gap={4} data-testid="adoption" data-slot={adoption.slot}>
            <AdoptedMedia adoption={adoption} />
            <Text size="xs" c="dimmed" maw={220} truncate>
              {SLOT_LABELS[adoption.slot]}
              {adoption.dialogue_id ? `: ${dialogueText(adoption.dialogue_id) ?? ""}` : ""}
            </Text>
          </Stack>
        ))}
      </Group>
    </Stack>
  );
}
