import type { ApiError } from "../api/client";
import type { GenerationPreview, GenerationPreviewDiff } from "../api/client";
import { KIND_LABEL, shorten } from "./CanonWarning";

/** 値の出所を画面の語へ直す。API が新しい値を返しても値をそのまま出す。 */
const ORIGIN_LABEL: Record<string, string> = {
  runtime: "今回の入力",
  look_profile: "ルックプロファイル",
  shot: "Shot設定",
  scene: "Scene設定",
  project: "Project既定値",
  recipe_default: "プリセット既定",
  workflow_default: "Workflow既定",
  adapter: "自動",
};

/** 解決済みの値を 1 行で見せる。オブジェクトと配列は JSON のまま出す。 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * 投入前の確認。解決済みの入力と、Workflow 既定値からの差分を出す。
 *
 * ここで出す内容は投入時と同じ経路で組み立てたものだが、Job も Manifest も
 * Artifact も作らない。自動採番の seed だけは投入時に採り直されるため、値が
 * 変わることを明示する。
 */
export function ExecutionPreview({
  preview,
  error,
  loading,
}: {
  preview: GenerationPreview | null;
  error: ApiError | null;
  loading: boolean;
}) {
  if (loading) {
    return <p className="muted">確認中...</p>;
  }
  if (error) {
    return <PreviewError error={error} />;
  }
  if (!preview) {
    return null;
  }
  const changed = preview.diff.filter((entry) => entry.changed);
  return (
    <div className="stack">
      <div className="row">
        <span className="badge">{preview.engine}</span>
        <span className="muted">
          Recipe: {shorten(preview.recipe_id, 12)}（
          {ORIGIN_LABEL[preview.recipe_origin] ?? preview.recipe_origin}）
        </span>
        <span className="muted">
          {preview.workflow_name ?? "Workflow未登録"}
          {preview.version ? ` / ${shorten(preview.version, 12)}` : ""}
        </span>
      </div>

      {/* 入力を変えてもこの内容は取り直さない。投入する値と読み比べられるよう、 */}
      {/* いつ時点のものかを明示する。 */}
      <p className="muted">
        確認を押した時点の入力による内容です。入力を変えたら確認し直してください。
      </p>

      <div>
        <p className="muted">解決済みプロンプト</p>
        <p className="mono">{preview.resolved_prompt || "-"}</p>
      </div>

      <div className="row">
        <span className="muted">seed</span>
        <span className="mono">{preview.seed}</span>
        {preview.seed_auto && (
          <span className="muted">
            自動採番のため、投入時は別の値になります
          </span>
        )}
      </div>

      <div>
        <p className="muted">モデル</p>
        <ul className="list plain">
          {Object.entries(preview.model).map(([name, value]) => (
            <li key={name} className="mono">
              {name}: {formatValue(value)}
            </li>
          ))}
        </ul>
      </div>

      {preview.look_profile_ids.length > 0 && (
        <div>
          <p className="muted">適用LookProfile（上から順にoverlay）</p>
          <ol className="list plain">
            {preview.look_profile_ids.map((id) => <li key={id} className="mono">{id}</li>)}
          </ol>
        </div>
      )}

      <div>
        <p className="muted">
          Workflow既定値からの変更 {changed.length} 件 / 全 {preview.diff.length}{" "}
          件
        </p>
        <ul className="list plain">
          {preview.diff.map((entry) => (
            <li key={entry.name}>
              <DiffRow entry={entry} />
            </li>
          ))}
        </ul>
      </div>

      <details>
        <summary className="muted">
          実行パラメータ {Object.keys(preview.parameters).length} 件
        </summary>
        <ul className="list plain">
          {Object.entries(preview.parameters).map(([name, value]) => (
            <li key={name} className="mono">
              {name}: {formatValue(value)}
            </li>
          ))}
        </ul>
      </details>

      <details>
        <summary className="muted">入力素材 {preview.input_refs.length} 件</summary>
        <ul className="list plain">
          {preview.input_refs.map((ref, index) => {
            const kind = typeof ref.kind === "string" ? ref.kind : "";
            const path = ref.path ?? ref.relative_path;
            return (
              <li key={`${kind}-${String(path)}-${index}`}>
                <span className="muted">{KIND_LABEL[kind] ?? kind}</span>{" "}
                <span className="mono">{formatValue(path)}</span>
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}

function DiffRow({ entry }: { entry: GenerationPreviewDiff }) {
  return (
    <div className="row">
      <span className={`badge change-${entry.changed ? "updated" : "unchanged"}`}>
        {entry.changed ? "変更" : "既定のまま"}
      </span>
      <span className="mono">{entry.name}</span>
      <span className="muted">
        {formatValue(entry.workflow_default)} → {formatValue(entry.value)}
      </span>
      <span className="muted">{ORIGIN_LABEL[entry.origin] ?? entry.origin}</span>
    </div>
  );
}

/**
 * 解決できなかった理由を出す。Job は作られていない。不足項目は Envelope の
 * `details` にそのまま入るため、項目名と値を並べる。
 */
function PreviewError({ error }: { error: ApiError }) {
  const details =
    error.details && typeof error.details === "object"
      ? (error.details as Record<string, unknown>)
      : null;
  return (
    <div className="stack">
      <p className="error">{error.message}</p>
      <p className="muted">この内容では投入できません。Jobは作られていません。</p>
      {details && (
        <ul className="list plain">
          {Object.entries(details).map(([name, value]) => (
            <li key={name} className="mono">
              {name}: {formatValue(value)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
