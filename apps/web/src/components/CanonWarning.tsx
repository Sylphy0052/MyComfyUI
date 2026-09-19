import type { CanonStatus, GenerationJob, ReferenceChangeEntry } from "../api/client";

const CHANGE_LABEL: Record<string, string> = {
  unchanged: "一致",
  updated: "更新あり",
  missing: "取得できない",
  added: "追加",
};

/** 参照の種別を画面の語へ直す。API が新しい種別を返しても値をそのまま出す。 */
export const KIND_LABEL: Record<string, string> = {
  scene: "Scene",
  shot: "Shot",
  canon: "Canon",
  cached_input: "入力素材",
};

export function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function shorten(value: unknown, length: number): string {
  const found = asText(value);
  return found ? found.slice(0, length) : "-";
}

/**
 * Canon 更新と再現不能理由を出す。記録済みの Manifest は変更されない。
 * 参照 API を引けないときは比較できなかったことを明示し、一致と混同させない。
 */
export function CanonWarning({
  status,
  job,
}: {
  status: CanonStatus;
  job: GenerationJob;
}) {
  const changed = status.entries.filter((entry) => entry.change !== "unchanged");
  return (
    <div className="stack">
      <div className="row">
        <span className={`badge canon-${status.status}`}>
          {status.status === "unchanged" && "Canon一致"}
          {status.status === "changed" && "Canon更新あり"}
          {status.status === "unavailable" && "Canonを比較できない"}
        </span>
        <span className="muted">
          {status.replayable
            ? "当時の条件で再実行できる"
            : "当時の条件では再実行できない"}
        </span>
      </div>

      {status.reason && <p className="error">{status.reason}</p>}

      {job.state === "failed" && job.failure_message && (
        <p className="error">
          前回の失敗: {job.failure_message}
          <span className="muted"> (code: {job.failure_code ?? "-"})</span>
        </p>
      )}

      {status.blocking.length > 0 && (
        <div>
          <p className="muted">再現できない入力</p>
          <ul className="list plain">
            {status.blocking.map((entry) => (
              <li key={`${entry.kind}-${entry.path}#${entry.anchor ?? ""}`}>
                <ReferenceRow entry={entry} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {changed.length > 0 && (
        <details>
          <summary className="muted">記録時との差分 {changed.length} 件</summary>
          <ul className="list plain">
            {changed.map((entry) => (
              <li
                key={`${entry.change}-${entry.kind}-${entry.path}#${entry.anchor ?? ""}`}
              >
                <ReferenceRow entry={entry} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function ReferenceRow({ entry }: { entry: ReferenceChangeEntry }) {
  return (
    <div className="stack">
      <span className="row">
        <span className={`badge change-${entry.change}`}>
          {CHANGE_LABEL[entry.change] ?? entry.change}
        </span>
        <span className="muted">{KIND_LABEL[entry.kind] ?? entry.kind}</span>
      </span>
      <span className="mono">
        {entry.path ?? "-"}
        {entry.anchor ? ` #${entry.anchor}` : ""}
      </span>
      {/* 参照 API で解決する参照は revision を並べれば足りる。実ファイルを読んで */}
      {/* 判定した入力素材だけ、なぜ再現できないかを文章で出す。 */}
      {entry.reason ? (
        <span className="muted">{entry.reason}</span>
      ) : (
        <span className="muted">
          記録時 {shorten(entry.recorded?.revision, 7)} / 現在{" "}
          {shorten(entry.current?.revision, 7)}
        </span>
      )}
    </div>
  );
}
