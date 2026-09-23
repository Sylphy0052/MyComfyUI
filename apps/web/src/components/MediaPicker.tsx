import { useEffect, useState } from "react";
import type { DragEvent } from "react";

import { ApiError, api } from "../api/client";
import type { Artifact, MediaRole, ProjectCharacterProfile } from "../api/client";
import { hasArtifactDrag, hasFileDrag, readArtifactDrag } from "./artifactDrag";
import type { ArtifactDragPayload } from "./artifactDrag";

/**
 * Job入力として渡す画像・音声の指定。既存Artifactを指すか、アップロード直後に
 * 入力cacheへ登録した実体を指すかのどちらか。API側 (`sources.py`) の union と対応する。
 */
export type PickedSource =
  | { artifact_id: string }
  | { relative_path: string; sha256: string };

/** 1件選んだ画像・音声。表示用の情報と、必要ならFile実体まで保持する。 */
export interface PickedMedia {
  key: string;
  label: string;
  source: PickedSource;
  mediaType?: string;
  /** 生成物・登録素材タブから選んだときの元Artifact。file_name等の付随情報が要る画面で使う。 */
  artifact?: Artifact;
  /** アップロードタブで選んだときのFile実体。タグ抽出など生バイトが要る画面で使う。 */
  file?: File;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** FileをBase64へ変換する。data URLの接頭辞は含めない。 */
export async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** BlobをBase64へ変換する。Artifactの内容をfetchしたあとの変換に使う。 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("データを読み込めませんでした。"));
    reader.onabort = () => reject(new Error("読み込みが中断されました。"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Base64へ変換できませんでした。"));
        return;
      }
      const separator = result.indexOf(",");
      resolve(separator < 0 ? result : result.slice(separator + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** Fileのmedia_typeを決める。typeが空の画像は拡張子から推測する。 */
export function mediaTypeOf(file: File, kind: "image" | "audio" = "image"): string {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (kind === "audio") {
    if (name.endsWith(".wav")) return "audio/wav";
    if (name.endsWith(".m4a")) return "audio/mp4";
    return "audio/mpeg";
  }
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  return "image/png";
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

type SourceTab = "generated" | "registered" | "upload";

const TAB_LABEL: Record<SourceTab, string> = {
  generated: "生成物",
  registered: "登録素材",
  upload: "アップロード",
};

const ROLE_LABEL: Record<MediaRole, string> = {
  appearance_reference: "外見参照",
  pose: "ポーズ",
  background: "背景",
  costume: "衣装",
  other: "その他",
};
const ROLE_OPTIONS = Object.keys(ROLE_LABEL) as MediaRole[];

export interface MediaPickerProps {
  kind: "image" | "audio";
  label: string;
  value: PickedMedia[];
  onChange: (next: PickedMedia[]) => void;
  /** 複数選択を許す。省略時は1件のみ (新しい選択は既存の1件を置き換える)。 */
  multiple?: boolean;
  /** 選択できる最大件数。件数表示にも使う。 */
  max?: number;
  /** 選択が必要な最小件数。件数表示にのみ使い、送信可否の判定は呼び出し側が行う。 */
  min?: number;
  disabled?: boolean;
  /** アップロードで許すバイト数の上限。既定25MB。 */
  maxBytes?: number;
  accept?: string;
  projectId?: string | null;
  sceneId?: string | null;
  shotId?: string | null;
  /** 出すタブ。既定は3種すべて。外部取込のように片方しか要らない画面は絞る。 */
  sources?: SourceTab[];
  /** アップロード直後に入力cacheへ登録するか。falseなら選んだFileをそのまま返すだけにする。 */
  autoRegister?: boolean;
  /**
   * 取込時に役割・キャラクターを指定できるようにする (Issue #148)。既定はfalse
   * (既存呼び出し元の見た目・挙動を変えない)。有効時、選択済みの役割があれば
   * 選択・アップロードのたびに `/media-role-tags` へ後付けで登録する。
   */
  enableRoleTagging?: boolean;
}

export function MediaPicker({
  kind,
  label,
  value,
  onChange,
  multiple = false,
  max,
  min,
  disabled = false,
  maxBytes = DEFAULT_MAX_BYTES,
  accept,
  projectId = null,
  sceneId = null,
  shotId = null,
  sources = ["generated", "registered", "upload"],
  autoRegister = true,
  enableRoleTagging = false,
}: MediaPickerProps) {
  const [tab, setTab] = useState<SourceTab>(sources[0] ?? "upload");
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [pickedArtifactId, setPickedArtifactId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [characters, setCharacters] = useState<ProjectCharacterProfile[]>([]);
  const [role, setRole] = useState<MediaRole | "">("");
  const [characterIds, setCharacterIds] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const needsArtifacts = sources.includes("generated") || sources.includes("registered");

  useEffect(() => {
    if (!enableRoleTagging || !projectId) {
      setCharacters([]);
      return;
    }
    let active = true;
    api
      .getProjectLocalOverrides(projectId)
      .then((overrides) => {
        if (active) setCharacters(overrides.characters ?? []);
      })
      .catch(() => {
        // キャラクター一覧を取れなくても役割タグ付け以外は継続する。
        if (active) setCharacters([]);
      });
    return () => {
      active = false;
    };
  }, [enableRoleTagging, projectId]);

  const tagRoleFor = (target: { artifact_id: string } | {
    relative_path: string;
    sha256: string;
    file_name: string;
    byte_size: number;
    media_type: string;
  }) => {
    if (!enableRoleTagging || !role) return;
    api
      .upsertMediaRoleTag({
        ...target,
        role,
        character_ids: characterIds,
        project_id: projectId ?? undefined,
        scene_id: sceneId ?? undefined,
      })
      .catch((cause) => {
        setError(describe(cause));
      });
  };

  const toggleCharacter = (characterId: string) => {
    setCharacterIds((current) =>
      current.includes(characterId)
        ? current.filter((id) => id !== characterId)
        : [...current, characterId],
    );
  };

  useEffect(() => {
    if (!needsArtifacts) return;
    let active = true;
    api
      .listArtifacts({
        projectId: projectId ?? undefined,
        sceneId: sceneId ?? undefined,
        shotId: shotId ?? undefined,
        unassigned: !projectId,
        kind,
        availability: "complete",
        limit: 100,
      })
      .then((items) => {
        if (active) setArtifacts(items);
      })
      .catch((cause) => {
        if (active) setError(describe(cause));
      });
    return () => {
      active = false;
    };
  }, [needsArtifacts, projectId, sceneId, shotId, kind]);

  const atMax = typeof max === "number" && value.length >= max;
  const filteredArtifacts = artifacts.filter((item) =>
    tab === "generated" ? Boolean(item.job_id) : tab === "registered" ? !item.job_id : false,
  );

  const appendOrReplace = (item: PickedMedia) => {
    onChange(multiple ? [...value, item] : [item]);
  };

  const pickArtifact = (artifactId: string) => {
    if (!artifactId) return;
    if (atMax) {
      setError(`選べるのは${max}件までです。`);
      return;
    }
    const artifact = filteredArtifacts.find((item) => item.id === artifactId);
    if (!artifact) {
      setError("選択した素材が見つかりません。一覧を確認して選び直してください。");
      return;
    }
    addArtifact(artifact);
    setPickedArtifactId("");
  };

  const addArtifact = (artifact: Artifact) => {
    setError(null);
    appendOrReplace({
      key: crypto.randomUUID(),
      label: `${artifact.id.slice(0, 8)} / ${artifact.created_at}`,
      source: { artifact_id: artifact.id },
      mediaType: artifact.media_type,
      artifact,
    });
    tagRoleFor({ artifact_id: artifact.id });
  };

  /** 一覧からドロップされた生成物を割り当てる。一覧に無ければAPIから取り直す。 */
  const assignDroppedArtifact = async (payload: ArtifactDragPayload) => {
    if (atMax) {
      setError(`選べるのは${max}件までです。`);
      return;
    }
    if (!payload.media_type.startsWith(`${kind}/`)) {
      setError(kind === "image" ? "画像の素材をドロップしてください。" : "音声の素材をドロップしてください。");
      return;
    }
    let artifact = artifacts.find((item) => item.id === payload.id);
    if (!artifact) {
      setBusy(true);
      try {
        artifact = await api.getArtifact(payload.id);
      } catch (cause) {
        setError(describe(cause));
        return;
      } finally {
        setBusy(false);
      }
    }
    if (artifact.availability !== "complete") {
      setError("実ファイルが無い素材は選べません。");
      return;
    }
    addArtifact(artifact);
  };

  /** 1件を検証し、必要なら入力cacheへ登録する。失敗時はエラーを出してnullを返す。 */
  const prepareUpload = async (file: File): Promise<PickedMedia | null> => {
    if (file.size > maxBytes) {
      setError(`ファイルは${Math.floor(maxBytes / (1024 * 1024))}MB以下にしてください。`);
      return null;
    }
    // typeが取得できないブラウザ環境もあるため、判別できた場合のみ弾く。
    if (kind === "image" && file.type && !file.type.startsWith("image/")) {
      setError("画像ファイルを選択してください。");
      return null;
    }
    if (kind === "audio" && file.type && !file.type.startsWith("audio/")) {
      setError("音声ファイルを選択してください。");
      return null;
    }
    const resolvedMediaType = mediaTypeOf(file, kind);
    if (!autoRegister) {
      return {
        key: crypto.randomUUID(),
        label: file.name,
        // 未登録のため実際には使わない。呼び出し側はfileを直接扱う契約。
        source: { relative_path: "", sha256: "" },
        mediaType: resolvedMediaType,
        file,
      };
    }
    try {
      const stored = await api.createImageReference(file.name, await toBase64(file), resolvedMediaType);
      tagRoleFor({
        relative_path: stored.relative_path,
        sha256: stored.sha256,
        file_name: file.name,
        byte_size: stored.byte_size,
        media_type: stored.media_type,
      });
      return {
        key: crypto.randomUUID(),
        label: file.name,
        source: { relative_path: stored.relative_path, sha256: stored.sha256 },
        mediaType: resolvedMediaType,
        file,
      };
    } catch (cause) {
      setError(describe(cause));
      return null;
    }
  };

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const room = typeof max === "number" ? max - value.length : Number.POSITIVE_INFINITY;
    if (room <= 0) {
      setError(`選べるのは${max}件までです。`);
      return;
    }
    const targets = multiple ? files.slice(0, room) : files.slice(0, 1);
    setError(null);
    setBusy(true);
    const picked: PickedMedia[] = [];
    try {
      for (const file of targets) {
        const item = await prepareUpload(file);
        if (item) picked.push(item);
      }
    } finally {
      setBusy(false);
    }
    if (picked.length > 0) onChange(multiple ? [...value, ...picked] : picked);
    if (files.length > targets.length) {
      setError(
        multiple
          ? `選べるのは${max}件までのため、${files.length - targets.length}件は取り込んでいません。`
          : "1件だけ選べます。最初の1件を取り込みました。",
      );
    }
  };

  const acceptsFiles = sources.includes("upload");
  // ドラッグ元は画像の一覧だけのため、生成物のドロップは画像のピッカーだけで受ける。
  const acceptsArtifacts = needsArtifacts && kind === "image";
  const canDrop = (dataTransfer: DataTransfer) =>
    !disabled &&
    !busy &&
    ((acceptsFiles && hasFileDrag(dataTransfer)) ||
      (acceptsArtifacts && hasArtifactDrag(dataTransfer)));

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!canDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    // 子要素へ移っただけのときは強調を消さない。
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragOver(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragOver(false);
    if (!canDrop(event.dataTransfer)) return;
    event.preventDefault();
    const payload = acceptsArtifacts ? readArtifactDrag(event.dataTransfer) : null;
    if (payload) {
      void assignDroppedArtifact(payload);
      return;
    }
    if (acceptsFiles) void uploadFiles(Array.from(event.dataTransfer.files));
  };

  const dropHint = [
    acceptsFiles ? `${kind === "image" ? "画像" : "音声"}ファイル` : null,
    acceptsArtifacts ? "一覧の画像" : null,
  ]
    .filter(Boolean)
    .join("や");

  const remove = (key: string) => {
    onChange(value.filter((item) => item.key !== key));
  };

  const counter =
    typeof max === "number"
      ? `${value.length}/${max}`
      : typeof min === "number"
        ? `${value.length}/${min}以上`
        : null;

  return (
    <div
      className={`media-picker stack drop-zone${dragOver ? " is-drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="row spread">
        <span className="muted">{label}</span>
        {counter && <span className="muted">{counter}</span>}
      </div>
      {dropHint && !disabled && (
        <span className="muted drop-hint">{`${dropHint}をここへドロップできます`}</span>
      )}
      {sources.length > 1 && (
        <div className="row media-picker-tabs">
          {sources.map((item) => (
            <button
              key={item}
              type="button"
              className={tab === item ? "primary" : undefined}
              disabled={disabled}
              onClick={() => setTab(item)}
            >
              {TAB_LABEL[item]}
            </button>
          ))}
        </div>
      )}
      {(tab === "generated" || tab === "registered") && (
        <div className="row">
          <select
            value={pickedArtifactId}
            disabled={disabled || atMax}
            onChange={(event) => setPickedArtifactId(event.target.value)}
          >
            <option value="">選択してください</option>
            {filteredArtifacts.map((item) => (
              <option key={item.id} value={item.id}>
                {`${item.id.slice(0, 8)} / ${item.created_at}`}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={disabled || atMax || !pickedArtifactId}
            onClick={() => pickArtifact(pickedArtifactId)}
          >
            {multiple ? "追加" : "この素材にする"}
          </button>
        </div>
      )}
      {tab === "upload" && (
        <input
          type="file"
          accept={accept ?? (kind === "audio" ? "audio/*" : "image/*")}
          disabled={disabled || busy || atMax}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void uploadFiles([file]);
          }}
        />
      )}
      {enableRoleTagging && (
        <div className="row media-picker-role-tagging">
          <select
            value={role}
            disabled={disabled}
            onChange={(event) => setRole(event.target.value as MediaRole | "")}
          >
            <option value="">役割を指定しない</option>
            {ROLE_OPTIONS.map((item) => (
              <option key={item} value={item}>
                {ROLE_LABEL[item]}
              </option>
            ))}
          </select>
          {characters.length > 0 && (
            <div className="row media-picker-characters">
              {characters.map((character) => (
                <label key={character.id} className="row">
                  <input
                    type="checkbox"
                    checked={characterIds.includes(character.id)}
                    disabled={disabled}
                    onChange={() => toggleCharacter(character.id)}
                  />
                  {character.name}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {value.length > 0 && (
        <ul className="list plain">
          {value.map((item, index) => (
            <li key={item.key} className="row spread">
              <span>{multiple ? `${index + 1}. ${item.label}` : item.label}</span>
              <button type="button" disabled={disabled} onClick={() => remove(item.key)}>
                削除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
