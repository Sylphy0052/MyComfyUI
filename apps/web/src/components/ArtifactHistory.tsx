import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  Artifact,
  CanonStatus,
  GenerationJob,
  GenerationManifest,
  JobLineage,
} from "../api/client";
import { CanonWarning, KIND_LABEL, asText, shorten } from "./CanonWarning";

const STATE_LABEL: Record<string, string> = {
  queued: "待機中",
  running: "実行中",
  cancelling: "取消中",
  succeeded: "成功",
  failed: "失敗",
  cancelled: "取消済み",
};

/** Workflow テンプレートの識別子は通常操作で見せない (Issue #8 と揃える)。 */
const HIDDEN_PARAMETERS = new Set([
  "workflow_template",
  "workflow_template_sha256",
  "filename_prefix",
  "seed",
]);

interface Detail {
  artifact: Artifact;
  job: GenerationJob;
  manifest: GenerationManifest;
  canonStatus: CanonStatus;
  lineage: JobLineage;
}

interface Props {
  shotId: string | null;
  /** Job を投入したときに値を変え、履歴を取り直させる。 */
  refreshToken: number;
  onDerivedJob: (job: GenerationJob) => void;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return error.requestId
      ? `${error.message} (${error.code} / request_id=${error.requestId})`
      : `${error.message} (${error.code})`;
  }
  return String(error);
}

export function ArtifactHistory({
  shotId,
  refreshToken,
  onDerivedJob,
}: Props) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(
    null,
  );
  const [includeRecords, setIncludeRecords] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!shotId) {
      setArtifacts([]);
      setSelectedArtifactId(null);
      return;
    }
    let active = true;
    (async () => {
      try {
        const list = await api.listArtifacts({
          shotId,
          kind: includeRecords ? undefined : "image",
        });
        if (!active) return;
        setArtifacts(list);
        setSelectedArtifactId((current) =>
          current && list.some((item) => item.id === current)
            ? current
            : (list[0]?.id ?? null),
        );
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [shotId, includeRecords, refreshToken]);

  const selected = useMemo(
    () => artifacts.find((item) => item.id === selectedArtifactId) ?? null,
    [artifacts, selectedArtifactId],
  );

  const loadDetail = useCallback(async (artifact: Artifact) => {
    const job = await api.getJob(artifact.job_id);
    const [manifest, canonStatus, lineage] = await Promise.all([
      api.getManifest(job.manifest_id),
      api.getCanonStatus(job.id),
      api.getLineage(job.id),
    ]);
    return { artifact, job, manifest, canonStatus, lineage };
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let active = true;
    (async () => {
      try {
        const loaded = await loadDetail(selected);
        if (active) setDetail(loaded);
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [selected, loadDetail, refreshToken]);

  const derive = async (mode: "replay" | "regenerate") => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const job =
        mode === "replay"
          ? await api.replayJob(detail.job.id)
          : await api.regenerateJob(detail.job.id);
      onDerivedJob(job);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel history">
      <h2>Artifact履歴</h2>
      {error && (
        <div className="error">
          <div>{error}</div>
          <button type="button" onClick={() => setError(null)}>
            閉じる
          </button>
        </div>
      )}
      <label className="row">
        <input
          type="checkbox"
          checked={includeRecords}
          onChange={(event) => setIncludeRecords(event.target.checked)}
        />
        Workflowと記録用のArtifactも表示する
      </label>

      <div className="history-body">
        <ul className="list">
          {artifacts.map((artifact) => (
            <li key={artifact.id}>
              <button
                type="button"
                aria-pressed={artifact.id === selectedArtifactId}
                onClick={() => setSelectedArtifactId(artifact.id)}
              >
                <span className="row">
                  <span className="badge">{artifact.kind}</span>
                  <span className="muted">{artifact.created_at}</span>
                </span>
                <span className="mono">{artifact.sha256.slice(0, 16)}</span>
              </button>
            </li>
          ))}
        </ul>
        {artifacts.length === 0 && (
          <p className="muted">このShotのArtifactはまだありません。</p>
        )}

        {detail && (
          <div className="stack">
            <CanonWarning status={detail.canonStatus} job={detail.job} />

            <div className="row">
              <button
                type="button"
                className="primary"
                disabled={busy || !detail.canonStatus.replayable}
                onClick={() => derive("replay")}
              >
                当時の条件で再実行
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => derive("regenerate")}
              >
                現在のCanonで再生成
              </button>
            </div>

            <ManifestDetail
              artifact={detail.artifact}
              job={detail.job}
              manifest={detail.manifest}
            />
            <Lineage lineage={detail.lineage} currentJobId={detail.job.id} />
          </div>
        )}
      </div>
    </section>
  );
}

/** Artifact の出自。入力、Canon 参照、モデル、seed、Workflow、プロンプトを並べる。 */
function ManifestDetail({
  artifact,
  job,
  manifest,
}: {
  artifact: Artifact;
  job: GenerationJob;
  manifest: GenerationManifest;
}) {
  const references = manifest.input_refs ?? [];
  return (
    <div className="stack">
      <h3>この生成物の出自</h3>
      <dl className="kv">
        <dt>Artifact</dt>
        <dd className="mono">{artifact.id}</dd>
        <dt>SHA-256</dt>
        <dd className="mono">{artifact.sha256}</dd>
        <dt>Job</dt>
        <dd className="mono">
          {job.id}
          <span className="muted">
            {" "}
            ({STATE_LABEL[job.state] ?? job.state})
          </span>
        </dd>
        <dt>Manifest</dt>
        <dd className="mono">{manifest.id}</dd>
        <dt>再実行元</dt>
        <dd className="mono">{manifest.replay_of_manifest_id ?? "-"}</dd>
        <dt>実行Backend</dt>
        <dd className="mono">
          {manifest.engine}
          {manifest.engine_version ? ` / ${manifest.engine_version}` : ""}
        </dd>
        <dt>seed</dt>
        <dd className="mono">{manifest.seed}</dd>
        <dt>プロンプト</dt>
        <dd>{manifest.resolved_prompt}</dd>
        {Object.entries(manifest.model ?? {}).map(([name, value]) => (
          <ValueEntry key={`model-${name}`} name={name} value={value} />
        ))}
        {Object.entries(manifest.parameters ?? {})
          .filter(([name]) => !HIDDEN_PARAMETERS.has(name))
          .map(([name, value]) => (
            <ValueEntry key={`param-${name}`} name={name} value={value} />
          ))}
        <dt>Workflow</dt>
        <dd>
          <a
            href={api.artifactContentUrl(manifest.workflow_artifact_id)}
            target="_blank"
            rel="noreferrer"
          >
            実行時のWorkflow JSON
          </a>
        </dd>
      </dl>

      <h3>入力とCanon参照</h3>
      {references.length === 0 ? (
        <p className="muted">
          このManifestには参照が記録されていません。参照を解決する前に作られたJobです。
        </p>
      ) : (
        <ul className="list plain">
          {references.map((reference, index) => (
            <li key={`${asText(reference.canon_id) ?? index}`}>
              <span className="row">
                <span className="badge">
                  {KIND_LABEL[String(reference.kind)] ?? String(reference.kind)}
                </span>
                <span className="muted">
                  {shorten(reference.revision, 7)} /{" "}
                  {shorten(reference.sha256, 12)}
                </span>
              </span>
              <span className="mono">
                {asText(reference.path) ?? asText(reference.relative_path) ?? "-"}
                {asText(reference.anchor) ? ` #${asText(reference.anchor)}` : ""}
              </span>
              {asText(reference.note) && (
                <span className="muted">{asText(reference.note)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ValueEntry({ name, value }: { name: string; value: unknown }) {
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

/** 親子 Job と派生 Artifact。再実行で増えた Job がどこから来たかを示す。 */
function Lineage({
  lineage,
  currentJobId,
}: {
  lineage: JobLineage;
  currentJobId: string;
}) {
  const rows = [
    ...lineage.ancestors.map((job) => ({ job, relation: "親" })),
    { job: lineage.job, relation: "この生成" },
    ...lineage.descendants.map((job) => ({ job, relation: "派生" })),
  ];
  const countByJob = new Map<string, number>();
  for (const artifact of lineage.artifacts) {
    countByJob.set(artifact.job_id, (countByJob.get(artifact.job_id) ?? 0) + 1);
  }

  return (
    <div className="stack">
      <h3>lineage</h3>
      {/* 上限で打ち切った場合は全件ではないことを出す。欠落に気づけないと */}
      {/* 派生の追跡を誤る。 */}
      {lineage.truncated && (
        <p className="muted">
          辿れる上限に達したため、一部のJobを省いている。
        </p>
      )}
      {rows.length === 1 ? (
        <p className="muted">派生はありません。</p>
      ) : (
        <ul className="list plain">
          {rows.map(({ job, relation }) => (
            <li
              key={job.id}
              className={job.id === currentJobId ? "current" : undefined}
            >
              <span className="row">
                <span className="muted">{relation}</span>
                <span className={`badge ${job.state}`}>
                  {STATE_LABEL[job.state] ?? job.state}
                </span>
                <span className="muted">
                  Artifact {countByJob.get(job.id) ?? 0} 件
                </span>
              </span>
              <span className="mono">{job.id}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
