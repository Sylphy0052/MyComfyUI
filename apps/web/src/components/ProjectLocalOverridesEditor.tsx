import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { ApiError, api } from "../api/client";
import type {
  ProjectCharacterProfile,
  ProjectLocalOverrides,
  ProjectReferenceImage,
} from "../api/client";
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
  onOpenCharacters,
}: {
  projectId: string;
  sceneId: string | null;
  shotId: string | null;
  /** 「キャラクター」画面へ移らせる案内ボタンのハンドラ。省略時は文言のみ表示する。 */
  onOpenCharacters?: () => void;
}) {
  const [settings, setSettings] = useState<LocalOverrides | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSettings(null);
    setError(null);
    api.getProjectLocalOverrides(projectId)
      .then((loaded) => active && setSettings(normalize(loaded)))
      .catch((cause) => active && setError(describe(cause)));
    return () => {
      active = false;
    };
  }, [projectId]);

  // 全体置換のPUTのため、保存直前に最新を読み直してから変更を当てる。手元の古い
  // キャラクター定義や衣装指定で、他の画面での編集を巻き戻さないようにする。
  const persist = async (update: (latest: ProjectLocalOverrides) => ProjectLocalOverrides) => {
    setBusy(true);
    setError(null);
    try {
      const latest = await api.getProjectLocalOverrides(projectId);
      const saved = await api.updateProjectLocalOverrides(projectId, update(latest));
      setSettings(normalize(saved));
    } catch (cause) {
      setError(describe(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  };

  const savePrompt = async (
    kind: "scene" | "shot",
    resourceId: string,
    prompt: string,
  ) => {
    if (!settings) return;
    const field = kind === "scene" ? "scene_prompts" : "shot_prompts";
    await persist((latest) => {
      const prompts = { ...(latest[field] ?? {}) };
      if (prompt) prompts[resourceId] = prompt;
      else delete prompts[resourceId];
      return { ...latest, [field]: prompts };
    });
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
            <p className="muted">名前・外見・声・衣装・参照画像は「キャラクター」画面で編集します（登録{settings.characters.length}件）。</p>
          </div>
          {onOpenCharacters && <button type="button" onClick={onOpenCharacters}>キャラクター画面を開く</button>}
        </div>
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
