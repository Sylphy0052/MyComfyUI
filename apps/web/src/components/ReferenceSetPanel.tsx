/**
 * 参照画像セットの役割枠パネル (F-16 #155)。
 *
 * キャラクターの衣装ごとに参照セットを作り、7つの役割枠 (state/referenceSlots.ts) を
 * 手動で選ぶか、Recipeを選んで空き枠だけ一括生成する。生成中Jobはポーリングで拾い、
 * 完了したらArtifactを枠へ、失敗したら枠を空へ戻す。
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  ProjectCharacterProfile,
  ProjectLocalOverrides,
  ProjectReferenceSet,
  ProjectReferenceSlot,
  Recipe,
  ReferenceSlotKey,
} from "../api/client";
import { REFERENCE_SLOTS, slotPrompt } from "../state/referenceSlots";
import { MediaPicker, toReferenceImage } from "./MediaPicker";
import type { PickedMedia } from "./MediaPicker";
import { Button } from "./ui/Button";

interface Props {
  projectId: string;
  character: ProjectCharacterProfile;
  /** 保存に成功するたびに最新のOverridesを渡す。呼び出し元でoverrides stateの更新に使う。 */
  onSaved: (overrides: ProjectLocalOverrides) => void;
}

const POLL_INTERVAL_MS = 5000;
/** 進行中とみなすJobの状態。それ以外 (succeeded/failed/cancelled) は終了済みとして扱う。 */
const PENDING_STATES = new Set(["queued", "running", "cancelling"]);

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function ReferenceSetPanel({ projectId, character, onSaved }: Props) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recipeId, setRecipeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 複数の枠操作 (ピック・削除・一括生成) が並行しても、GET-latest → PUTを直列化して
  // 相手の変更を消さないようにする (CharacterManagerのpersist、App.tsxの
  // changeSceneOutfit/sceneOutfitQueueRefと同じ考え方)。
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pollingRef = useRef(false);

  useEffect(() => {
    let active = true;
    api
      .listRecipes("image")
      .then((list) => {
        if (!active) return;
        setRecipes(list);
        setRecipeId((current) => current || list[0]?.id || "");
      })
      .catch(() => {
        // Recipeが取れなくても手動での枠の指定・削除は使えるようにする。
      });
    return () => {
      active = false;
    };
  }, []);

  const outfits = character.outfits ?? [];
  const referenceSets = character.reference_sets ?? [];

  const persist = (
    update: (stored: ProjectCharacterProfile) => ProjectCharacterProfile,
  ): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      setBusy(true);
      try {
        const latest = await api.getProjectLocalOverrides(projectId);
        const current = latest.characters ?? [];
        const stored = current.find((item) => item.id === character.id);
        if (!stored) {
          setError("このキャラクターは他の画面で削除されたため保存できませんでした。");
          return false;
        }
        const updated = update(stored);
        const characters = current.map((item) => (item.id === character.id ? updated : item));
        const saved = await api.updateProjectLocalOverrides(projectId, { ...latest, characters });
        setError(null);
        onSaved(saved);
        return true;
      } catch (cause) {
        setError(describe(cause));
        return false;
      } finally {
        setBusy(false);
      }
    };
    // runは例外を外へ出さないので、キューが途中で止まることはない。
    const queued = queueRef.current.then(run);
    queueRef.current = queued.then(() => undefined);
    return queued;
  };

  const createSet = (outfitId: string | null) => {
    void persist((stored) => ({
      ...stored,
      reference_sets: [
        ...(stored.reference_sets ?? []),
        { id: crypto.randomUUID(), outfit_id: outfitId, slots: {} },
      ],
    }));
  };

  const deleteSet = (setId: string) => {
    if (!window.confirm("この参照セットを削除しますか？")) return;
    void persist((stored) => ({
      ...stored,
      reference_sets: (stored.reference_sets ?? []).filter((set) => set.id !== setId),
    }));
  };

  const updateSlot = (
    setId: string,
    slotKey: ReferenceSlotKey,
    slot: ProjectReferenceSlot | null,
  ) =>
    persist((stored) => ({
      ...stored,
      reference_sets: (stored.reference_sets ?? []).map((set) => {
        if (set.id !== setId) return set;
        const slots = { ...set.slots };
        if (slot) slots[slotKey] = slot;
        else delete slots[slotKey];
        return { ...set, slots };
      }),
    }));

  const handleSlotPicked = (setId: string, slotKey: ReferenceSlotKey, next: PickedMedia[]) => {
    const item = next[0];
    if (!item) return;
    setBusy(true);
    setError(null);
    toReferenceImage(item)
      .then((image) => updateSlot(setId, slotKey, { image }))
      .catch((cause) => {
        setError(describe(cause));
        setBusy(false);
      });
  };

  const removeSlotImage = (setId: string, slotKey: ReferenceSlotKey) => {
    void updateSlot(setId, slotKey, null);
  };

  const generateEmptySlots = (referenceSet: ProjectReferenceSet) => {
    if (!recipeId) {
      setError("生成に使うRecipeを選んでください。");
      return;
    }
    const emptyKeys = REFERENCE_SLOTS.map((def) => def.key).filter((key) => {
      const slot = referenceSet.slots?.[key];
      return !slot?.image && !slot?.artifact_id && !slot?.pending_job_id;
    });
    if (emptyKeys.length === 0) return;
    setBusy(true);
    setError(null);
    // 一部の投入が失敗しても、投入できたJobは枠へ記録する。記録しないとJobだけが走り、
    // 次の生成で同じ枠へ二重に投入される。
    void Promise.allSettled(
      emptyKeys.map((key) =>
        api.createJob({
          kind: "image",
          project_id: projectId,
          recipe_id: recipeId,
          inputs: { positive_prompt: slotPrompt(character, referenceSet.outfit_id ?? null, key) },
        }),
      ),
    ).then(async (results) => {
      const submitted = new Map<ReferenceSlotKey, string>();
      const failures: string[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") submitted.set(emptyKeys[index], result.value.id);
        else failures.push(describe(result.reason));
      });
      if (submitted.size > 0) {
        const saved = await persist((stored) => ({
          ...stored,
          reference_sets: (stored.reference_sets ?? []).map((set) => {
            if (set.id !== referenceSet.id) return set;
            const slots = { ...set.slots };
            for (const [key, jobId] of submitted) slots[key] = { pending_job_id: jobId };
            return { ...set, slots };
          }),
        }));
        if (!saved) {
          await Promise.allSettled([...submitted.values()].map((jobId) => api.cancelJob(jobId)));
          setBusy(false);
          return;
        }
      }
      if (failures.length > 0) {
        setError(`${failures.length}枠の生成を投入できませんでした: ${failures[0]}`);
      }
      setBusy(false);
    });
  };

  // ポーリング対象のJob ID一覧。フレッシュな枠の状態はpersist内のGETで取り直すため、
  // ここではポーリングするJob IDの収集だけ行う。
  const pendingJobIds = useMemo(() => {
    const ids = new Set<string>();
    for (const set of referenceSets) {
      for (const slot of Object.values(set.slots ?? {})) {
        if (slot.pending_job_id) ids.add(slot.pending_job_id);
      }
    }
    return Array.from(ids);
  }, [referenceSets]);

  useEffect(() => {
    if (pendingJobIds.length === 0) return;
    let active = true;
    const timer = setInterval(() => {
      if (!active || pollingRef.current) return;
      pollingRef.current = true;
      (async () => {
        try {
          // 完了したJobの画像は入力cacheへ取り込み、動画の参照画像として渡せる形で枠へ入れる。
          const resolved = new Map<string, ProjectReferenceSlot | null>();
          let failed = 0;
          let unreachable = 0;
          for (const jobId of pendingJobIds) {
            let job;
            try {
              job = await api.getJob(jobId);
            } catch (cause) {
              if (cause instanceof ApiError && cause.status === 404) {
                failed += 1;
                resolved.set(jobId, null);
              } else {
                unreachable += 1;
              }
              continue;
            }
            if (PENDING_STATES.has(job.state)) continue;
            const artifact = job.state === "succeeded"
              ? (await api.listJobArtifacts(jobId)).find((item) => item.media_type?.startsWith("image/"))
              : undefined;
            if (artifact) {
              const image = await toReferenceImage({
                key: `artifact:${artifact.id}`,
                label: artifact.id,
                source: { artifact_id: artifact.id },
                mediaType: artifact.media_type ?? undefined,
                artifact,
              });
              resolved.set(jobId, { image, artifact_id: artifact.id });
            } else {
              // 失敗・取消、または画像が出なかったJob。枠を空へ戻し、生成し直せるようにする。
              failed += 1;
              resolved.set(jobId, null);
            }
          }
          if (!active) return;
          if (resolved.size > 0) {
            await persist((stored) => ({
              ...stored,
              reference_sets: (stored.reference_sets ?? []).map((set) => {
                const slots = { ...set.slots };
                let changed = false;
                for (const key of Object.keys(slots) as ReferenceSlotKey[]) {
                  const slot = slots[key];
                  if (!slot?.pending_job_id || !resolved.has(slot.pending_job_id)) continue;
                  changed = true;
                  const filled = resolved.get(slot.pending_job_id) ?? null;
                  if (filled) slots[key] = filled;
                  else delete slots[key];
                }
                return changed ? { ...set, slots } : set;
              }),
            }));
          }
          // persistは成功時にエラー表示を消すため、結果の通知は保存のあとに出す。
          if (failed > 0) {
            setError(`${failed}枠の生成が完了しませんでした。空の枠を生成し直してください。`);
          } else if (unreachable > 0) {
            setError("生成中のJobの状態を取得できませんでした。しばらくして再確認します。");
          }
        } catch (cause) {
          // 画像の取り込みや保存の失敗。枠は生成中のまま残し、次回のポーリングで再試行する。
          if (active) setError(`生成した画像を枠へ反映できませんでした: ${describe(cause)}`);
        } finally {
          pollingRef.current = false;
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [pendingJobIds]);

  const availableOutfits = outfits.filter(
    (outfit) => !referenceSets.some((set) => set.outfit_id === outfit.id),
  );
  const hasNoOutfitSet = referenceSets.some((set) => set.outfit_id == null);

  return (
    <section className="stack">
      <div className="row spread">
        <h4>参照画像セット</h4>
        <select
          value={recipeId}
          onChange={(event) => setRecipeId(event.target.value)}
          disabled={busy || recipes.length === 0}
        >
          {recipes.length === 0 && <option value="">Recipeなし</option>}
          {recipes.map((recipe) => (
            <option key={recipe.id} value={recipe.id}>{recipe.name}</option>
          ))}
        </select>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {!hasNoOutfitSet && (
          <Button disabled={busy} onClick={() => createSet(null)}>衣装指定なしのセットを追加</Button>
        )}
        {availableOutfits.map((outfit) => (
          <Button key={outfit.id} disabled={busy} onClick={() => createSet(outfit.id)}>
            {outfit.name}のセットを追加
          </Button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {referenceSets.length === 0 && <p className="muted">参照セットはまだありません。</p>}
      {referenceSets.map((set) => {
        const outfitName = set.outfit_id
          ? outfits.find((item) => item.id === set.outfit_id)?.name ?? "(削除済み衣装)"
          : "衣装指定なし";
        return (
          <div key={set.id} className="panel stack">
            <div className="row spread">
              <strong>{outfitName}</strong>
              <div className="row">
                <Button disabled={busy || !recipeId} onClick={() => generateEmptySlots(set)}>空き枠を生成</Button>
                <Button variant="danger" disabled={busy} onClick={() => deleteSet(set.id)}>セット削除</Button>
              </div>
            </div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {REFERENCE_SLOTS.map((def) => {
                const slot = set.slots?.[def.key];
                const pending = Boolean(slot?.pending_job_id);
                const thumbUrl = slot?.artifact_id ? api.artifactContentUrl(slot.artifact_id) : null;
                return (
                  <div key={def.key} className="stack" style={{ width: 160 }}>
                    <span className="muted">{def.label}</span>
                    {pending && <p className="muted">生成中...</p>}
                    {pending && (
                      <Button disabled={busy} onClick={() => removeSlotImage(set.id, def.key)}>待つのをやめる</Button>
                    )}
                    {!pending && thumbUrl && <img src={thumbUrl} alt={def.label} style={{ width: "100%" }} />}
                    {!pending && !thumbUrl && slot?.image && <p>{slot.image.file_name}</p>}
                    {!pending && !thumbUrl && !slot?.image && <p className="muted">未設定</p>}
                    {!pending && (slot?.image || slot?.artifact_id) && (
                      <Button disabled={busy} onClick={() => removeSlotImage(set.id, def.key)}>外す</Button>
                    )}
                    {!pending && (
                      <MediaPicker
                        kind="image"
                        label=""
                        value={[]}
                        onChange={(next) => handleSlotPicked(set.id, def.key, next)}
                        multiple={false}
                        disabled={busy}
                        maxBytes={25 * 1024 * 1024}
                        projectId={projectId}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}
