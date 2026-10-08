import { Alert, Anchor, Badge, Group, Loader, NavLink, Paper, Stack, Text, Title } from "@mantine/core";
import { Link, useParams, useSearchParams } from "react-router";

import type { StoryScene } from "../api/client";
import { useProject } from "../layout/projectContext";
import { SceneAdoptions } from "../projectDetail/SceneAdoptions";
import { useCharacters, useSceneAdoptions, useScenes } from "../projectDetail/useStory";
import {
  computeStepStatus,
  hasAllReferenceImages,
  readStep,
  STATUS_LABELS,
  STEPS,
  stepLabel,
  type StepId,
  type StepStatus,
  type StepStatusKey,
} from "../sceneProduce/steps";
import { useCharacterCandidates, useSceneJobs, useSceneMedia } from "../sceneProduce/useSceneProduce";

const STATUS_COLORS: Record<StepStatusKey, string> = {
  adopted: "green",
  running: "blue",
  candidate: "yellow",
  skipped: "gray",
  todo: "gray",
};

function BackToProjects({ message }: { message: string }) {
  return (
    <Stack>
      <Alert color="red" title="シーン生成を開けません">
        {message}
      </Alert>
      <Anchor component={Link} to="/projects">
        Project一覧へ戻る
      </Anchor>
    </Stack>
  );
}

function StatusBadge({ status }: { status: StepStatus }) {
  return (
    <Group gap={4} wrap="nowrap">
      <Badge size="sm" variant={status.key === "todo" ? "outline" : "light"} color={STATUS_COLORS[status.key]}>
        {STATUS_LABELS[status.key]}
      </Badge>
      {status.detail ? (
        <Badge size="sm" variant="outline" color="green">
          {status.detail}
        </Badge>
      ) : null}
    </Group>
  );
}

/** 左にステッパー、右に選んだ工程の枠。工程の中身は後続のIssueで埋める。 */
function ProduceBody({ projectId, scene }: { projectId: string; scene: StoryScene }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const step = readStep(searchParams.get("step"));
  const characters = useCharacters(projectId);
  const adoptions = useSceneAdoptions(projectId, scene.id);
  const jobs = useSceneJobs(projectId, scene.id);
  const media = useSceneMedia(scene.id);
  // 参照画像がそろっていればキャラ画像の候補は数えないので、取らない。
  const needsCandidates = characters.data !== undefined && !hasAllReferenceImages(scene, characters.data);
  const characterMedia = useCharacterCandidates(projectId, needsCandidates);

  const queries = [characters, adoptions, jobs, media, characterMedia];
  const loading = [characters, adoptions, jobs, media].some((query) => query.isPending);
  const error = queries.find((query) => query.error)?.error;

  const statuses = new Map<StepId, StepStatus>();
  if (!loading) {
    const inputs = {
      scene,
      characters: characters.data ?? [],
      adoptions: adoptions.data ?? [],
      activeJobs: jobs.data?.active ?? [],
      sceneMedia: media.data ?? [],
      composeArtifactIds: jobs.data?.composeArtifactIds ?? new Set<string>(),
      characterMedia: needsCandidates ? (characterMedia.data ?? []) : [],
    };
    for (const { id } of STEPS) statuses.set(id, computeStepStatus(id, inputs));
  }

  const select = (id: StepId) => {
    const next = new URLSearchParams(searchParams);
    next.set("step", id);
    setSearchParams(next);
  };
  const current = statuses.get(step);

  return (
    <Stack>
      {error ? <Alert color="red">{error.message}</Alert> : null}
      <Group align="flex-start" wrap="nowrap" gap="lg">
        <Stack gap={4} w={240} style={{ flexShrink: 0 }} data-testid="produce-stepper">
          {STEPS.map(({ id, label }, index) => {
            const status = statuses.get(id);
            return (
              <NavLink
                key={id}
                active={id === step}
                label={`${index + 1}. ${label}`}
                rightSection={status ? <StatusBadge status={status} /> : <Loader size="xs" />}
                onClick={() => select(id)}
                data-testid="produce-step"
                data-step={id}
                data-status={status?.key ?? "loading"}
              />
            );
          })}
        </Stack>
        <Paper withBorder p="md" style={{ flex: 1, minWidth: 0 }} data-testid="produce-panel" data-step={step}>
          <Group justify="space-between">
            <Title order={4}>{stepLabel(step)}</Title>
            {current ? <StatusBadge status={current} /> : <Loader size="xs" />}
          </Group>
          <Text c="dimmed" size="sm" mt="sm">
            この工程の画面はまだありません。
          </Text>
        </Paper>
      </Group>
    </Stack>
  );
}

/** `/scenes/:sceneId/produce?project=&step=`。シーンを6工程で作る画面の骨組み。 */
export function SceneProducePage() {
  const { sceneId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get("project");
  const project = useProject(projectId);
  const scenes = useScenes(projectId);

  if (!projectId) return <BackToProjects message="URLにProject (?project=) がありません。" />;
  if (project.isPending || scenes.isPending) return <Loader size="sm" />;
  if (project.data === undefined) return <BackToProjects message={project.error?.message ?? "Projectを開けません。"} />;
  if (scenes.data === undefined) return <BackToProjects message={scenes.error?.message ?? "シーンを開けません。"} />;
  const scene = scenes.data.find((item) => item.id === sceneId);
  if (!scene) return <BackToProjects message="シーンが見つかりません。" />;

  return (
    <Stack>
      <div>
        <Group gap="xs">
          <Anchor component={Link} to="/projects" size="sm">
            Project一覧
          </Anchor>
          <Text size="sm" c="dimmed">
            /
          </Text>
          <Anchor component={Link} to={`/projects/${encodeURIComponent(projectId)}`} size="sm" data-testid="produce-project">
            {project.data.name}
          </Anchor>
        </Group>
        <Title order={2} data-testid="produce-scene-name">
          {scene.name}
        </Title>
      </div>
      <SceneAdoptions projectId={projectId} scene={scene} />
      <ProduceBody projectId={projectId} scene={scene} />
    </Stack>
  );
}
