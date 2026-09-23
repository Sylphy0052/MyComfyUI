import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { ApiError, api } from "../api/client";
import type {
  ProjectCharacterProfile,
  ProjectLocalOverrides,
  ProjectReferenceImage,
} from "../api/client";
import { MediaPicker } from "./MediaPicker";
import type { PickedMedia } from "./MediaPicker";
import { EmptyState } from "./ui/EmptyState";

/** Sceneのstructure-panelへ移り、フォーカスして選ばせる。 */
function focusSceneSection(): void {
  const target = document.getElementById("scene-browser-scene-section");
  target?.scrollIntoView({ block: "nearest" });
  target?.focus();
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}(${error.code})`;
  return String(error);
}

interface CharacterDraft {
  id: string;
  name: string;
  tags: string;
  reference_images: ProjectReferenceImage[];
}

type CharacterProfile = ProjectCharacterProfile & {
  tags: string[];
  reference_images: ProjectReferenceImage[];
};

type LocalOverrides = ProjectLocalOverrides & {
  characters: CharacterProfile[];
  scene_prompts: Record<string, string>;
  shot_prompts: Record<string, string>;
};

function normalize(settings: ProjectLocalOverrides): LocalOverrides {
  return {
    characters: (settings.characters ?? []).map((profile) => ({
      ...profile,
      tags: profile.tags ?? [],
      reference_images: profile.reference_images ?? [],
    })),
    scene_prompts: settings.scene_prompts ?? {},
    shot_prompts: settings.shot_prompts ?? {},
  };
}

function toDraft(profile?: CharacterProfile): CharacterDraft {
  return profile
    ? { ...profile, tags: profile.tags.join(", ") }
    : { id: crypto.randomUUID(), name: "", tags: "", reference_images: [] };
}

function PromptField({
  label,
  value,
  busy,
  onSave,
}: {
  label: string;
  value: string;
  busy: boolean;
  onSave: (value: string) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState(value);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await onSave(prompt.trim());
    } catch (cause) {
      setError(describe(cause));
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <label>
        {label}
        <textarea
          rows={5}
          maxLength={10000}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "保存中..." : "保存"}
        </button>
      </div>
    </form>
  );
}

export function ProjectLocalOverridesEditor({
  projectId,
  sceneId,
  shotId,
}: {
  projectId: string;
  sceneId: string | null;
  shotId: string | null;
}) {
  const [settings, setSettings] = useState<LocalOverrides | null>(null);
  const [draft, setDraft] = useState<CharacterDraft | null>(null);
  const [pickedReference, setPickedReference] = useState<PickedMedia[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSettings(null);
    setDraft(null);
    setError(null);
    api.getProjectLocalOverrides(projectId)
      .then((loaded) => active && setSettings(normalize(loaded)))
      .catch((cause) => active && setError(describe(cause)));
    return () => {
      active = false;
    };
  }, [projectId]);

  const persist = async (next: LocalOverrides) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.updateProjectLocalOverrides(projectId, next);
      setSettings(normalize(saved));
    } catch (cause) {
      setError(describe(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  };

  const handleReferencePicked = (next: PickedMedia[]) => {
    const item = next[0];
    setPickedReference([]);
    if (!item) return;
    setError(null);
    if (item.artifact) {
      const artifact = item.artifact;
      const fileName = artifact.relative_path.split("/").pop() ?? item.label;
      setDraft((current) => current && ({
        ...current,
        reference_images: [
          ...current.reference_images,
          {
            file_name: fileName,
            relative_path: artifact.relative_path,
            sha256: artifact.sha256,
            byte_size: artifact.byte_size,
            media_type: artifact.media_type,
          },
        ],
      }));
      return;
    }
    const source = item.source;
    if ("relative_path" in source && source.relative_path) {
      setDraft((current) => current && ({
        ...current,
        reference_images: [
          ...current.reference_images,
          {
            file_name: item.label,
            relative_path: source.relative_path,
            sha256: source.sha256,
            byte_size: item.file?.size ?? 0,
            media_type: item.mediaType ?? "application/octet-stream",
          },
        ],
      }));
    }
  };

  const saveCharacter = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings || !draft) return;
    const tags = [...new Set(
      draft.tags.split(",").map((value) => value.trim()).filter(Boolean),
    )];
    const profile: CharacterProfile = {
      id: draft.id,
      name: draft.name.trim(),
      tags,
      reference_images: draft.reference_images,
    };
    const exists = settings.characters.some((item) => item.id === profile.id);
    try {
      await persist({
        ...settings,
        characters: exists
          ? settings.characters.map((item) => item.id === profile.id ? profile : item)
          : [...settings.characters, profile],
      });
      setDraft(null);
    } catch {
      // persistが画面へAPIエラーを表示する。
    }
  };

  const removeCharacter = async (profile: CharacterProfile) => {
    if (!settings || !window.confirm(`${profile.name}の登録を削除しますか？`)) return;
    try {
      await persist({
        ...settings,
        characters: settings.characters.filter((item) => item.id !== profile.id),
      });
    } catch {
      // persistが画面へAPIエラーを表示する。
    }
  };

  const savePrompt = async (
    kind: "scene" | "shot",
    resourceId: string,
    prompt: string,
  ) => {
    if (!settings) return;
    const field = kind === "scene" ? "scene_prompts" : "shot_prompts";
    const prompts = { ...settings[field] };
    if (prompt) prompts[resourceId] = prompt;
    else delete prompts[resourceId];
    await persist({ ...settings, [field]: prompts });
  };

  if (!settings) {
    return <section className="panel"><p className={error ? "error" : "muted"}>{error ?? "ローカル設定を読込み中..."}</p></section>;
  }

  return (
    <>
      <section className="panel stack">
        <div className="row spread">
          <div>
            <h2>人物・キャラクター</h2>
            <p className="muted">タグと参照画像をProject固有の設定として保存します。</p>
          </div>
          <button type="button" disabled={busy} onClick={() => setDraft(toDraft())}>追加</button>
        </div>
        {settings.characters.length === 0 && <p className="muted">登録はありません。</p>}
        <ul className="list structure-list">
          {settings.characters.map((profile) => (
            <li key={profile.id}>
              <div>
                <strong>{profile.name}</strong>
                <p className="muted">{profile.tags.join(", ") || "タグなし"} / 参照画像{profile.reference_images.length}件</p>
              </div>
              <div className="row structure-actions">
                <button type="button" disabled={busy} onClick={() => setDraft(toDraft(profile))}>編集</button>
                <button type="button" className="danger-button" disabled={busy} onClick={() => void removeCharacter(profile)}>削除</button>
              </div>
            </li>
          ))}
        </ul>
        {draft && (
          <form className="stack" onSubmit={saveCharacter}>
            <h3>{settings.characters.some((item) => item.id === draft.id) ? "人物・キャラクターを編集" : "人物・キャラクターを追加"}</h3>
            <label>名前<input required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>タグ（カンマ区切り）<input value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></label>
            <MediaPicker
              kind="image"
              label="参照画像"
              value={pickedReference}
              onChange={handleReferencePicked}
              multiple={false}
              disabled={busy || draft.reference_images.length >= 20}
              maxBytes={25 * 1024 * 1024}
              projectId={projectId}
            />
            <ul className="list">
              {draft.reference_images.map((image) => (
                <li key={image.relative_path} className="row spread">
                  <span>{image.file_name}<span className="muted"> ({image.byte_size} bytes)</span></span>
                  <button type="button" disabled={busy} onClick={() => setDraft({ ...draft, reference_images: draft.reference_images.filter((item) => item.relative_path !== image.relative_path) })}>登録から外す</button>
                </li>
              ))}
            </ul>
            <div className="row">
              <button type="button" disabled={busy} onClick={() => setDraft(null)}>キャンセル</button>
              <button type="submit" className="primary" disabled={busy}>{busy ? "保存中..." : "保存"}</button>
            </div>
          </form>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel stack">
        <h2>生成プロンプト</h2>
        <p className="muted">外部原文とは別に保存し、画像・動画生成時はShot、Sceneの順で優先します。</p>
        {!sceneId && (
          <EmptyState
            title="Sceneを選択してください。"
            description="生成プロンプトはSceneごとに保存します。"
            action={
              <button type="button" onClick={focusSceneSection}>
                Sceneを選ぶ
              </button>
            }
          />
        )}
        {sceneId && (
          <PromptField
            key={`scene-${sceneId}-${settings.scene_prompts[sceneId] ?? ""}`}
            label="Sceneプロンプト"
            value={settings.scene_prompts[sceneId] ?? ""}
            busy={busy}
            onSave={(prompt) => savePrompt("scene", sceneId, prompt)}
          />
        )}
        {shotId && (
          <PromptField
            key={`shot-${shotId}-${settings.shot_prompts[shotId] ?? ""}`}
            label="Shotプロンプト"
            value={settings.shot_prompts[shotId] ?? ""}
            busy={busy}
            onSave={(prompt) => savePrompt("shot", shotId, prompt)}
          />
        )}
      </section>
    </>
  );
}
