import { Alert, Badge, Box, CloseButton, Group, Loader, SimpleGrid, Stack, Text } from "@mantine/core";
import { Fragment } from "react";

import type { ArtifactRecord, GenerationExperiment, GenerationExperimentItem } from "../api/client";
import { STATE_LABELS } from "../jobs/JobDrawer";
import { ArtifactCard } from "./ArtifactCard";
import { AXIS_LABELS, AXIS_ORDER, axisValueText, cellLabel, type SweepAxisName } from "./sweep";
import { useExperiment } from "./useSweep";
import { useJob, useJobImages } from "./useImageGen";

type CellActions = {
  onRestore: (jobId: string) => void;
  restoringJobId: string | null;
  onSendToEdit: (artifact: ArtifactRecord) => void;
};

/** 実験の項目の状態を、Jobの状態の表示名へ寄せる。 */
function stateOf(item: GenerationExperimentItem): { label: string; color: string } {
  const key = item.state === "completed" ? "succeeded" : item.state === "pending" ? "queued" : item.state;
  return STATE_LABELS[key] ?? { label: item.state, color: "gray" };
}

/** Jobが失敗した理由。実験の項目は理由を持たないため、Jobから読む。 */
function FailureNote({ item }: { item: GenerationExperimentItem }) {
  const job = useJob(item.job_id ?? "");
  const reason = item.planning_error ?? job.data?.failure_message ?? "理由は記録されていません";
  return (
    <Alert color="red" title="生成に失敗しました" p="xs">
      <Text size="xs">{reason}</Text>
    </Alert>
  );
}

function CellBody({ item, actions }: { item: GenerationExperimentItem; actions: CellActions }) {
  const completed = item.state === "completed" && item.job_id !== null;
  const images = useJobImages(item.job_id ?? "", completed);
  const jobId = item.job_id;
  if (item.state === "failed") return jobId === null ? <Alert color="red" p="xs">{item.planning_error ?? "理由は記録されていません"}</Alert> : <FailureNote item={item} />;
  if (item.state === "cancelled") {
    return (
      <Text size="sm" c="dimmed">
        中止しました
      </Text>
    );
  }
  if (completed && jobId !== null && images.data !== undefined) {
    if (images.data.length === 0) {
      return (
        <Text size="sm" c="dimmed">
          画像がありません (ゴミ箱へ移した可能性があります)
        </Text>
      );
    }
    return (
      <Stack gap="xs">
        {images.data.map((artifact) => (
          <ArtifactCard
            key={artifact.id}
            artifact={artifact}
            onRestore={() => actions.onRestore(jobId)}
            restoring={actions.restoringJobId === jobId}
            onSendToEdit={actions.onSendToEdit}
          />
        ))}
      </Stack>
    );
  }
  if (images.error) return <Alert color="red">{images.error.message}</Alert>;
  return (
    <Stack h={120} align="center" justify="center" gap={4} bg="var(--mantine-color-default-hover)" data-testid="sweep-placeholder">
      <Loader size="sm" />
      <Text size="xs" c="dimmed">
        {stateOf(item).label}
      </Text>
    </Stack>
  );
}

function Cell({ item, actions, showLabel }: { item: GenerationExperimentItem; actions: CellActions; showLabel: boolean }) {
  const state = stateOf(item);
  return (
    <Stack gap={4} data-testid="sweep-cell" data-state={item.state} data-label={cellLabel(item.variables)}>
      {showLabel ? (
        <Group gap="xs">
          <Text size="xs" fw={500} data-testid="sweep-cell-label">
            {cellLabel(item.variables)}
          </Text>
          <Badge size="xs" color={state.color} variant="light">
            {state.label}
          </Badge>
        </Group>
      ) : (
        <Badge size="xs" color={state.color} variant="light" w="fit-content">
          {state.label}
        </Badge>
      )}
      <CellBody item={item} actions={actions} />
    </Stack>
  );
}

type TableLayout = { rowAxis: SweepAxisName; colAxis: SweepAxisName; rows: unknown[]; cols: unknown[] };

/** 軸が2つで、行と列の全ての組み合わせが1件ずつある (全組合せ) とき、行×列の表にする。 */
function tableLayout(items: GenerationExperimentItem[]): TableLayout | null {
  const first = items[0];
  if (first === undefined) return null;
  const axes = AXIS_ORDER.filter((name) => name in first.variables);
  const [rowAxis, colAxis] = axes;
  if (axes.length !== 2 || rowAxis === undefined || colAxis === undefined) return null;
  const unique = (name: SweepAxisName) => [...new Set(items.map((item) => JSON.stringify(item.variables[name])))].map((text) => JSON.parse(text) as unknown);
  const rows = unique(rowAxis);
  const cols = unique(colAxis);
  const pairs = new Set(items.map((item) => JSON.stringify([item.variables[rowAxis], item.variables[colAxis]])));
  return pairs.size === items.length && items.length === rows.length * cols.length ? { rowAxis, colAxis, rows, cols } : null;
}

function SweepTable({ items, layout, actions }: { items: GenerationExperimentItem[]; layout: TableLayout; actions: CellActions }) {
  const find = (row: unknown, col: unknown) =>
    items.find(
      (item) =>
        JSON.stringify(item.variables[layout.rowAxis]) === JSON.stringify(row) &&
        JSON.stringify(item.variables[layout.colAxis]) === JSON.stringify(col),
    );
  return (
    <Box style={{ overflowX: "auto" }}>
      <Box
        data-testid="sweep-table"
        style={{
          display: "grid",
          gridTemplateColumns: `max-content repeat(${layout.cols.length}, minmax(180px, 1fr))`,
          gap: "var(--mantine-spacing-xs)",
          alignItems: "start",
        }}
      >
        <Text size="xs" c="dimmed">
          {AXIS_LABELS[layout.rowAxis]} ＼ {AXIS_LABELS[layout.colAxis]}
        </Text>
        {layout.cols.map((col) => (
          <Text key={JSON.stringify(col)} size="xs" fw={600} data-testid="sweep-col-head">
            {AXIS_LABELS[layout.colAxis]}={axisValueText(layout.colAxis, col)}
          </Text>
        ))}
        {layout.rows.map((row) => (
          <Fragment key={JSON.stringify(row)}>
            <Text size="xs" fw={600} data-testid="sweep-row-head">
              {AXIS_LABELS[layout.rowAxis]}={axisValueText(layout.rowAxis, row)}
            </Text>
            {layout.cols.map((col) => {
              const item = find(row, col);
              return item ? (
                <Cell key={item.id} item={item} actions={actions} showLabel={false} />
              ) : (
                <Box key={JSON.stringify(col)} />
              );
            })}
          </Fragment>
        ))}
      </Box>
    </Box>
  );
}

function SweepBody({ experiment, actions }: { experiment: GenerationExperiment; actions: CellActions }) {
  const layout = tableLayout(experiment.items);
  if (layout !== null) return <SweepTable items={experiment.items} layout={layout} actions={actions} />;
  return (
    <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="xs" data-testid="sweep-list">
      {experiment.items.map((item) => (
        <Cell key={item.id} item={item} actions={actions} showLabel />
      ))}
    </SimpleGrid>
  );
}

const EXPERIMENT_STATE: Record<string, { label: string; color: string }> = {
  pending: { label: "待機中", color: "gray" },
  running: { label: "実行中", color: "blue" },
  completed: { label: "完了", color: "green" },
  completed_with_errors: { label: "一部失敗", color: "orange" },
};

/** 投入したスイープ1件。軸のラベル付きのグリッドで、セルごとに生成の状態と画像を出す。 */
export function SweepResult({ experimentId, onRemove, ...actions }: { experimentId: string; onRemove: () => void } & CellActions) {
  const experiment = useExperiment(experimentId);
  const data = experiment.data;
  const state = data ? (EXPERIMENT_STATE[data.state] ?? { label: data.state, color: "gray" }) : null;
  return (
    <Stack gap={4} data-testid="result-sweep" data-experiment-id={experimentId}>
      <Group justify="space-between">
        <Group gap="xs">
          {state ? (
            <Badge size="sm" color={state.color} variant="light">
              {state.label}
            </Badge>
          ) : null}
          <Text size="xs" c="dimmed">
            {data ? `${data.name} (${data.items.length}件)` : experimentId}
          </Text>
        </Group>
        <CloseButton size="sm" aria-label="結果欄から外す" onClick={onRemove} />
      </Group>
      {data === undefined ? (
        experiment.error ? <Alert color="red">{experiment.error.message}</Alert> : <Loader size="xs" />
      ) : (
        <SweepBody experiment={data} actions={actions} />
      )}
    </Stack>
  );
}
