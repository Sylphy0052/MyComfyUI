import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { ApiError, api } from "../api/client";
import type {
  ProjectCharacterOutfit,
  ProjectCharacterProfile,
  ProjectLocalOverrides,
  ProjectReferenceImage,
} from "../api/client";
import type { SceneEnvelope, SceneSummary } from "../api/aimedia";
import { MediaPicker } from "./MediaPicker";
import type { PickedMedia } from "./MediaPicker";
import { Button } from "./ui/Button";
import { EmptyState } from "./ui/EmptyState";

type SceneOutfitMap = NonNullable<ProjectLocalOverrides["scene_outfits"]>;

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}(${error.code})`;
  if (error instanceof Error) return error.message;
  return String(error);
}

interface CharacterDraft {
  id: string;
  name: string;
  tags: string;
  appearance: string;
  voice: string;
  reference_images: ProjectReferenceImage[];
  outfits: ProjectCharacterOutfit[];
  default_outfit_id: string;
  /** フォームを開いた時点のupdated_at。保存直前の最新値と違えば他で更新されたとみなす。 */
  base_updated_at: string | null;
  /** 既存キャラクターの編集か。新規追加では保存時の競合判定をしない。 */
  existing: boolean;
}

function toDraft(profile?: ProjectCharacterProfile): CharacterDraft {
  return profile
    ? {
        id: profile.id,
        name: profile.name,
        tags: (profile.tags ?? []).join(", "),
        appearance: profile.appearance ?? "",
        voice: profile.voice ?? "",
        reference_images: profile.reference_images ?? [],
        outfits: profile.outfits ?? [],
        default_outfit_id: profile.default_outfit_id ?? "",
        base_updated_at: profile.updated_at ?? null,
        existing: true,
      }
    : {
        id: crypto.randomUUID(),
        name: "",
        tags: "",
        appearance: "",
        voice: "",
        reference_images: [],
        outfits: [],
        default_outfit_id: "",
        base_updated_at: null,
        existing: false,
      };
}

/**
 * scene_outfitsから、指定キャラクターの衣装指定のうち`validOutfitIds`に無いものを落とす。
 * 衣装の削除後やキャラクターの削除時 (空集合を渡す) に、参照切れ (422) を保存前に防ぐ。
 */
function pruneSceneOutfits(
  sceneOutfits: SceneOutfitMap | undefined,
  characterId: string,
  validOutfitIds: ReadonlySet<string>,
): SceneOutfitMap {
  const next: SceneOutfitMap = {};
  for (const [sceneId, forScene] of Object.entries(sceneOutfits ?? {})) {
    const rest = Object.fromEntries(
      Object.entries(forScene).filter(
        ([id, outfitId]) => id !== characterId || validOutfitIds.has(outfitId),
      ),
    );
    if (Object.keys(rest).length > 0) next[sceneId] = rest;
  }
  return next;
}

interface MediaImpact {
  total: number;
  /** null = updated_atが無く判定できない。 */
  before: number | null;
  unknownTime: number;
}

interface Props {
  projectId: string | null;
  /** この画面が表示中かどうか。非表示中は場面本文・生成物件数を取り直さない。 */
  active: boolean;
  /** 選択中Projectの場面一覧 (要約)。登場場面の判定に本文を別途取得して使う。 */
  scenes: SceneSummary[];
  /** キャラクター定義・scene_outfitsを保存したら呼ぶ。他画面 (制作計画等) の再取得を促す。 */
  onChanged: () => void;
}

export function CharacterManager({ projectId, active, scenes, onChanged }: Props) {
  const [overrides, setOverrides] = useState<ProjectLocalOverrides | null>(null);
  const [draft, setDraft] = useState<CharacterDraft | null>(null);
  const [pickedReference, setPickedReference] = useState<PickedMedia[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sceneData, setSceneData] = useState<Record<string, SceneEnvelope>>({});
  const [mediaImpact, setMediaImpact] = useState<MediaImpact | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOverrides(null);
    setDraft(null);
    setSelectedId(null);
    setError(null);
  }, [projectId]);

  useEffect(() => {
    if (!active || !projectId || overrides) return;
    let alive = true;
    api
      .getProjectLocalOverrides(projectId)
      .then((loaded) => alive && setOverrides(loaded))
      .catch((cause) => alive && setError(describe(cause)));
    return () => {
      alive = false;
    };
  }, [active, projectId, overrides]);

  // 登場場面の判定にScene本文 (characters) が要る。要約一覧には無いため別途取る。
  useEffect(() => {
    if (!active || !projectId || scenes.length === 0) {
      setSceneData({});
      return;
    }
    let alive = true;
    Promise.all(
      scenes.map((item) =>
        api
          .getScene(projectId, item.id)
          .then((envelope): [string, SceneEnvelope] => [item.id, envelope])
          .catch(() => null),
      ),
    ).then((results) => {
      if (!alive) return;
      const map: Record<string, SceneEnvelope> = {};
      for (const entry of results) {
        if (entry) map[entry[0]] = entry[1];
      }
      setSceneData(map);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, projectId, scenes]);

  const characters = overrides?.characters ?? [];
  const selectedCharacter = characters.find((item) => item.id === selectedId) ?? null;

  const scenesFeaturing = useMemo(() => {
    if (!selectedCharacter) return [];
    return scenes.filter((scene) => {
      const data = sceneData[scene.id];
      if (!data) return false;
      return (data.data.characters ?? []).some(
        (item) =>
          item.id === selectedCharacter.id ||
          (item.display_name && item.display_name === selectedCharacter.name),
      );
    });
  }, [scenes, sceneData, selectedCharacter]);

  const scenesWithOutfit = useMemo(() => {
    if (!selectedCharacter) return [];
    return scenes.filter((scene) => Boolean(overrides?.scene_outfits?.[scene.id]?.[selectedCharacter.id]));
  }, [scenes, overrides?.scene_outfits, selectedCharacter]);

  // 選んだキャラクターに関連付けた生成物の件数と、定義変更 (updated_at) より前の件数。
  useEffect(() => {
    setMediaImpact(null);
    setImpactError(null);
    if (!active || !projectId || !selectedCharacter) return;
    let alive = true;
    api
      .listMediaItems({ projectId, characterId: selectedCharacter.id })
      .then((items) => {
        if (!alive) return;
        // character_reference は本人の参照画像そのもの (生成物ではない) なので除く。
        const generated = items.filter((item) => item.source !== "character_reference");
        const updatedAt = selectedCharacter.updated_at ?? null;
        let before = updatedAt ? 0 : null;
        let unknownTime = 0;
        for (const item of generated) {
          if (!item.created_at) {
            unknownTime += 1;
            continue;
          }
          // 時差表記が混ざっても比べられるよう、文字列ではなく時刻で比べる。
          if (updatedAt && Date.parse(item.created_at) < Date.parse(updatedAt)) before = (before ?? 0) + 1;
        }
        setMediaImpact({ total: generated.length, before, unknownTime });
      })
      .catch((cause) => alive && setImpactError(describe(cause)));
    return () => {
      alive = false;
    };
  }, [active, projectId, selectedCharacter]);

  // 全体置換のPUTのため、保存直前に最新を読み直してから変更を当てる。制作計画での
  // 衣装選択や場面プロンプトの編集を、手元の古い値で巻き戻さないようにする。
  const persist = async (update: (latest: ProjectLocalOverrides) => ProjectLocalOverrides) => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const latest = await api.getProjectLocalOverrides(projectId);
      const saved = await api.updateProjectLocalOverrides(projectId, update(latest));
      setOverrides(saved);
      onChanged();
    } catch (cause) {
      setError(describe(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  };

  const openDraft = (profile?: ProjectCharacterProfile) => {
    const next = toDraft(profile);
    setDraft(next);
    setSelectedId(next.id);
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
      return;
    }
    setError("選択した画像を取り込めませんでした。選び直してください。");
  };

  const addOutfit = () => {
    setDraft((current) => current && ({
      ...current,
      outfits: [...current.outfits, { id: crypto.randomUUID(), name: "", prompt: "" }],
    }));
  };

  const updateOutfit = (id: string, patch: Partial<ProjectCharacterOutfit>) => {
    setDraft((current) => current && ({
      ...current,
      outfits: current.outfits.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  };

  const removeOutfit = (id: string) => {
    setDraft((current) => current && ({
      ...current,
      outfits: current.outfits.filter((item) => item.id !== id),
      default_outfit_id: current.default_outfit_id === id ? "" : current.default_outfit_id,
    }));
  };

  const saveCharacter = async (event: FormEvent) => {
    event.preventDefault();
    if (!overrides || !draft) return;
    const tags = [...new Set(
      draft.tags.split(",").map((value) => value.trim()).filter(Boolean),
    )];
    const outfits = draft.outfits
      .map((item) => ({ ...item, name: item.name.trim(), prompt: item.prompt.trim() }))
      .filter((item) => item.name.length > 0);
    const outfitIds = new Set(outfits.map((item) => item.id));
    const profile: ProjectCharacterProfile = {
      id: draft.id,
      name: draft.name.trim(),
      tags,
      appearance: draft.appearance.trim() || null,
      voice: draft.voice.trim() || null,
      reference_images: draft.reference_images,
      outfits,
      default_outfit_id: outfitIds.has(draft.default_outfit_id) ? draft.default_outfit_id : null,
    };
    try {
      await persist((latest) => {
        const current = latest.characters ?? [];
        // フォームを開いてから別の画面・タブで同じキャラクターが更新・削除されていたら、
        // 手元の値で丸ごと置き換えると相手の変更が消えるため保存しない。
        if (draft.existing) {
          const stored = current.find((item) => item.id === profile.id);
          if (!stored || (stored.updated_at ?? null) !== draft.base_updated_at) {
            // 一覧を最新へ差し替え、開き直したときに新しいupdated_atで編集できるようにする。
            setOverrides(latest);
            throw new Error(
              "このキャラクターは他の画面で更新されたため保存しませんでした。一覧を最新にしたので、キャンセルして開き直してから編集してください。",
            );
          }
        }
        const characters = current.some((item) => item.id === profile.id)
          ? current.map((item) => (item.id === profile.id ? profile : item))
          : [...current, profile];
        return {
          ...latest,
          characters,
          scene_outfits: pruneSceneOutfits(latest.scene_outfits, profile.id, outfitIds),
        };
      });
      setDraft(null);
      setSelectedId(profile.id);
    } catch {
      // persistが画面へAPIエラーを表示する。
    }
  };

  const removeCharacter = async (profile: ProjectCharacterProfile) => {
    if (!overrides || !window.confirm(`${profile.name}の登録を削除しますか？`)) return;
    try {
      await persist((latest) => ({
        ...latest,
        characters: (latest.characters ?? []).filter((item) => item.id !== profile.id),
        scene_outfits: pruneSceneOutfits(latest.scene_outfits, profile.id, new Set()),
      }));
      if (selectedId === profile.id) {
        setSelectedId(null);
        setDraft(null);
      }
    } catch {
      // persistが画面へAPIエラーを表示する。
    }
  };

  if (!projectId) {
    return (
      <section className="panel">
        <EmptyState
          title="Projectを選択してください。"
          description="キャラクター定義はProjectごとに保存します。"
        />
      </section>
    );
  }

  if (!overrides) {
    return <section className="panel"><p className={error ? "error" : "muted"}>{error ?? "キャラクター定義を読込み中..."}</p></section>;
  }

  return (
    <div className="row" style={{ alignItems: "flex-start" }}>
      <section className="panel stack" style={{ minWidth: 280 }}>
        <div className="row spread">
          <h2>キャラクター</h2>
          <Button variant="primary" disabled={busy} onClick={() => openDraft()}>追加</Button>
        </div>
        {characters.length === 0 && <p className="muted">登録はありません。</p>}
        <ul className="list structure-list">
          {characters.map((profile) => (
            <li key={profile.id}>
              <button
                type="button"
                aria-pressed={profile.id === selectedId}
                className={profile.id === selectedId ? "primary" : undefined}
                onClick={() => setSelectedId(profile.id)}
              >
                <span>{profile.name}</span>
                <span className="muted">
                  {(profile.tags ?? []).join(", ") || "タグなし"} / 衣装{(profile.outfits ?? []).length}件
                </span>
              </button>
              <div className="row structure-actions">
                <Button disabled={busy} onClick={() => openDraft(profile)}>編集</Button>
                <Button variant="danger" disabled={busy} onClick={() => void removeCharacter(profile)}>削除</Button>
              </div>
            </li>
          ))}
        </ul>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel stack" style={{ flex: 1 }}>
        {!draft && selectedCharacter && (
          <div className="stack">
            <h3>{selectedCharacter.name}</h3>
            <p className="muted">{(selectedCharacter.tags ?? []).join(", ") || "タグなし"}</p>
            <p>{selectedCharacter.appearance || "外見未設定"}</p>
            <p className="muted">声: {selectedCharacter.voice || "未設定"}</p>
            <h4>影響範囲</h4>
            <ul className="list">
              <li>登場する場面: {scenesFeaturing.length}件 ({scenesFeaturing.map((item) => item.summary).join("、") || "なし"})</li>
              <li>衣装を指定した場面: {scenesWithOutfit.length}件</li>
              <li>
                {impactError
                  ? `生成物の件数を取得できませんでした: ${impactError}`
                  : mediaImpact
                    ? `関連付けた生成物: ${mediaImpact.total}件`
                      + (mediaImpact.before !== null ? ` (うち定義変更前: ${mediaImpact.before}件)` : " (定義変更の記録なしのため定義変更前の判定は不可)")
                      + (mediaImpact.unknownTime > 0 ? ` / 時刻不明 ${mediaImpact.unknownTime}件` : "")
                    : "生成物の件数を取得中..."}
              </li>
            </ul>
            <Button disabled={busy} onClick={() => openDraft(selectedCharacter)}>編集</Button>
          </div>
        )}

        {draft && (
          <form className="stack" onSubmit={saveCharacter}>
            <h3>{characters.some((item) => item.id === draft.id) ? "キャラクターを編集" : "キャラクターを追加"}</h3>
            <label>名前<input required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>タグ（カンマ区切り）<input value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></label>
            <label>外見<textarea rows={4} maxLength={2000} value={draft.appearance} onChange={(event) => setDraft({ ...draft, appearance: event.target.value })} /></label>
            <label>声<textarea rows={3} maxLength={2000} value={draft.voice} onChange={(event) => setDraft({ ...draft, voice: event.target.value })} /></label>

            <fieldset className="stack">
              <legend>衣装</legend>
              {draft.outfits.length === 0 && <p className="muted">衣装はまだありません。</p>}
              <ul className="list">
                {draft.outfits.map((outfit) => (
                  <li key={outfit.id} className="stack">
                    <label>
                      名前
                      <input
                        required
                        maxLength={120}
                        value={outfit.name}
                        onChange={(event) => updateOutfit(outfit.id, { name: event.target.value })}
                      />
                    </label>
                    <label>
                      プロンプト
                      <textarea
                        rows={2}
                        value={outfit.prompt}
                        onChange={(event) => updateOutfit(outfit.id, { prompt: event.target.value })}
                      />
                    </label>
                    <label className="production-plan-check">
                      <input
                        type="radio"
                        name={`default-outfit-${draft.id}`}
                        checked={draft.default_outfit_id === outfit.id}
                        onChange={() => setDraft({ ...draft, default_outfit_id: outfit.id })}
                      />
                      既定の衣装にする
                    </label>
                    <Button variant="danger" onClick={() => removeOutfit(outfit.id)}>この衣装を削除</Button>
                  </li>
                ))}
              </ul>
              <Button disabled={draft.outfits.length >= 20} onClick={addOutfit}>衣装を追加</Button>
            </fieldset>

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

            {selectedCharacter && (
              <p className="muted">
                保存すると、登場する場面{scenesFeaturing.length}件・関連付けた生成物
                {mediaImpact ? `${mediaImpact.total}件` : "取得中"}に影響します。
              </p>
            )}
            {error && <p className="error">{error}</p>}
            <div className="row">
              <Button disabled={busy} onClick={() => setDraft(null)}>キャンセル</Button>
              <Button type="submit" variant="primary" disabled={busy}>{busy ? "保存中..." : "保存"}</Button>
            </div>
          </form>
        )}

        {!draft && !selectedCharacter && (
          <EmptyState title="キャラクターを選択してください。" description="一覧から選ぶか、追加してください。" />
        )}
      </section>
    </div>
  );
}
