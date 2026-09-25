import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { ApiError, api } from "../api/client";
import type {
  AgentProvider,
  MediaItem,
  ProjectCharacterOutfit,
  ProjectCharacterProfile,
  ProjectCharacterProfileExtraField,
  ProjectLocalOverrides,
  ProjectReferenceImage,
} from "../api/client";
import type { SceneEnvelope, SceneSummary } from "../api/aimedia";
import { MediaPicker, readPickedImage, toReferenceImage } from "./MediaPicker";
import type { PickedMedia } from "./MediaPicker";
import { PromptAssist } from "./PromptAssist";
import { ReferenceSetPanel } from "./ReferenceSetPanel";
import { Button } from "./ui/Button";
import { EmptyState } from "./ui/EmptyState";

/** プロフィールの固定5項目。ドラフトではフラットな文字列で持つ。 */
interface ProfileDraft {
  personality: string;
  age: string;
  first_person: string;
  speech_style: string;
  background: string;
  extra: ProjectCharacterProfileExtraField[];
}

const EMPTY_PROFILE: ProfileDraft = {
  personality: "",
  age: "",
  first_person: "",
  speech_style: "",
  background: "",
  extra: [],
};

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
  prompt: string;
  negative_prompt: string;
  profile: ProfileDraft;
  reference_images: ProjectReferenceImage[];
  outfits: ProjectCharacterOutfit[];
  /** 衣装ごとの分類タグの入力値 (カンマ区切り)。キーは衣装id。保存時に配列へ直す。 */
  outfit_tags: Record<string, string>;
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
        prompt: profile.prompt ?? "",
        negative_prompt: profile.negative_prompt ?? "",
        profile: {
          personality: profile.profile?.personality ?? "",
          age: profile.profile?.age ?? "",
          first_person: profile.profile?.first_person ?? "",
          speech_style: profile.profile?.speech_style ?? "",
          background: profile.profile?.background ?? "",
          extra: profile.profile?.extra ?? [],
        },
        reference_images: profile.reference_images ?? [],
        outfits: profile.outfits ?? [],
        outfit_tags: Object.fromEntries(
          (profile.outfits ?? []).map((outfit) => [outfit.id, (outfit.tags ?? []).join(", ")]),
        ),
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
        prompt: "",
        negative_prompt: "",
        profile: EMPTY_PROFILE,
        reference_images: [],
        outfits: [],
        outfit_tags: {},
        default_outfit_id: "",
        base_updated_at: null,
        existing: false,
      };
}

/** カンマ区切りの入力をタグの配列にする。空要素と重複は落とす。 */
function splitTags(text: string): string[] {
  return [...new Set(text.split(",").map((value) => value.trim()).filter(Boolean))];
}

/**
 * プロフィールのドラフトを保存用の`ProjectCharacterPersonalProfile`へ変換する。
 * 固定項目・自由項目とも空ならnull (プロフィール自体を持たせない)。
 */
function draftToProfile(
  draft: ProfileDraft,
): ProjectCharacterProfile["profile"] {
  const extra = draft.extra
    .map((item) => ({ key: item.key.trim(), value: item.value.trim() }))
    .filter((item) => item.key.length > 0);
  const fixed = {
    personality: draft.personality.trim() || null,
    age: draft.age.trim() || null,
    first_person: draft.first_person.trim() || null,
    speech_style: draft.speech_style.trim() || null,
    background: draft.background.trim() || null,
  };
  const hasContent = Object.values(fixed).some((value) => value !== null) || extra.length > 0;
  return hasContent ? { ...fixed, extra } : null;
}

/**
 * 自由項目を保存前に確かめる。内容だけあって項目名が空の行や、項目名の重複があれば
 * 理由を返す。両方空の行は入力途中とみなし、保存時に落とす。
 */
function profileExtraError(draft: ProfileDraft): string | null {
  const keys: string[] = [];
  for (const item of draft.extra) {
    const key = item.key.trim();
    if (!key) {
      if (item.value.trim()) return "自由項目に項目名が空の行があります。項目名を入力するか、行を削除してください。";
      continue;
    }
    if (keys.includes(key)) return `自由項目の項目名「${key}」が重複しています。`;
    keys.push(key);
  }
  return null;
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

const VOICE_REFERENCE_PAGE_SIZE = 200;

/**
 * 選んだキャラクターに`voice_reference`で紐付いた参照音声の確認・追加・解除 (#287)。
 * 専用endpointは作らず、既存の`listMediaItems`と`upsertMediaRoleTag`で足りる範囲へ絞る。
 */
function VoiceReferenceSection({
  projectId,
  character,
}: {
  projectId: string;
  character: ProjectCharacterProfile;
}) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    // APIの`limit`上限(200)で切れないよう、1ページに満たなくなるまで辿る。
    const loadAll = async () => {
      const found: MediaItem[] = [];
      for (let offset = 0; ; offset += VOICE_REFERENCE_PAGE_SIZE) {
        const page = await api.listMediaItems({
          projectId,
          role: "voice_reference",
          limit: VOICE_REFERENCE_PAGE_SIZE,
          offset,
        });
        found.push(...page);
        // アンマウント後は残りのページを取りに行かない。
        if (!alive || page.length < VOICE_REFERENCE_PAGE_SIZE) return found;
      }
    };
    loadAll()
      .then((found) => alive && setItems(found))
      .catch((cause) => alive && setError(describe(cause)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [projectId, reloadToken]);

  const toggle = async (item: MediaItem, attach: boolean) => {
    setBusyKey(item.key);
    setError(null);
    try {
      const characterIds = attach
        ? [...new Set([...(item.character_ids ?? []), character.id])]
        : (item.character_ids ?? []).filter((id) => id !== character.id);
      await api.upsertMediaRoleTag({
        artifact_id: item.artifact_id ?? undefined,
        relative_path: item.artifact_id ? undefined : item.relative_path,
        sha256: item.sha256,
        file_name: item.label ?? undefined,
        byte_size: item.byte_size,
        media_type: item.media_type,
        role: "voice_reference",
        character_ids: characterIds,
        project_id: projectId,
        // 上書き更新のため、既存の場面の紐付けを送り直して消さない。
        scene_id:
          item.assigned_project_id === projectId ? (item.assigned_scene_id ?? undefined) : undefined,
      });
      setReloadToken((value) => value + 1);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusyKey(null);
    }
  };

  const linked = items.filter((item) => (item.character_ids ?? []).includes(character.id));
  const unlinked = items.filter((item) => !(item.character_ids ?? []).includes(character.id));

  return (
    <fieldset className="stack">
      <legend>参照音声</legend>
      {loading && <p className="muted">読込み中...</p>}
      {error && <p className="error">{error}</p>}
      {linked.length === 0 && !loading && <p className="muted">紐付いた参照音声はありません。</p>}
      <ul className="list">
        {linked.map((item) => (
          <li key={item.key} className="row spread">
            <span>{item.label ?? item.relative_path}</span>
            {item.artifact_id && (
              <audio src={api.artifactContentUrl(item.artifact_id)} controls />
            )}
            <Button variant="danger" disabled={busyKey !== null} onClick={() => void toggle(item, false)}>
              解除
            </Button>
          </li>
        ))}
      </ul>
      {unlinked.length > 0 && (
        <details>
          <summary>他の参照音声から追加</summary>
          <ul className="list">
            {unlinked.map((item) => (
              <li key={item.key} className="row spread">
                <span>{item.label ?? item.relative_path}</span>
                <Button disabled={busyKey !== null} onClick={() => void toggle(item, true)}>
                  追加
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </fieldset>
  );
}

interface Props {
  projectId: string | null;
  /** この画面が表示中かどうか。非表示中は場面本文・生成物件数を取り直さない。 */
  active: boolean;
  /** 選択中Projectの場面一覧 (要約)。登場場面の判定に本文を別途取得して使う。 */
  scenes: SceneSummary[];
  /** キャラクター定義・scene_outfitsを保存したら呼ぶ。他画面 (制作計画等) の再取得を促す。 */
  onChanged: () => void;
  /** 他画面 (生成フォーム等) でキャラクター定義を保存したら増やす。一覧を取り直す (#316)。 */
  reloadToken?: number;
}

export function CharacterManager({ projectId, active, scenes, onChanged, reloadToken = 0 }: Props) {
  const [overrides, setOverrides] = useState<ProjectLocalOverrides | null>(null);
  const [draft, setDraft] = useState<CharacterDraft | null>(null);
  const [pickedReference, setPickedReference] = useState<PickedMedia[]>([]);
  const [pickedOutfitImage, setPickedOutfitImage] = useState<PickedMedia[]>([]);
  const [outfitImageTags, setOutfitImageTags] = useState("");
  const [addingOutfit, setAddingOutfit] = useState(false);
  const [outfitSearch, setOutfitSearch] = useState("");
  const [outfitTagFilters, setOutfitTagFilters] = useState<string[]>([]);
  const [outfitBulkProgress, setOutfitBulkProgress] = useState<string | null>(null);
  const [outfitBulkFailures, setOutfitBulkFailures] = useState<{ name: string; reason: string }[]>([]);
  const [outfitSkipped, setOutfitSkipped] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sceneData, setSceneData] = useState<Record<string, SceneEnvelope>>({});
  const [mediaImpact, setMediaImpact] = useState<MediaImpact | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<AgentProvider[]>([]);

  useEffect(() => {
    setOverrides(null);
    setDraft(null);
    setSelectedId(null);
    setError(null);
  }, [projectId]);

  // AIによるプロンプト補完 (PromptAssist) 向けのプロバイダ一覧。
  useEffect(() => {
    void api.listAgentProviders().then(setProviders).catch(() => setProviders([]));
  }, []);

  // 一覧だけを取り直す。編集中の下書きは残し、保存時の競合はupdated_atで判定する。
  useEffect(() => {
    if (reloadToken > 0) setOverrides(null);
  }, [reloadToken]);

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

  // 衣装の検索・分類タグの絞り込み (#316)。消えたタグは選択から外す。
  const outfitTagOptions = draft
    ? [...new Set(draft.outfits.flatMap((outfit) => splitTags(draft.outfit_tags[outfit.id] ?? "")))].sort()
    : [];
  const activeOutfitTagFilters = outfitTagFilters.filter((tag) => outfitTagOptions.includes(tag));
  const outfitSearchTerm = outfitSearch.trim().toLowerCase();
  const visibleOutfits = draft
    ? draft.outfits.filter((outfit) => {
      const tags = splitTags(draft.outfit_tags[outfit.id] ?? "");
      if (activeOutfitTagFilters.some((tag) => !tags.includes(tag))) return false;
      if (!outfitSearchTerm) return true;
      const haystack = [outfit.name, outfit.prompt, ...tags].join(" ").toLowerCase();
      return haystack.includes(outfitSearchTerm);
    })
    : [];

  const toggleOutfitTagFilter = (tag: string) => {
    setOutfitTagFilters((current) => (
      current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]
    ));
  };

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
    setError(null);
    setDraft(next);
    setSelectedId(next.id);
  };

  const handleReferencePicked = (next: PickedMedia[]) => {
    const item = next[0];
    setPickedReference([]);
    if (!item) return;
    setError(null);
    toReferenceImage(item)
      .then((image) => {
        setDraft((current) => current && ({
          ...current,
          reference_images: [...current.reference_images, image],
        }));
      })
      .catch((cause) => setError(describe(cause)));
  };

  const addOutfit = () => {
    setDraft((current) => current && ({
      ...current,
      outfits: [...current.outfits, { id: crypto.randomUUID(), name: "", prompt: "" }],
    }));
  };

  /**
   * 画像から衣装を一括で作る (#316)。1枚ずつTaggerで抽出し、失敗した画像は飛ばして
   * 残りを続ける。上限100件を超える分は処理せず、件数だけ表示する。
   */
  const addOutfitFromImage = async () => {
    const items = pickedOutfitImage;
    if (items.length === 0 || !draft) return;
    const capacity = Math.max(0, 100 - draft.outfits.length);
    const toProcess = items.slice(0, capacity);
    const tags = splitTags(outfitImageTags);
    setAddingOutfit(true);
    setError(null);
    setOutfitBulkFailures([]);
    setOutfitSkipped(items.length - toProcess.length);
    const failures: { name: string; reason: string }[] = [];
    for (let index = 0; index < toProcess.length; index += 1) {
      const item = toProcess[index];
      setOutfitBulkProgress(`抽出中 ${index + 1}/${toProcess.length}`);
      try {
        const { base64, mediaType } = await readPickedImage(item);
        const extracted = await api.extractImageTags(base64, mediaType);
        const image = await toReferenceImage(item);
        const name = (image.file_name.replace(/\.[^./]+$/, "") || image.file_name).slice(0, 120);
        const outfit: ProjectCharacterOutfit = {
          id: crypto.randomUUID(),
          name,
          prompt: extracted.tags.join(", "),
          tags,
          image,
        };
        setDraft((current) => current && ({
          ...current,
          outfits: [...current.outfits, outfit],
          outfit_tags: { ...current.outfit_tags, [outfit.id]: tags.join(", ") },
        }));
      } catch (cause) {
        failures.push({ name: item.label, reason: describe(cause) });
      }
    }
    setOutfitBulkProgress(null);
    setOutfitBulkFailures(failures);
    setPickedOutfitImage([]);
    setOutfitImageTags("");
    setAddingOutfit(false);
  };

  const updateOutfit = (id: string, patch: Partial<ProjectCharacterOutfit>) => {
    setDraft((current) => current && ({
      ...current,
      outfits: current.outfits.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  };

  const updateProfile = (patch: Partial<ProfileDraft>) => {
    setDraft((current) => current && ({ ...current, profile: { ...current.profile, ...patch } }));
  };

  const addProfileExtra = () => {
    setDraft((current) => current && ({
      ...current,
      profile: { ...current.profile, extra: [...current.profile.extra, { key: "", value: "" }] },
    }));
  };

  const updateProfileExtra = (index: number, patch: Partial<ProjectCharacterProfileExtraField>) => {
    setDraft((current) => current && ({
      ...current,
      profile: {
        ...current.profile,
        extra: current.profile.extra.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
      },
    }));
  };

  const removeProfileExtra = (index: number) => {
    setDraft((current) => current && ({
      ...current,
      profile: { ...current.profile, extra: current.profile.extra.filter((_, itemIndex) => itemIndex !== index) },
    }));
  };

  const removeOutfit = (id: string) => {
    setDraft((current) => current && ({
      ...current,
      outfits: current.outfits.filter((item) => item.id !== id),
      outfit_tags: Object.fromEntries(Object.entries(current.outfit_tags).filter(([key]) => key !== id)),
      default_outfit_id: current.default_outfit_id === id ? "" : current.default_outfit_id,
    }));
  };

  const saveCharacter = async (event: FormEvent) => {
    event.preventDefault();
    if (!overrides || !draft) return;
    const extraError = profileExtraError(draft.profile);
    if (extraError) {
      setError(extraError);
      return;
    }
    const tags = [...new Set(
      draft.tags.split(",").map((value) => value.trim()).filter(Boolean),
    )];
    const outfits = draft.outfits
      .map((item) => ({
        ...item,
        name: item.name.trim(),
        prompt: item.prompt.trim(),
        tags: splitTags(draft.outfit_tags[item.id] ?? ""),
      }))
      .filter((item) => item.name.length > 0);
    const outfitIds = new Set(outfits.map((item) => item.id));
    const profile: ProjectCharacterProfile = {
      id: draft.id,
      name: draft.name.trim(),
      tags,
      appearance: draft.appearance.trim() || null,
      voice: draft.voice.trim() || null,
      prompt: draft.prompt.trim() || null,
      negative_prompt: draft.negative_prompt.trim() || null,
      profile: draftToProfile(draft.profile),
      reference_images: draft.reference_images,
      outfits,
      default_outfit_id: outfitIds.has(draft.default_outfit_id) ? draft.default_outfit_id : null,
    };
    try {
      await persist((latest) => {
        const current = latest.characters ?? [];
        // フォームを開いてから別の画面・タブで同じキャラクターが更新・削除されていたら、
        // 手元の値で丸ごと置き換えると相手の変更が消えるため保存しない。
        let stored: ProjectCharacterProfile | undefined;
        if (draft.existing) {
          stored = current.find((item) => item.id === profile.id);
          if (!stored || (stored.updated_at ?? null) !== draft.base_updated_at) {
            // 一覧を最新へ差し替え、開き直したときに新しいupdated_atで編集できるようにする。
            setOverrides(latest);
            throw new Error(
              "このキャラクターは他の画面で更新されたため保存しませんでした。一覧を最新にしたので、キャンセルして開き直してから編集してください。",
            );
          }
        }
        // 参照セットは編集フォームで扱わないため、最新値から引き継ぐ。削除した衣装の
        // セット (衣装指定なしのセットは除く) は落とす (Issue #155)。
        const referenceSets = (stored?.reference_sets ?? []).filter(
          (set) => set.outfit_id == null || outfitIds.has(set.outfit_id),
        );
        const finalProfile: ProjectCharacterProfile = { ...profile, reference_sets: referenceSets };
        const characters = current.some((item) => item.id === finalProfile.id)
          ? current.map((item) => (item.id === finalProfile.id ? finalProfile : item))
          : [...current, finalProfile];
        return {
          ...latest,
          characters,
          scene_outfits: pruneSceneOutfits(latest.scene_outfits, finalProfile.id, outfitIds),
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
    return (
      <section className="panel">
        {error ? <p className="error">{error}</p> : <p className="muted">キャラクター定義を読込み中...</p>}
      </section>
    );
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
            </li>
          ))}
        </ul>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel stack" style={{ flex: 1 }}>
        {!draft && selectedCharacter && (
          <div className="stack">
            <div className="row spread">
              <h3>{selectedCharacter.name}</h3>
              <div className="row">
                <Button disabled={busy} onClick={() => openDraft(selectedCharacter)}>編集</Button>
                <Button variant="danger" disabled={busy} onClick={() => void removeCharacter(selectedCharacter)}>削除</Button>
              </div>
            </div>
            <p className="muted">{(selectedCharacter.tags ?? []).join(", ") || "タグなし"}</p>
            <p>{selectedCharacter.appearance || "外見未設定"}</p>
            <p className="muted">声: {selectedCharacter.voice || "未設定"}</p>
            <p className="muted">プロンプト: {selectedCharacter.prompt || "未設定"}</p>
            <p className="muted">ネガティブプロンプト: {selectedCharacter.negative_prompt || "未設定"}</p>
            {selectedCharacter.profile && (
              <ul className="list">
                <li>性格: {selectedCharacter.profile.personality || "未設定"}</li>
                <li>年齢: {selectedCharacter.profile.age || "未設定"}</li>
                <li>一人称: {selectedCharacter.profile.first_person || "未設定"}</li>
                <li>口調: {selectedCharacter.profile.speech_style || "未設定"}</li>
                <li>経歴: {selectedCharacter.profile.background || "未設定"}</li>
                {(selectedCharacter.profile.extra ?? []).map((item) => (
                  <li key={item.key}>{item.key}: {item.value}</li>
                ))}
              </ul>
            )}
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
            <ReferenceSetPanel
              key={selectedCharacter.id}
              projectId={projectId}
              character={selectedCharacter}
              onSaved={(saved) => {
                setOverrides(saved);
                onChanged();
              }}
            />
            <VoiceReferenceSection
              key={selectedCharacter.id}
              projectId={projectId}
              character={selectedCharacter}
            />
          </div>
        )}

        {draft && (
          <form className="stack" onSubmit={saveCharacter}>
            <h3>{characters.some((item) => item.id === draft.id) ? "キャラクターを編集" : "キャラクターを追加"}</h3>
            <label>名前<input required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>タグ（カンマ区切り）<input value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></label>
            <label>外見<textarea rows={4} maxLength={2000} value={draft.appearance} onChange={(event) => setDraft({ ...draft, appearance: event.target.value })} /></label>
            <label>声<textarea rows={3} maxLength={2000} value={draft.voice} onChange={(event) => setDraft({ ...draft, voice: event.target.value })} /></label>
            <label>プロンプト<textarea rows={3} maxLength={2000} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} /></label>
            <label>ネガティブプロンプト<textarea rows={3} maxLength={2000} value={draft.negative_prompt} onChange={(event) => setDraft({ ...draft, negative_prompt: event.target.value })} /></label>
            <PromptAssist
              providers={providers}
              idPrefix="character"
              current={{ positive: draft.prompt, negative: draft.negative_prompt }}
              projectId={projectId}
              onApply={(result) =>
                // 応答待ちの間に他の欄が編集されていても消さないよう、最新のdraftへ反映する。
                setDraft((current) =>
                  current && { ...current, prompt: result.positive, negative_prompt: result.negative },
                )
              }
            />

            <fieldset className="stack">
              <legend>プロフィール</legend>
              <label>性格<input maxLength={2000} value={draft.profile.personality} onChange={(event) => updateProfile({ personality: event.target.value })} /></label>
              <label>年齢<input maxLength={2000} value={draft.profile.age} onChange={(event) => updateProfile({ age: event.target.value })} /></label>
              <label>一人称<input maxLength={2000} value={draft.profile.first_person} onChange={(event) => updateProfile({ first_person: event.target.value })} /></label>
              <label>口調<input maxLength={2000} value={draft.profile.speech_style} onChange={(event) => updateProfile({ speech_style: event.target.value })} /></label>
              <label>経歴<textarea rows={3} maxLength={2000} value={draft.profile.background} onChange={(event) => updateProfile({ background: event.target.value })} /></label>
              <div className="stack">
                <span className="muted">自由項目</span>
                {draft.profile.extra.map((item, index) => (
                  <div key={index} className="row">
                    <input
                      placeholder="項目名"
                      maxLength={120}
                      value={item.key}
                      onChange={(event) => updateProfileExtra(index, { key: event.target.value })}
                    />
                    <input
                      placeholder="内容"
                      maxLength={2000}
                      value={item.value}
                      onChange={(event) => updateProfileExtra(index, { value: event.target.value })}
                    />
                    <Button variant="danger" onClick={() => removeProfileExtra(index)}>削除</Button>
                  </div>
                ))}
                <Button disabled={draft.profile.extra.length >= 30} onClick={addProfileExtra}>自由項目を追加</Button>
              </div>
            </fieldset>

            <fieldset className="stack">
              <legend>衣装</legend>
              {draft.outfits.length === 0 && <p className="muted">衣装はまだありません。</p>}
              <label>
                検索（名前・プロンプト・分類タグ）
                <input value={outfitSearch} onChange={(event) => setOutfitSearch(event.target.value)} />
              </label>
              {outfitTagOptions.length > 0 && (
                <div className="row">
                  {outfitTagOptions.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="badge"
                      aria-pressed={activeOutfitTagFilters.includes(tag)}
                      onClick={() => toggleOutfitTagFilter(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}
              {draft.outfits.length > 0 && (
                <p className="muted">表示 {visibleOutfits.length}件 / 全 {draft.outfits.length}件</p>
              )}
              <ul className="list">
                {visibleOutfits.map((outfit) => (
                  <li key={outfit.id} className="stack">
                    <div className="row">
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
                        分類タグ（カンマ区切り）
                        <input
                          value={draft.outfit_tags[outfit.id] ?? ""}
                          onChange={(event) => setDraft({ ...draft, outfit_tags: { ...draft.outfit_tags, [outfit.id]: event.target.value } })}
                        />
                      </label>
                      {outfit.image && <span className="muted">元画像: {outfit.image.file_name}</span>}
                    </div>
                    <label>
                      プロンプト
                      <textarea
                        rows={2}
                        value={outfit.prompt}
                        onChange={(event) => updateOutfit(outfit.id, { prompt: event.target.value })}
                      />
                    </label>
                    <div className="row">
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
                    </div>
                  </li>
                ))}
              </ul>
              <Button disabled={draft.outfits.length >= 100} onClick={addOutfit}>衣装を追加</Button>
              <div className="tag-extractor">
                <MediaPicker
                  kind="image"
                  label="衣装の画像 (複数可)"
                  value={pickedOutfitImage}
                  onChange={(items) => {
                    setPickedOutfitImage(items);
                    setOutfitBulkFailures([]);
                    setOutfitSkipped(0);
                  }}
                  multiple
                  disabled={busy || addingOutfit || draft.outfits.length >= 100}
                  maxBytes={25 * 1024 * 1024}
                  projectId={projectId}
                />
                <label>
                  分類タグ（カンマ区切り、例: 制服, 夏）
                  <input value={outfitImageTags} onChange={(event) => setOutfitImageTags(event.target.value)} />
                </label>
                <div className="row">
                  <Button
                    disabled={busy || addingOutfit || pickedOutfitImage.length === 0 || draft.outfits.length >= 100}
                    onClick={addOutfitFromImage}
                  >
                    {addingOutfit ? (outfitBulkProgress ?? "抽出中...") : "画像から衣装を追加"}
                  </Button>
                </div>
                <p className="muted">画像はComfyUIのWD14 Taggerへ送信し、抽出したタグを衣装のプロンプトにします。</p>
                {outfitSkipped > 0 && (
                  <p className="muted">上限100件を超えるため{outfitSkipped}枚を処理しませんでした。</p>
                )}
                {outfitBulkFailures.length > 0 && (
                  <p className="error">
                    失敗した画像: {outfitBulkFailures.map((item) => `${item.name} (${item.reason})`).join(", ")}
                  </p>
                )}
              </div>
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
