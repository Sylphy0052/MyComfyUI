import { useEffect, useState } from "react";

import { ApiError, api } from "../api/client";
import type { ArtifactIntegrity, ArtifactIntegrityReason } from "../api/client";

const REASON_LABEL: Record<ArtifactIntegrityReason, string> = {
  file_missing: "実ファイル欠損",
  hash_mismatch: "内容不一致",
  reference_broken: "参照切れ",
  canon_updated: "Canon更新",
};

const REASON_ORDER: ArtifactIntegrityReason[] = [
  "file_missing",
  "hash_mismatch",
  "reference_broken",
  "canon_updated",
];

/** 判定対象の範囲。返る件数ではなく、実ファイルを読んで判定する上限である。 */
const CHECK_LIMIT = 100;

interface Props {
  sceneId: string | null;
  shotId: string | null;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return error.requestId
      ? `${error.message} (${error.code} / request_id=${error.requestId})`
      : `${error.message} (${error.code})`;
  }
  return String(error);
}

export function IntegrityList({ sceneId, shotId }: Props) {
  const [result, setResult] = useState<ArtifactIntegrity | null>(null);
  const [reasons, setReasons] = useState<ArtifactIntegrityReason[]>([]);
  const [includeCanon, setIncludeCanon] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 判定結果が無いのが「問題なし」なのか「取得に失敗した」のかを区別する。
  const [failed, setFailed] = useState(false);
  const [token, setToken] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    (async () => {
      try {
        const found = await api.listArtifactIntegrity({
          sceneId: sceneId ?? undefined,
          shotId: shotId ?? undefined,
          reasons: reasons.length > 0 ? reasons : undefined,
          includeCanon,
          limit: CHECK_LIMIT,
        });
        if (!active) return;
        setFailed(false);
        setResult(found);
      } catch (cause) {
        if (!active) return;
        // 失敗した条件の判定結果を残すと、現在の絞込みの結果と見分けが付かない。
        setResult(null);
        setFailed(true);
        setError(describe(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [sceneId, shotId, reasons, includeCanon, token]);

  const toggleReason = (reason: ArtifactIntegrityReason) => {
    setReasons((current) =>
      current.includes(reason)
        ? current.filter((item) => item !== reason)
        : [...current, reason],
    );
  };

  return (
    <section className="panel">
      <h2>整合性を欠いた資産</h2>
      <p className="muted">
        {
          "欠損・参照切れ・Canon更新を理由付きで示す。判定は読み取りのみで記録値を変えない。"
        }
      </p>
      {error && (
        <div className="error">
          <div>{error}</div>
          <button type="button" onClick={() => setError(null)}>
            閉じる
          </button>
        </div>
      )}

      <div className="row">
        {REASON_ORDER.map((reason) => (
          <button
            key={reason}
            type="button"
            aria-pressed={reasons.includes(reason)}
            onClick={() => toggleReason(reason)}
          >
            {REASON_LABEL[reason]}
          </button>
        ))}
        <label className="row">
          <input
            type="checkbox"
            checked={includeCanon}
            onChange={(event) => setIncludeCanon(event.target.checked)}
          />
          Canonの更新も判定する
        </label>
        <button type="button" onClick={() => setToken((n) => n + 1)}>
          再判定
        </button>
      </div>

      {loading && <p className="muted">判定中。</p>}

      {failed && !loading && (
        <p className="muted">
          判定結果を取得できませんでした。再判定してください。
        </p>
      )}

      {result && (
        <div className="stack">
          <p className="muted">
            {result.checked} 件を判定し、{result.items.length}{" "}
            件に問題があった。
            {result.truncated
              ? ` 上限 ${CHECK_LIMIT} 件で打ち切ったため、判定していない対象が残っている。`
              : ""}
          </p>
          {/* 判定した結果として更新が無かったのか、そもそも見ていないのかを */}
          {/* 取り違えさせない。 */}
          {!result.canon_available && (
            <p className="muted">
              Canonを確認できなかったため、Canon更新は判定していない。
              {result.canon_reason ? ` 理由: ${result.canon_reason}` : ""}
            </p>
          )}
          {result.items.length === 0 ? (
            <p className="muted">問題のあるArtifactは見つからなかった。</p>
          ) : (
            <ul className="list plain">
              {result.items.map((entry) => (
                <li key={entry.artifact.id}>
                  <span className="row">
                    <span className="badge">{entry.artifact.kind}</span>
                    {entry.findings.map((finding) => (
                      <span
                        key={`${entry.artifact.id}-${finding.reason}`}
                        className="badge change-missing"
                      >
                        {REASON_LABEL[finding.reason]}
                      </span>
                    ))}
                    <span className="muted">{entry.artifact.created_at}</span>
                  </span>
                  <span className="mono">{entry.artifact.relative_path}</span>
                  {entry.findings.map((finding) => (
                    <span
                      key={`${entry.artifact.id}-${finding.reason}-message`}
                      className="muted"
                    >
                      {finding.message}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
