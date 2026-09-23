import { useState } from "react";

import { ApiError, api } from "../api/client";
import type { AssignmentTarget, ExternalImagePreview } from "../api/client";
import { MediaPicker, mediaTypeOf, toBase64 } from "./MediaPicker";
import type { PickedMedia } from "./MediaPicker";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

interface Props {
  assignment: AssignmentTarget;
  onImported: () => Promise<void>;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message} (${error.code})`;
  }
  return String(error);
}

/** previewとconfirmを分け、埋込メタデータを確認するまで保存しない。 */
export function ExternalImageImportPanel({ assignment, onImported }: Props) {
  const [picked, setPicked] = useState<PickedMedia[]>([]);
  const file = picked[0]?.file ?? null;
  const [contentBase64, setContentBase64] = useState("");
  const [preview, setPreview] = useState<ExternalImagePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectFile = (next: PickedMedia[]) => {
    setPicked(next);
    setContentBase64("");
    setPreview(null);
    setError(null);
  };

  const runPreview = async () => {
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setError("画像は25MB以下にしてください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const encoded = await toBase64(file);
      const result = await api.previewExternalImageImport({
        file_name: file.name,
        content_base64: encoded,
        media_type: mediaTypeOf(file),
      });
      setContentBase64(encoded);
      setPreview(result);
    } catch (cause) {
      setPreview(null);
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!file || !preview || !contentBase64) return;
    setBusy(true);
    setError(null);
    try {
      await api.confirmExternalImageImport({
        preview_token: preview.preview_token,
        file_name: file.name,
        content_base64: contentBase64,
        media_type: mediaTypeOf(file),
        expected_sha256: preview.sha256,
        assignment,
      });
      setPicked([]);
      setContentBase64("");
      setPreview(null);
      await onImported();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details>
      <summary>外部画像を取り込む</summary>
      <div className="stack">
        <MediaPicker
          kind="image"
          label="外部画像ファイル"
          value={picked}
          onChange={selectFile}
          multiple={false}
          sources={["upload"]}
          autoRegister={false}
          disabled={busy}
          maxBytes={MAX_IMAGE_BYTES}
          accept="image/png,image/jpeg,image/webp"
        />
        <button type="button" disabled={!file || busy} onClick={runPreview}>
          {busy && !preview ? "確認中..." : "メタデータを確認"}
        </button>
        {error && <p className="error">{error}</p>}
        {preview && (
          <div className="stack">
            <p>
              {preview.source_format.toUpperCase()} / {preview.width}×
              {preview.height}px / {Math.ceil(preview.byte_size / 1024)}KB
            </p>
            <p className="mono">SHA-256:{preview.sha256}</p>
            {preview.warnings.map((warning) => (
              <p key={warning} className="error">
                {warning}
              </p>
            ))}
            <details>
              <summary>抽出メタデータ</summary>
              <pre>{JSON.stringify(preview.metadata, null, 2)}</pre>
            </details>
            <details open>
              <summary>Recipe下書き（実行不可）</summary>
              <pre>{JSON.stringify(preview.recipe_draft, null, 2)}</pre>
            </details>
            <button type="button" className="primary" disabled={busy} onClick={confirm}>
              {busy ? "取り込み中..." : "確認してArtifactへ取り込む"}
            </button>
          </div>
        )}
      </div>
    </details>
  );
}
