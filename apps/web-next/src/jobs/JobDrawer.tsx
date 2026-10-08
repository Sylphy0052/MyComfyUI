import { Badge, Button, Drawer, Group, Image, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { jobPreviewUrl, type GenerationJob } from "../api/client";
import { useProjectNames } from "../layout/projectContext";
import { jobResultPath, useCancelJob, useJobBoard, useJobProgress, useReplayJob } from "./useJobs";

const KIND_LABELS: Record<string, string> = {
  image: "画像",
  video: "動画",
  voice: "音声",
  music: "BGM",
  compose: "統合",
};

const STATE_LABELS: Record<string, { label: string; color: string }> = {
  queued: { label: "待機中", color: "gray" },
  running: { label: "実行中", color: "blue" },
  cancelling: { label: "中止中", color: "orange" },
  succeeded: { label: "完了", color: "green" },
  failed: { label: "失敗", color: "red" },
  cancelled: { label: "中止", color: "gray" },
};

function formatElapsed(job: GenerationJob, now: number): string {
  if (!job.started_at) return "-";
  const end = job.finished_at ? Date.parse(job.finished_at) : now;
  const seconds = Math.max(0, Math.round((end - Date.parse(job.started_at)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
}

function JobPreview({ jobId }: { jobId: string }) {
  const { data: progress } = useJobProgress(jobId);
  const [failedSeq, setFailedSeq] = useState<number | null>(null);
  if (!progress || progress.previewSeq === 0 || failedSeq === progress.previewSeq) return null;
  return (
    <Image
      src={jobPreviewUrl(jobId, progress.previewSeq)}
      alt="実行中のプレビュー"
      w={64}
      h={64}
      fit="cover"
      radius="sm"
      onError={() => setFailedSeq(progress.previewSeq)}
    />
  );
}

function JobRow({ job, now, projectName, onNavigate }: {
  job: GenerationJob;
  now: number;
  projectName: string | null;
  onNavigate: () => void;
}) {
  const cancel = useCancelJob();
  const replay = useReplayJob();
  const state = STATE_LABELS[job.state] ?? { label: job.state, color: "gray" };
  const error = cancel.error ?? replay.error;
  return (
    <Stack gap={4} p="xs" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={2}>
          <Group gap="xs">
            <Badge color={state.color} variant="light">{state.label}</Badge>
            <Text size="sm" fw={500}>{KIND_LABELS[job.kind] ?? job.kind}</Text>
            <Text size="xs" c="dimmed">{formatElapsed(job, now)}</Text>
          </Group>
          <Text size="xs" c="dimmed">
            {job.assigned_project_id ? (projectName ?? job.assigned_project_id) : "Project無し"}
            {job.assigned_scene_id ? ` / ${job.assigned_scene_id}` : ""}
          </Text>
        </Stack>
        {job.state === "running" ? <JobPreview jobId={job.id} /> : null}
      </Group>
      {job.state === "failed" && job.failure_message ? (
        <Text size="xs" c="red">{job.failure_message}</Text>
      ) : null}
      {error ? <Text size="xs" c="red">{error.message}</Text> : null}
      <Group gap="xs">
        {job.state === "queued" || job.state === "running" ? (
          <Button size="compact-xs" variant="default" loading={cancel.isPending} onClick={() => cancel.mutate(job.id)}>
            中止
          </Button>
        ) : null}
        {job.state === "failed" ? (
          <Button size="compact-xs" variant="default" loading={replay.isPending} onClick={() => replay.mutate(job.id)}>
            再実行
          </Button>
        ) : null}
        {job.state === "succeeded" ? (
          <Button size="compact-xs" variant="subtle" component={Link} to={jobResultPath(job.id)} onClick={onNavigate}>
            結果を開く
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}

export function JobDrawer({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { data: board, error } = useJobBoard();
  const { data: projectNames } = useProjectNames();
  const [now, setNow] = useState(() => Date.now());
  // 開いている間だけ、実行中の経過時間を1秒ごとに進める。
  useEffect(() => {
    if (!opened) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [opened]);

  return (
    <Drawer opened={opened} onClose={onClose} position="right" title="Job" size="md">
      {error ? <Text c="red" size="sm">{error.message}</Text> : null}
      {board && board.jobs.length === 0 ? <Text c="dimmed" size="sm">Jobはありません</Text> : null}
      {board?.jobs.map((job) => (
        <JobRow
          key={job.id}
          job={job}
          now={now}
          projectName={job.assigned_project_id ? (projectNames?.get(job.assigned_project_id) ?? null) : null}
          onNavigate={onClose}
        />
      ))}
    </Drawer>
  );
}
