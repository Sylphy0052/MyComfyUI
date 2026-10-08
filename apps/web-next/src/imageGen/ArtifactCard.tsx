import { Anchor, Badge, Button, Card, Group, Image, Modal, Stack, Textarea, UnstyledButton } from "@mantine/core";
import { useState } from "react";
import { Link } from "react-router";

import { artifactContentUrl, type ArtifactRecord } from "../api/client";
import { notifyError } from "../notifications";
import { useCharacters, useSceneAdoptions } from "../projectDetail/useStory";
import { useAddCostumeReference, useSaveArtifactMemo, useSceneDecision, type SceneDecision } from "./useImageGen";

/** `ARTIFACT_MEMO_MAX_LENGTH` (`schemas.py`) に合わせる。 */
const MEMO_MAX = 2_000;

/** 生成物の紐づけで絞ったViewerのURL。生成物のIDも渡し、Viewerがその1件を開けるようにする。 */
export function viewerPathOf(artifact: ArtifactRecord): string {
  const params = new URLSearchParams();
  const entries: [string, string | null | undefined][] = [
    ["project", artifact.assigned_project_id],
    ["scene", artifact.story_scene_id],
    ["character", artifact.story_character_id],
    ["outfit", artifact.story_costume_id],
    ["artifact", artifact.id],
  ];
  for (const [name, value] of entries) if (value) params.set(name, value);
  return `/viewer?${params}`;
}

function MemoField({ artifact }: { artifact: ArtifactRecord }) {
  const saved = artifact.memo ?? "";
  const [draft, setDraft] = useState(saved);
  const save = useSaveArtifactMemo();
  return (
    <Group gap={4} align="flex-end" wrap="nowrap">
      <Textarea
        aria-label="メモ"
        placeholder="メモ"
        size="xs"
        autosize
        minRows={1}
        maxRows={4}
        maxLength={MEMO_MAX}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        style={{ flex: 1 }}
      />
      <Button
        size="compact-xs"
        variant="light"
        disabled={draft === saved}
        loading={save.isPending}
        onClick={() =>
          save.mutate(
            { artifactId: artifact.id, memo: draft },
            { onError: (error) => notifyError("メモを保存できませんでした", error) },
          )
        }
      >
        メモを保存
      </Button>
    </Group>
  );
}

/** Sceneを指定して作った生成物の、シーン画像枠への採用と不採用の印。 */
function SceneDecisionButtons({
  artifact,
  projectId,
  sceneId,
}: {
  artifact: ArtifactRecord;
  projectId: string;
  sceneId: string;
}) {
  const adoptions = useSceneAdoptions(projectId, sceneId);
  const decide = useSceneDecision(projectId, sceneId);
  const adopted = adoptions.data?.some((item) => item.slot === "scene_image" && item.artifact_id === artifact.id) ?? false;
  const rejected = artifact.decision === "rejected";
  const run = (action: SceneDecision) =>
    decide.mutate(
      { artifact, action, adopted },
      { onError: (error) => notifyError("採否を変えられませんでした", error) },
    );
  const busy = decide.isPending || adoptions.isPending;
  return (
    <>
      <Button size="compact-xs" variant={adopted ? "filled" : "light"} color="green" disabled={busy} onClick={() => run(adopted ? "release" : "adopt")}>
        {adopted ? "採用を外す" : "採用"}
      </Button>
      <Button size="compact-xs" variant={rejected ? "filled" : "light"} color="red" disabled={busy} onClick={() => run(rejected ? "unreject" : "reject")}>
        {rejected ? "不採用を外す" : "不採用"}
      </Button>
    </>
  );
}

/** 衣装を指定して作った生成物を、その衣装の参照画像へ足す。 */
function CostumeReferenceButton({ artifact, projectId }: { artifact: ArtifactRecord; projectId: string }) {
  const characters = useCharacters(projectId);
  const add = useAddCostumeReference(projectId);
  const costume = characters.data
    ?.flatMap((character) => character.costumes)
    .find((item) => item.id === artifact.story_costume_id);
  if (!costume) return null;
  const added = costume.reference_images.includes(`artifact:${artifact.id}`);
  return (
    <Button
      size="compact-xs"
      variant="light"
      disabled={added}
      loading={add.isPending}
      onClick={() =>
        add.mutate(
          { costume, artifactId: artifact.id },
          { onError: (error) => notifyError("衣装の参照に追加できませんでした", error) },
        )
      }
    >
      {added ? "衣装の参照に追加済み" : "この衣装の参照に追加"}
    </Button>
  );
}

/** 完成した生成物のカード。拡大表示、メモ、採否、衣装の参照への追加、入力欄へ戻す、Viewerで開く。 */
export function ArtifactCard({
  artifact,
  onRestore,
  restoring,
}: {
  artifact: ArtifactRecord;
  onRestore: () => void;
  restoring: boolean;
}) {
  const [zoomed, setZoomed] = useState(false);
  const url = artifactContentUrl(artifact.id);
  const projectId = artifact.assigned_project_id;
  return (
    <Card withBorder padding="xs" data-testid="result-artifact" data-artifact-id={artifact.id}>
      <Card.Section>
        <UnstyledButton onClick={() => setZoomed(true)} aria-label="拡大表示" style={{ display: "block", width: "100%" }}>
          <Image src={url} alt="生成した画像" fit="contain" h={220} bg="var(--mantine-color-default-hover)" />
        </UnstyledButton>
      </Card.Section>
      <Stack gap={6} mt="xs">
        {artifact.decision !== "undecided" ? (
          <Badge size="xs" color={artifact.decision === "accepted" ? "green" : "red"}>
            {artifact.decision === "accepted" ? "採用" : "不採用"}
          </Badge>
        ) : null}
        <MemoField artifact={artifact} />
        <Group gap={4}>
          {projectId && artifact.story_scene_id ? (
            <SceneDecisionButtons artifact={artifact} projectId={projectId} sceneId={artifact.story_scene_id} />
          ) : null}
          {projectId && artifact.story_costume_id ? (
            <CostumeReferenceButton artifact={artifact} projectId={projectId} />
          ) : null}
          <Button size="compact-xs" variant="light" loading={restoring} onClick={onRestore}>
            この設定を入力欄へ戻す
          </Button>
          <Anchor component={Link} to={viewerPathOf(artifact)} size="xs">
            Viewerで開く
          </Anchor>
        </Group>
      </Stack>
      <Modal opened={zoomed} onClose={() => setZoomed(false)} size="auto" title="生成した画像" centered>
        <Image src={url} alt="生成した画像 (拡大)" mah="80vh" fit="contain" />
      </Modal>
    </Card>
  );
}
