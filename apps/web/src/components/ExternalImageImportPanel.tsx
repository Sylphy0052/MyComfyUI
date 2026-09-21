import { useState } from "react";

import { ApiError, api } from "../api/client";
import type { AssignmentTarget, ExternalImagePreview } from "../api/client";

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

function mediaTypeOf(file: File): string {
  if (file.type) return file.type;
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

async function toBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** previewとconfirmを分け、埋込メタデータを確認するまで保存しない。 */
export function ExternalImageImportPanel({ assignment, onImported }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [contentBase64, setContentBase64] = useState("");
  const [preview, setPreview] = useState<ExternalImagePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);

  const selectFile = (next: File | null) => {
    setFile(next);
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
      setFile(null);
      setContentBase64("");
      setPreview(null);
      setInputKey((current) => current + 1);
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
        <input
          key={inputKey}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
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
