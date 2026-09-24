import { api } from "../api/client";
import type {
  Artifact,
  GenerationJob,
  GenerationManifest,
  JobLineage,
} from "../api/client";
import { ArtifactPromptRevision } from "./ArtifactPromptRevision";
import { KIND_LABEL, asText, shorten } from "./CanonWarning";

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

/**
 * Artifact の出自と lineage。履歴と資産ブラウザの双方から使う。
 */
export function ArtifactDetail({
  artifact,
  job,
  manifest,
  lineage,
  onApplySettings,
  onRevisedJob,
}: {
  artifact: Artifact;
  job: GenerationJob;
  manifest: GenerationManifest;
  lineage: JobLineage;
  /** 渡されたときだけ、生成条件を生成フォームへ戻すボタンを出す。 */
  onApplySettings?: () => void;
  /** 渡されたときだけ、画像を見て指示でプロンプトを直す欄を出す (#303)。 */
  onRevisedJob?: (job: GenerationJob) => void;
}) {
  return (
    <div className="stack">
      {onApplySettings && artifact.kind === "image" && (
        <div className="row">
          <button type="button" onClick={onApplySettings}>
            この設定で生成
          </button>
        </div>
      )}
      <ManifestDetail artifact={artifact} job={job} manifest={manifest} />
      {onRevisedJob && artifact.kind === "image" && job.kind === "image" && (
        <ArtifactPromptRevision key={artifact.id} artifactId={artifact.id} jobId={job.id} onRevisedJob={onRevisedJob} />
      )}
      <Lineage lineage={lineage} currentJobId={job.id} />
    </div>
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
                {asText(reference.path) ??
                  asText(reference.relative_path) ??
                  "-"}
                {asText(reference.anchor)
                  ? ` #${asText(reference.anchor)}`
                  : ""}
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
        <p className="muted">辿れる上限に達したため、一部のJobを省いている。</p>
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
