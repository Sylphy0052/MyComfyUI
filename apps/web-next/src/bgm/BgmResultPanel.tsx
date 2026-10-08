import { Alert, Anchor, Badge, Button, Card, CloseButton, Group, Loader, Stack, Text, Title } from "@mantine/core";
import { Link } from "react-router";

import { artifactContentUrl, type ArtifactRecord } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { MemoField, viewerPathOf } from "../imageGen/ArtifactCard";
import { useJob, type SceneDecision } from "../imageGen/useImageGen";
import { STATE_LABELS } from "../jobs/JobDrawer";
import { notifyError } from "../notifications";
import { useSceneAdoptions } from "../projectDetail/useStory";
import { useBgmDecision, useJobAudio, type BgmResultEntry } from "./useBgm";

/** Sceneを指定して作った生成物の、BGM枠への採用と不採用の印。 */
function BgmDecisionButtons({
  artifact,
  projectId,
  sceneId,
}: {
  artifact: ArtifactRecord;
  projectId: string;
  sceneId: string;
}) {
  const adoptions = useSceneAdoptions(projectId, sceneId);
  const decide = useBgmDecision(projectId, sceneId);
  const adopted = adoptions.data?.some((item) => item.slot === "bgm" && item.artifact_id === artifact.id) ?? false;
  const rejected = artifact.decision === "rejected";
  const run = (action: SceneDecision) =>
    decide.mutate({ artifact, action, adopted }, { onError: (error) => notifyError("採否を変えられませんでした", error) });
  // 採用一覧を読めないと採用中かどうかが分からず、採用中のものを「採用」と誤表示して操作させてしまう。
  const busy = decide.isPending || adoptions.isPending || adoptions.isError;
  return (
    <>
      <Button
        size="compact-xs"
        variant={adopted ? "filled" : "light"}
        color="green"
        disabled={busy}
        onClick={() => run(adopted ? "release" : "adopt")}
      >
        {adopted ? "採用を外す" : "採用"}
      </Button>
      <Button
        size="compact-xs"
        variant={rejected ? "filled" : "light"}
        color="red"
        disabled={busy}
        onClick={() => run(rejected ? "unreject" : "reject")}
      >
        {rejected ? "不採用を外す" : "不採用"}
      </Button>
      {adoptions.isError ? (
        <Text size="xs" c="red" data-testid="adoptions-error">
          採用の状況を取得できません: {adoptions.error.message}
        </Text>
      ) : null}
    </>
  );
}

/** 完成したBGMのカード。その場で再生でき、メモ、採否 (Sceneを指定した場合)、Viewerで開くを持つ。 */
function BgmCard({ artifact }: { artifact: ArtifactRecord }) {
  const projectId = artifact.assigned_project_id;
  return (
    <Card withBorder padding="xs" data-testid="result-artifact" data-artifact-id={artifact.id}>
      <Stack gap={6}>
        <audio controls preload="none" src={artifactContentUrl(artifact.id)} style={{ width: "100%" }} />
        {artifact.decision !== "undecided" ? (
          <Badge size="xs" color={artifact.decision === "accepted" ? "green" : "red"}>
            {artifact.decision === "accepted" ? "採用" : "不採用"}
          </Badge>
        ) : null}
        <MemoField artifact={artifact} listKeyOf={queryKeys.jobAudio} />
        <Group gap={4}>
          {projectId && artifact.story_scene_id ? (
            <BgmDecisionButtons artifact={artifact} projectId={projectId} sceneId={artifact.story_scene_id} />
          ) : null}
          <Anchor component={Link} to={viewerPathOf(artifact)} size="xs">
            Viewerで開く
          </Anchor>
        </Group>
      </Stack>
    </Card>
  );
}

/** 待機中・実行中の生成のプレースホルダ。完成するとBGMのカードに差し替わる。 */
function PlaceholderCard({ label }: { label: string }) {
  return (
    <Card withBorder padding="xs" data-testid="result-placeholder">
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="xs" c="dimmed">
          {label}
        </Text>
      </Group>
    </Card>
  );
}

function JobResult({ entry, onRemove }: { entry: BgmResultEntry; onRemove: () => void }) {
  const job = useJob(entry.jobId);
  const succeeded = job.data?.state === "succeeded";
  const audio = useJobAudio(entry.jobId, succeeded);
  const state = job.data ? (STATE_LABELS[job.data.state] ?? { label: job.data.state, color: "gray" }) : null;

  const body = () => {
    if (job.data === undefined) {
      return job.error ? <Alert color="red">{job.error.message}</Alert> : <Loader size="xs" />;
    }
    if (job.data.state === "failed") {
      return (
        <Alert color="red" title="生成に失敗しました">
          {job.data.failure_message ?? "理由は記録されていません"}
        </Alert>
      );
    }
    if (job.data.state === "cancelled") {
      return (
        <Text size="sm" c="dimmed">
          中止しました
        </Text>
      );
    }
    if (succeeded && audio.data !== undefined) {
      if (audio.data.length === 0) {
        return (
          <Text size="sm" c="dimmed">
            BGMがありません (ゴミ箱へ移した可能性があります)
          </Text>
        );
      }
      return (
        <Stack gap="xs">
          {audio.data.map((artifact) => (
            <BgmCard key={artifact.id} artifact={artifact} />
          ))}
        </Stack>
      );
    }
    if (audio.error) return <Alert color="red">{audio.error.message}</Alert>;
    return <PlaceholderCard label={state?.label ?? "待機中"} />;
  };

  return (
    <Stack gap={4} data-testid="result-job" data-job-id={entry.jobId}>
      <Group justify="space-between">
        <Group gap="xs">
          {state ? (
            <Badge size="sm" color={state.color} variant="light">
              {state.label}
            </Badge>
          ) : null}
          <Text size="xs" c="dimmed">
            {job.data ? `#${job.data.queue_sequence}` : entry.jobId}
          </Text>
        </Group>
        <CloseButton size="sm" aria-label="結果欄から外す" onClick={onRemove} />
      </Group>
      {body()}
    </Stack>
  );
}

/** この画面から投入した生成を新しい順に出す。 */
export function BgmResultPanel({
  entries,
  onRemove,
}: {
  entries: BgmResultEntry[];
  onRemove: (jobId: string) => void;
}) {
  return (
    <Stack gap="md">
      <Title order={4}>結果</Title>
      {entries.length === 0 ? (
        <Text size="sm" c="dimmed">
          まだ生成していません。左の入力欄から投入すると、ここに新しい順で並びます。
        </Text>
      ) : null}
      {entries.map((entry) => (
        <JobResult key={entry.jobId} entry={entry} onRemove={() => onRemove(entry.jobId)} />
      ))}
    </Stack>
  );
}
