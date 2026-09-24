import { useEffect, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  AssignmentTarget,
  ExternalImagePreview,
  MediaRole,
  ProjectCharacterProfile,
} from "../api/client";
import { MediaPicker, mediaTypeOf, toBase64 } from "./MediaPicker";
import type { PickedMedia } from "./MediaPicker";
import { MEDIA_ROLE_LABEL, MEDIA_ROLE_OPTIONS_BY_KIND } from "./mediaRole";

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
  const [characters, setCharacters] = useState<ProjectCharacterProfile[]>([]);
  const [role, setRole] = useState<MediaRole | "">("");
  const [characterIds, setCharacterIds] = useState<string[]>([]);

  useEffect(() => {
    // キャラクターはProject単位。別Projectの選択を持ち越すとAPIが422で弾く。
    setCharacterIds([]);
    if (!assignment.project_id) {
      setCharacters([]);
      return;
    }
    let active = true;
    api
      .getProjectLocalOverrides(assignment.project_id)
      .then((overrides) => {
        if (active) setCharacters(overrides.characters ?? []);
      })
      .catch(() => {
        if (active) setCharacters([]);
      });
    return () => {
      active = false;
    };
  }, [assignment.project_id]);

  const toggleCharacter = (characterId: string) => {
    setCharacterIds((current) =>
      current.includes(characterId)
        ? current.filter((id) => id !== characterId)
        : [...current, characterId],
    );
  };

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
      const result = await api.confirmExternalImageImport({
        preview_token: preview.preview_token,
        file_name: file.name,
        content_base64: contentBase64,
        media_type: mediaTypeOf(file),
        expected_sha256: preview.sha256,
        assignment,
      });
      if (role) {
        try {
          await api.upsertMediaRoleTag({
            artifact_id: result.artifact.id,
            role,
            character_ids: characterIds,
            project_id: assignment.project_id ?? undefined,
            scene_id: assignment.scene_id ?? undefined,
          });
        } catch (cause) {
          // 取込自体は成功済み。この後フォームを空にするため、対象と付け直す手段を文言に残す。
          setError(
            `「${file.name}」は取り込んだが、役割タグを付けられなかった。画像の変更・派生パネルの素材選択で役割を指定して選び直すと付け直せる: ${describe(cause)}`,
          );
        }
      }
      setPicked([]);
      setContentBase64("");
      setPreview(null);
      setRole("");
      setCharacterIds([]);
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
        <div className="row">
          <select
            value={role}
            disabled={busy}
            onChange={(event) => setRole(event.target.value as MediaRole | "")}
          >
            <option value="">役割を指定しない</option>
            {MEDIA_ROLE_OPTIONS_BY_KIND.image.map((item) => (
              <option key={item} value={item}>
                {MEDIA_ROLE_LABEL[item]}
              </option>
            ))}
          </select>
          {characters.length > 0 && (
            <div className="row">
              {characters.map((character) => (
                <label key={character.id} className="row">
                  <input
                    type="checkbox"
                    checked={characterIds.includes(character.id)}
                    disabled={busy}
                    onChange={() => toggleCharacter(character.id)}
                  />
                  {character.name}
                </label>
              ))}
            </div>
          )}
        </div>
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
