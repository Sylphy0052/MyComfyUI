import { api, type GenerationJob } from "../api/client";

// events の generation_job.progress から得た、実行中 Job の最新の進み具合。
export type JobProgress = {
  jobId: string;
  value: number;
  max: number;
  node: string | null;
  // 最新プレビューの連番。0 はまだプレビューが無いことを表す。
  previewSeq: number;
};

// events の payload を JobProgress へ読み替える。形が合わなければ null。
export function parseJobProgress(payload: unknown): JobProgress | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const { job_id, value, max, node, preview_seq } = record;
  if (
    typeof job_id !== "string" ||
    typeof value !== "number" ||
    typeof max !== "number" ||
    typeof preview_seq !== "number"
  ) {
    return null;
  }
  return {
    jobId: job_id,
    value,
    max,
    node: typeof node === "string" ? node : null,
    previewSeq: preview_seq,
  };
}

type Props = {
  job: GenerationJob;
  // job の進捗。まだ届いていなければ null。
  progress: JobProgress | null;
};

// 実行中 Job の進捗バーと生成途中のプレビュー画像を出す。
export function JobProgressPanel({ job, progress }: Props) {
  const hasValue = progress !== null && progress.max > 0;
  const percent = hasValue
    ? Math.round((progress.value / progress.max) * 100)
    : null;

  return (
    <section className="panel job-progress">
      <div className="row spread">
        <h2>生成中</h2>
        <span className="muted">
          順番 {job.queue_sequence}
          {percent !== null &&
            `・${progress?.value}/${progress?.max} (${percent}%)`}
        </span>
      </div>
      {/* value を渡さないと不定の進捗バーになる。進捗が届くまではこちらを出す。 */}
      <progress
        aria-label="生成の進捗"
        max={hasValue ? progress.max : undefined}
        value={hasValue ? progress.value : undefined}
      />
      {progress?.node && <p className="muted">実行中のノード: {progress.node}</p>}
      {progress && progress.previewSeq > 0 ? (
        <img
          className="preview"
          src={api.jobPreviewUrl(job.id, progress.previewSeq)}
          alt="生成途中のプレビュー"
        />
      ) : (
        <p className="muted">プレビューはまだありません。</p>
      )}
    </section>
  );
}
