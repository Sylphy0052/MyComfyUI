import { useState } from "react";

import { api } from "../api/client";
import type {
  AssignmentTarget,
  GenerationJob,
  GenerationManifest,
  ProjectRecord,
} from "../api/client";
import { AssignmentPicker } from "./AssignmentPicker";
import { ToggleGroup } from "./ui/ToggleGroup";
import { ROW_DENSITY_OPTIONS, useListDensity } from "../state/densityState";

const STATE_LABEL: Record<string, string> = {
  queued: "待機中",
  running: "実行中",
  cancelling: "取消中",
  succeeded: "成功",
  failed: "失敗",
  cancelled: "取消済み",
};

const CANCELLABLE = new Set(["queued", "running"]);
const ASSIGNMENT_LOCKED = new Set(["queued", "running", "cancelling"]);

/** 実行基盤の内部情報と、別に表示済みの項目。実行パラメータ欄には出さない。 */
const HIDDEN_PARAMETERS = new Set([
  "workflow_template",
  "workflow_template_sha256",
  "filename_prefix",
  "seed",
]);

function StateBadge({ state }: { state: string }) {
  return (
    <span className={`badge ${state}`}>{STATE_LABEL[state] ?? state}</span>
  );
}

interface Props {
  jobs: GenerationJob[];
  selectedJobId: string | null;
  manifest: GenerationManifest | null;
  onSelect: (jobId: string) => void;
  onCancel: (jobId: string) => void;
  projects: ProjectRecord[];
  unassigned: boolean;
  onAssignmentChanged: () => Promise<void>;
}

export function JobQueue({
  jobs,
  selectedJobId,
  manifest,
  onSelect,
  onCancel,
  projects,
  unassigned,
  onAssignmentChanged,
}: Props) {
  const [includeArtifacts, setIncludeArtifacts] = useState(true);
  const [density, setDensity] = useListDensity("jobs");
  const selected = jobs.find((job) => job.id === selectedJobId) ?? null;

  const moveJob = async (target: AssignmentTarget) => {
    if (!selected) return;
    await api.updateJobAssignment(selected.id, {
      ...target,
      include_artifacts: includeArtifacts,
    });
    await onAssignmentChanged();
  };

  return (
    <div>
      <section className="panel">
        <div className="row spread">
          <h2>{unassigned ? "InboxのJob" : "キュー"}</h2>
          <ToggleGroup label="Jobの表示形式" options={ROW_DENSITY_OPTIONS} value={density} onChange={setDensity} />
        </div>
        <ul className={`list density-${density}`}>
          {jobs.map((job) => (
            <li key={job.id}>
              <button
                type="button"
                aria-pressed={job.id === selectedJobId}
                onClick={() => onSelect(job.id)}
              >
                <span className="row">
                  <StateBadge state={job.state} />
                  <span className="muted">順番 {job.queue_sequence}</span>
                </span>
                <span className="mono">{job.id}</span>
              </button>
            </li>
          ))}
        </ul>
        {jobs.length === 0 && (
          <p className="muted">
            {unassigned
              ? "未所属のJobはありません。"
              : "この範囲のJobはまだありません。"}
          </p>
        )}
      </section>

      {selected && (
        <section className="panel">
          <h2>Job詳細</h2>
          <div className="stack">
            <div className="row">
              <StateBadge state={selected.state} />
              {CANCELLABLE.has(selected.state) && (
                <button type="button" className="danger-button" onClick={() => onCancel(selected.id)}>
                  取消
                </button>
              )}
            </div>

            {selected.state === "failed" && (
              <div className="error">
                <div>{selected.failure_message ?? "失敗理由は記録されていません。"}</div>
                <div className="muted">
                  code: {selected.failure_code ?? "-"} / stage:{" "}
                  {selected.failure_stage ?? "-"} / 再試行:{" "}
                  {selected.retryable ? "可" : "不可"}
                </div>
              </div>
            )}

            <dl className="kv">
              <dt>開始</dt>
              <dd>{selected.started_at ?? "-"}</dd>
              <dt>終了</dt>
              <dd>{selected.finished_at ?? "-"}</dd>
              <dt>親Job</dt>
              <dd className="mono">{selected.parent_job_id ?? "-"}</dd>
              <dt>現在の所属</dt>
              <dd className="mono">
                {selected.assigned_project_id ?? "Inbox"}
                {selected.assigned_scene_id
                  ? ` / ${selected.assigned_scene_id}`
                  : ""}
                {selected.assigned_shot_id
                  ? ` / ${selected.assigned_shot_id}`
                  : ""}
              </dd>
            </dl>

            <div className="stack">
              <h2>所属変更</h2>
              {ASSIGNMENT_LOCKED.has(selected.state) ? (
                <p className="muted">
                  待機中・実行中・取消中のJobは、完了後に所属を変更できます。
                </p>
              ) : (
                <>
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={includeArtifacts}
                      onChange={(event) =>
                        setIncludeArtifacts(event.target.checked)
                      }
                    />
                    このJobのArtifactも一緒に移動する
                  </label>
                  <AssignmentPicker
                    projects={projects}
                    initialProjectId={selected.assigned_project_id}
                    initialSceneId={selected.assigned_scene_id}
                    initialShotId={selected.assigned_shot_id}
                    onMove={moveJob}
                  />
                </>
              )}
            </div>

            {manifest && (
              <>
                <h2>再投入に必要な入力</h2>
                <dl className="kv">
                  <dt>プロンプト</dt>
                  <dd>{manifest.resolved_prompt}</dd>
                  <dt>seed</dt>
                  <dd className="mono">{manifest.seed}</dd>
                  {Object.entries(manifest.parameters).map(([key, value]) => (
                    <FragmentEntry key={key} name={key} value={value} />
                  ))}
                </dl>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * Workflow テンプレート名とモデルの識別子は通常操作では見せない (Issue #8)。
 * 値が object のものも、この画面では表示しない。
 */
function FragmentEntry({ name, value }: { name: string; value: unknown }) {
  if (HIDDEN_PARAMETERS.has(name)) {
    return null;
  }
  if (typeof value === "object" && value !== null) {
    return null;
  }
  return (
    <>
      <dt>{name}</dt>
      <dd className="mono">{String(value)}</dd>
    </>
  );
}
