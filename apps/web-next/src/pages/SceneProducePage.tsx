import { Alert, Anchor, Badge, Group, Loader, NavLink, Paper, Stack, Text, Title } from "@mantine/core";
import { Link, useParams, useSearchParams } from "react-router";

import type { StoryScene } from "../api/client";
import { useProject } from "../layout/projectContext";
import { SceneAdoptions } from "../projectDetail/SceneAdoptions";
import { useCharacters, useSceneAdoptions, useScenes } from "../projectDetail/useStory";
import {
  computeStepStatus,
  FAILED_STATUS,
  hasAllReferenceImages,
  readStep,
  STATUS_COLORS,
  STATUS_LABELS,
  STEPS,
  stepLabel,
  type StepId,
  type StepStatus,
} from "../sceneProduce/steps";
import {
  useActiveJobs,
  useCharacterCandidates,
  useComposeArtifactIds,
  useSceneMedia,
} from "../sceneProduce/useSceneProduce";

type QueryState = { isPending: boolean; isLoadingError: boolean };

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
  const activeJobs = useActiveJobs(projectId);
  const media = useSceneMedia(scene.id);
  const composeIds = useComposeArtifactIds(projectId, scene.id);
  // 参照画像がそろっていればキャラ画像の候補は数えないので、取らない。
  const needsCandidates = characters.data !== undefined && !hasAllReferenceImages(scene, characters.data);
  const castIds = [...new Set(scene.cast.map((entry) => entry.character_id))];
  const characterMedia = useCharacterCandidates(projectId, castIds, needsCandidates);

  // 工程ごとの、状態の計算に要る取得。1つでも取れなかった工程は「取得失敗」、取得中の工程は読み込み中にする。
  // 一度取れたあとの再取得の失敗は、古いデータで状態を出し続け、上のAlertでだけ知らせる。
  // `computeStepStatus`が使う入力と合わせる。キャラ画像は採用枠を持たず、シーンの生成物ではなく
  // キャラに紐づく画像を見るので、採用とシーンの生成物を待たない。統合Jobの生成物IDは
  // 動画と統合の見分けにだけ使う。
  const sourcesOf = (id: StepId): QueryState[] => {
    if (id === "character") return needsCandidates ? [characters, activeJobs, characterMedia] : [characters, activeJobs];
    const common = [adoptions, activeJobs, media];
    return id === "video" || id === "compose" ? [...common, composeIds] : common;
  };
  const error = [characters, adoptions, activeJobs, media, composeIds, ...(needsCandidates ? [characterMedia] : [])].find(
    (query) => query.error,
  )?.error;
  // 一覧が上限に達して、古いJob・生成物を数えていない工程。`sourcesOf`と同じ対応で選ぶ。
  // キャラ候補は1件あれば「候補あり」と決まり、上限に達しても状態が変わらないので含めない。
  const truncatedLabels = STEPS.filter(({ id }) => {
    if (activeJobs.data?.truncated) return true;
    if (id === "character") return false;
    if (media.data?.truncated) return true;
    return (id === "video" || id === "compose") && composeIds.data?.truncated === true;
  }).map(({ label }) => label);

  const inputs = {
    scene,
    characters: characters.data ?? [],
    adoptions: adoptions.data ?? [],
    activeJobs: activeJobs.data?.items ?? [],
    sceneMedia: media.data?.items ?? [],
    composeArtifactIds: composeIds.data?.items ?? new Set<string>(),
    characterMedia: needsCandidates ? (characterMedia.data?.items ?? []) : [],
  };
  const statuses = new Map<StepId, StepStatus>();
  for (const { id } of STEPS) {
    const sources = sourcesOf(id);
    if (sources.some((query) => query.isLoadingError)) statuses.set(id, FAILED_STATUS);
    else if (!sources.some((query) => query.isPending)) statuses.set(id, computeStepStatus(id, inputs));
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
      {truncatedLabels.length > 0 ? (
        <Alert color="yellow" data-testid="produce-truncated">
          一覧が取得の上限に達したため、{truncatedLabels.join("・")}の状態は新しいJob・生成物だけで集計しています。
        </Alert>
      ) : null}
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
  if (project.data.lifecycle === "trashed") {
    return <BackToProjects message="ゴミ箱にあるProjectです。復元してから開いてください。" />;
  }
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
