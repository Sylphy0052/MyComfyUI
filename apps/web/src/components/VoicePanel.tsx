import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  GenerationJob,
  GenerationPreview,
  MediaItem,
  MediaRole,
  Recipe,
  VoiceBackendHealth,
  VoiceVerification,
} from "../api/client";
import type { CanonDescriptor, ShotEnvelope } from "../api/aimedia";
import {
  applyPlanPreset,
  planPresetBlocker,
  planPresetKeys,
  usePlanPresetDefaults,
  type PlanPreset,
} from "../state/productionPlan";
import { ExecutionPreview } from "./ExecutionPreview";
import { MediaRoleTagFields, useProjectCharacters } from "./MediaRoleTagFields";
import { MediaViewer } from "./MediaViewer";
import type { MediaViewerItem } from "./MediaViewer";
import { PlanPresetNote } from "./ProductionPlanPanel";
import { Icon } from "./ui/Icon";
import { IconButton } from "./ui/IconButton";
import { EmptyState } from "./ui/EmptyState";

/**
 * 1 つの voice_id に対する Voice Canon・参照音声・caption の指定。
 * 参照音声か caption の少なくとも一方が要る (Issue #426)。
 */
interface VoiceBinding {
  canonId: string;
  relativePath: string;
  sha256: string;
  transcript: string;
  /** 声質の文章指定。参照音声が無ければこれだけで声を作る。 */
  caption: string;
  leadingSilenceSec: string;
  /** 取り込んだファイルの表示名。指定済みかどうかの目印にする。 */
  fileName: string | null;
  /** 取込時に参照音声へ付ける役割とキャラクター (Issue #249)。役割が空なら付けない。 */
  role: MediaRole | "";
  characterIds: string[];
  /**
   * 書き起こしが登録済みの参照音声から自動で入った値のままか。手で編集すると外れる。
   * 値の一致では、自動入力と同じ文面を手で入れた場合と区別できない。
   */
  transcriptInherited: boolean;
  /** アップロードした参照音声を取り込んだ時点のキャラクター。登録の有無によらず切替の判定に使う。 */
  uploadedCharacterIds: string[];
  /** 取込は済んだが役割を付けられなかったときの理由。次にこの声を取り込むまで残す。 */
  roleTagError: string | null;
}

// listMediaItemsの1回あたりの取得件数。APIの`limit`上限と同じ。
const REFERENCE_PAGE_SIZE = 200;

// キャラクターを選んでいなければ全件、選んでいればいずれかに紐付く参照音声だけを候補にする。
const linkedToAny = (item: MediaItem, characterIds: string[]) =>
  characterIds.length === 0 ||
  (item.character_ids ?? []).some((id) => characterIds.includes(id));

// 参照音声の書き起こしを生成に使うengine。APIのREFERENCE_TRANSCRIPT_ENGINESと揃える。
// Irodoriは書き起こしを使わないため、空でも投入できる (Issue #436)。
const REFERENCE_TRANSCRIPT_ENGINES = new Set<string>();

// 登録済みの参照音声を声の指定へ入れる値。書き起こしは入れた後も手で直せる。
const referencePatch = (item: MediaItem): Partial<VoiceBinding> => ({
  relativePath: item.relative_path,
  sha256: item.sha256,
  fileName: item.label ?? item.relative_path,
  transcript: item.reference_transcript ?? "",
  transcriptInherited: true,
  uploadedCharacterIds: [],
  role: "voice_reference",
  roleTagError: null,
});

// 参照音声が未指定の声へ書き起こしを先に手で入れていたら、自動で入れる参照音声の
// 書き起こしで上書きしない。
const autoFillPatch = (
  binding: VoiceBinding,
  item: MediaItem,
): Partial<VoiceBinding> => {
  const patch = referencePatch(item);
  if (binding.relativePath || !binding.transcript.trim()) return patch;
  return { ...patch, transcript: binding.transcript, transcriptInherited: false };
};

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

const EMPTY_BINDING: VoiceBinding = {
  canonId: "",
  relativePath: "",
  sha256: "",
  transcript: "",
  caption: "",
  leadingSilenceSec: "0",
  fileName: null,
  role: "voice_reference",
  characterIds: [],
  transcriptInherited: false,
  uploadedCharacterIds: [],
  roleTagError: null,
};

const STANDALONE_VOICE_ID = "standalone";

/** 読み検証の実施状況。`verified` 以外は一致可否を判定していない。 */
const STATUS_LABEL: Record<string, string> = {
  verified: "検証済み",
  skipped: "未検証",
  asr_failed: "ASR失敗",
  kana_unavailable: "正規化不可",
};

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message} (${error.code})`;
  }
  return String(error);
}

async function toBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

interface Props {
  projectId: string | null;
  sceneId: string | null;
  shotId: string | null;
  shot: ShotEnvelope | null;
  jobs: GenerationJob[];
  onSubmittedJob: (job: GenerationJob) => void;
  /** 作品制作の計画で開始済みのとき、この工程に割り当てたPreset。 */
  planPreset?: PlanPreset | null;
}

export function VoicePanel({
  projectId,
  sceneId,
  shotId,
  shot,
  jobs,
  onSubmittedJob,
  planPreset,
}: Props) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recipeId, setRecipeId] = useState("");
  const [useInheritedDefaults, setUseInheritedDefaults] = useState(false);
  usePlanPresetDefaults(planPreset, shotId, recipes, setRecipeId, setUseInheritedDefaults);
  const [canon, setCanon] = useState<CanonDescriptor[]>([]);
  // 読み込めないとキャラクターからCanonを自動で選べないため、画面に理由を出す。
  const [canonError, setCanonError] = useState<string | null>(null);
  // 登録済みの参照音声(voice_reference)の候補。取込・タグ付けのたびに引き直す。
  const [refCandidates, setRefCandidates] = useState<MediaItem[]>([]);
  const [refReload, setRefReload] = useState(0);
  const characters = useProjectCharacters(projectId);
  const [health, setHealth] = useState<VoiceBackendHealth | null>(null);
  const [bindings, setBindings] = useState<Record<string, VoiceBinding>>({});
  // 取り込み中の操作を完了時に上書きしないよう、非同期処理が最新の指定を読むために持つ。
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  // Shot・Projectを切り替えるたびに進める。取込の完了時に開始時と比べ、切替前に
  // 始めた取込を切替後の声へ入れない。
  const bindingsGeneration = useRef(0);
  const [seed, setSeed] = useState("-1");
  const [profile, setProfile] = useState("default");
  const [verifyWithAsr, setVerifyWithAsr] = useState(true);
  const [padToDuration, setPadToDuration] = useState(true);
  const [standaloneText, setStandaloneText] = useState("");
  const [standaloneDuration, setStandaloneDuration] = useState("5");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [verifications, setVerifications] = useState<VoiceVerification[]>([]);
  const [verificationsLoading, setVerificationsLoading] = useState(false);
  const [verificationsError, setVerificationsError] = useState<string | null>(
    null,
  );
  const [previewResult, setPreviewResult] = useState<GenerationPreview | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  // 読み検証は artifact_id だけを持つ。音声Jobの成果物は常に audio/wav で保存される
  // (voice executor の AUDIO_MEDIA_TYPE) ため、ビューア用の項目はここで組み立てる。
  const verificationViewerItems = useMemo<MediaViewerItem[]>(
    () =>
      verifications.map((item) => ({
        id: item.artifact_id,
        media_type: "audio/wav",
        availability: "complete",
      })),
    [verifications],
  );

  const dialogue = useMemo(() => shot?.data.dialogue ?? [], [shot]);
  const voiceIds = useMemo(
    () =>
      shotId
        ? [...new Set(dialogue.map((line) => line.voice_id))]
        : [STANDALONE_VOICE_ID],
    [dialogue, shotId],
  );
  const voiceJobs = useMemo(
    () => jobs.filter((job) => job.kind === "voice"),
    [jobs],
  );
  const transcriptRequired = REFERENCE_TRANSCRIPT_ENGINES.has(
    recipes.find((item) => item.id === recipeId)?.engine ?? "",
  );
  const selectedVoiceJob = useMemo(
    () => voiceJobs.find((item) => item.id === selectedJobId) ?? null,
    [voiceJobs, selectedJobId],
  );

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [list, status] = await Promise.all([
          api.listRecipes("voice"),
          api.getVoiceBackendHealth(),
        ]);
        if (!active) return;
        setRecipes(list);
        setHealth(status);
        if (list.length > 0) setRecipeId((current) => current || list[0].id);
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setCanonError(null);
    if (!projectId) {
      setCanon([]);
      return;
    }
    let active = true;
    (async () => {
      try {
        const list = await api.listCanon(projectId, "voice");
        if (active) setCanon(list.items);
      } catch (cause) {
        if (active) {
          setCanon([]);
          setCanonError(describe(cause));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      setRefCandidates([]);
      return;
    }
    let active = true;
    (async () => {
      try {
        // APIのlimit上限(200)で切れないよう、1ページに満たなくなるまで辿る。
        // 候補は複数の声で共有し、声ごとにキャラクターが違うため全件を持つ。
        const list: MediaItem[] = [];
        for (let offset = 0; ; offset += REFERENCE_PAGE_SIZE) {
          const page = await api.listMediaItems({
            projectId,
            role: "voice_reference",
            source: "registered_input",
            limit: REFERENCE_PAGE_SIZE,
            offset,
          });
          list.push(...page);
          // アンマウント後は残りのページを取りに行かない。
          if (!active || page.length < REFERENCE_PAGE_SIZE) break;
        }
        if (active) setRefCandidates(list);
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, refReload]);

  // Shot が変わったら指定をやり直す。別 Shot の参照音声を引き継がない。
  useEffect(() => {
    bindingsGeneration.current += 1;
    setBindings(
      Object.fromEntries(voiceIds.map((id) => [id, { ...EMPTY_BINDING }])),
    );
  }, [voiceIds]);

  // キャラクターはProject単位。別Projectの選択を持ち越すとAPIが422で弾くため、
  // MediaPickerと同じくProject切替時に選択を空へ戻す。取り込んだ参照音声は残す。
  // Voice CanonもProject単位のため、手で選んだCanonを空へ戻す。
  useEffect(() => {
    bindingsGeneration.current += 1;
    setBindings((current) =>
      Object.fromEntries(
        Object.entries(current).map(([id, binding]) => [
          id,
          { ...binding, characterIds: [], canonId: "" },
        ]),
      ),
    );
  }, [projectId]);

  // 候補の取得より先にキャラクターを選んだ声にも、取得後に参照音声を自動で入れる。
  // 参照音声を指定済みの声は触らない。
  useEffect(() => {
    setBindings((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).map(([id, binding]) => {
          if (binding.relativePath || binding.characterIds.length === 0) {
            return [id, binding];
          }
          const linked = refCandidates.filter((item) =>
            linkedToAny(item, binding.characterIds),
          );
          if (linked.length !== 1) return [id, binding];
          changed = true;
          return [id, { ...binding, ...autoFillPatch(binding, linked[0]) }];
        }),
      );
      return changed ? next : current;
    });
  }, [refCandidates]);

  // Job を素早く切り替えたとき、遅れて届いた前の Job の応答で表示を上書きしない。
  const verificationsSequence = useRef(0);

  const loadVerifications = useCallback(async (jobId: string) => {
    const sequence = ++verificationsSequence.current;
    setVerificationsLoading(true);
    setVerificationsError(null);
    try {
      const items = await api.listVoiceVerifications(jobId);
      if (sequence === verificationsSequence.current) setVerifications(items);
    } catch (cause) {
      if (sequence === verificationsSequence.current) {
        setVerificationsError(describe(cause));
      }
    } finally {
      if (sequence === verificationsSequence.current) {
        setVerificationsLoading(false);
      }
    }
  }, []);

  const clearVerifications = useCallback(() => {
    verificationsSequence.current += 1;
    setVerifications([]);
    setVerificationsError(null);
    setVerificationsLoading(false);
  }, []);

  // アンマウント後に応答が届いても表示を更新しない。
  useEffect(
    () => () => {
      verificationsSequence.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (!selectedJobId) {
      clearVerifications();
      return;
    }
    const job = voiceJobs.find((item) => item.id === selectedJobId);
    if (!job || job.state !== "succeeded") {
      clearVerifications();
      return;
    }
    void loadVerifications(selectedJobId);
  }, [selectedJobId, voiceJobs, loadVerifications, clearVerifications]);

  const update = (voiceId: string, patch: Partial<VoiceBinding>) => {
    setBindings((current) => ({
      ...current,
      [voiceId]: { ...(current[voiceId] ?? EMPTY_BINDING), ...patch },
    }));
  };

  const upload = async (voiceId: string, file: File) => {
    setError(null);
    update(voiceId, { roleTagError: null });
    const {
      role,
      characterIds,
      relativePath,
      transcript,
      transcriptInherited,
    } = bindings[voiceId] ?? EMPTY_BINDING;
    const generation = bindingsGeneration.current;
    // 登録済みの参照音声から自動で入った書き起こしは、別の録音である新しいwavへ
    // 登録しない。手で直した書き起こしだけを送る。
    const ownTranscript = transcriptInherited ? "" : transcript;
    try {
      const stored = await api.createVoiceReference(
        file.name,
        await toBase64(file),
      );
      const latest = bindingsRef.current[voiceId] ?? EMPTY_BINDING;
      // 取り込み中にShot・Project・キャラクター・参照音声の指定が変わったら、
      // 選び直した声へ入れない。
      const applies =
        generation === bindingsGeneration.current &&
        sameIds(latest.characterIds, characterIds) &&
        latest.relativePath === relativePath;
      // 取り込み中に書き起こしを手で編集していたら、その編集を残す。編集して開始時と
      // 同じ文面へ戻した場合も手入力として扱う。候補の再取得で自動入力された
      // 書き起こしは別の録音のものなので使わない。
      const finalTranscript =
        !applies || latest.transcriptInherited
          ? ownTranscript
          : latest.transcript;
      if (applies) {
        update(voiceId, {
          relativePath: stored.relative_path,
          sha256: stored.sha256,
          fileName: file.name,
          transcript: finalTranscript,
          transcriptInherited: false,
          uploadedCharacterIds: characterIds,
        });
      } else {
        // 役割タグは取り込みを始めた時点の指定で付ける。wavはその時点のキャラクターの
        // 参照音声として正しく、声へ入れないことだけを伝える。
        setError(
          role
            ? `「${file.name}」は取り込み中に${voiceId}のShot・Project・キャラクター・参照音声の指定が変わったため、${voiceId}には入れていません。取り込みを始めた時点のキャラクターの参照音声として登録します。`
            : `「${file.name}」は取り込み中に${voiceId}のShot・Project・キャラクター・参照音声の指定が変わったため、${voiceId}には入れていません。もう一度取り込んでください。`,
        );
      }
      if (!role) return;
      try {
        await api.upsertMediaRoleTag({
          relative_path: stored.relative_path,
          sha256: stored.sha256,
          file_name: file.name,
          byte_size: stored.byte_size,
          media_type: stored.media_type,
          role,
          character_ids: characterIds,
          // 空欄のときは送らず、登録済みの書き起こしを消さない。
          ...(role === "voice_reference" && finalTranscript.trim()
            ? { reference_transcript: finalTranscript }
            : {}),
          project_id: projectId ?? undefined,
          scene_id: sceneId ?? undefined,
        });
        setRefReload((count) => count + 1);
      } catch (cause) {
        // 取込は済んでいるため参照音声の指定は残し、役割が付かなかった声を示す。
        // 他の声の取込で消えないよう、全体のエラーでなくbindingに持たせる。
        update(voiceId, {
          roleTagError: `役割を付けられませんでした: ${describe(cause)}`,
        });
      }
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const selectRegisteredReference = (voiceId: string, key: string) => {
    const item = refCandidates.find((candidate) => candidate.key === key);
    if (item) update(voiceId, referencePatch(item));
  };

  // キャラクターIDとdisplay_nameが一致するVoice Canon。キャラクターを1人だけ選んだ
  // ときに使い、一致が無ければCanonを手で選ぶ (Issue #436)。同じdisplay_nameが複数
  // あると決められないため、自動では選ばない。
  const canonMatches = (characterIds: string[]) =>
    characterIds.length === 1
      ? canon.filter((item) => item.display_name === characterIds[0])
      : [];
  const matchedCanon = (characterIds: string[]) => {
    const matches = canonMatches(characterIds);
    return matches.length === 1 ? matches[0] : null;
  };

  // 手で選ぶプルダウンの表示。同じdisplay_nameが複数あると見分けられないため、
  // そのときはcanon_idを添える。
  const canonLabel = (item: CanonDescriptor) => {
    if (item.display_name === null) return item.canon_id;
    const sameName = canon.filter(
      (other) => other.display_name === item.display_name,
    );
    return sameName.length > 1
      ? `${item.display_name} (${item.canon_id})`
      : item.display_name;
  };

  // Canonを自動で選べない理由。手で選ぶプルダウンの前に出す。
  const canonHint = (characterIds: string[]): string | null => {
    if (characterIds.length > 1) {
      return "キャラクターを複数選んでいるため、Voice Canonは自動で選べません。手で選んでください。";
    }
    if (canonMatches(characterIds).length > 1) {
      return "同じ表示名のVoice Canonが複数あるため、自動で選べません。手で選んでください。";
    }
    return null;
  };

  // キャラクターを選ぶと、紐付いた登録済みの参照音声が1件だけならそれを入れる。
  // 別のキャラクターに紐付く登録済みの参照音声は外し、選んだのと違う声で作らない。
  const selectCharacters = (voiceId: string, characterIds: string[]) => {
    const binding = bindings[voiceId] ?? EMPTY_BINDING;
    const linked =
      characterIds.length > 0
        ? refCandidates.filter((item) => linkedToAny(item, characterIds))
        : [];
    if (linked.length === 1) {
      update(voiceId, { characterIds, ...autoFillPatch(binding, linked[0]) });
      return;
    }
    const current = refCandidates.find(
      (item) => item.relative_path === binding.relativePath,
    );
    // 登録の有無によらず、参照音声が結び付いたキャラクターで判定する。
    // 取り込んだだけで未登録のwavは、取り込んだ時点のキャラクターを使う。
    const ownCharacterIds =
      current !== undefined
        ? (current.character_ids ?? [])
        : binding.relativePath
          ? binding.uploadedCharacterIds
          : [];
    const stale =
      ownCharacterIds.length > 0 &&
      characterIds.length > 0 &&
      !ownCharacterIds.some((id) => characterIds.includes(id));
    update(voiceId, {
      characterIds,
      ...(stale
        ? {
            relativePath: "",
            sha256: "",
            fileName: null,
            transcript: "",
            transcriptInherited: false,
            uploadedCharacterIds: [],
          }
        : {}),
    });
  };

  const buildInputs = (): Record<string, unknown> | null => {
    if (useInheritedDefaults) return {};
    // 計画のPresetが決める入力は送られないため、未入力でも止めない。
    const fixed = planPresetKeys(
      planPreset,
      recipes.find((item) => item.id === recipeId),
      useInheritedDefaults,
    );
    const voices: Record<string, unknown> = {};
    for (const voiceId of fixed.has("voices") ? [] : voiceIds) {
      const binding = bindings[voiceId] ?? EMPTY_BINDING;
      const caption = binding.caption.trim();
      const matched = projectId ? matchedCanon(binding.characterIds) : null;
      // 一致するCanonがあるときプルダウンは出ないため、手で選んだ値は使わない。
      const manualCanonId = matched ? "" : binding.canonId;
      const canonId = matched?.canon_id ?? manualCanonId;
      if (!binding.relativePath || !binding.sha256) {
        if (!caption) {
          setError(
            `${voiceId}の参照音声を取り込むか、captionを入力してください。`,
          );
          return null;
        }
        if (projectId && manualCanonId) {
          // 選んだ Canon を黙って捨てると、Canon の声で作ったと取り違える。
          setError(
            `${voiceId}のVoice Canonは参照音声と組で使います。参照音声を取り込むか、Canonの選択を外してください。`,
          );
          return null;
        }
        // 参照音声を使わない声は Voice Canon と結び付けない。
        voices[voiceId] = { caption };
        continue;
      }
      if (projectId && !canonId) {
        setError(
          canonError
            ? `${voiceId}のVoice Canonを選べません。Voice Canonの読み込みに失敗しました (${canonError})。画面を再読み込みしてください。`
            : `${voiceId}のVoice Canonを選んでください。`,
        );
        return null;
      }
      if (transcriptRequired && !binding.transcript.trim()) {
        // 嘘の参照テキストを渡すと生成が破綻するため、空のまま送らない。
        setError(`${voiceId}の参照テキストを入力してください。`);
        return null;
      }
      const leading = Number.parseFloat(binding.leadingSilenceSec || "0");
      if (!Number.isFinite(leading) || leading < 0) {
        setError(`${voiceId}の先頭無音は0以上の数値で入力してください。`);
        return null;
      }
      voices[voiceId] = {
        ...(canonId ? { canon_id: canonId } : {}),
        reference_relative_path: binding.relativePath,
        // Voice Canon の source_sha256 と突き合わせる値。取り込んだファイルの
        // 内容 hash をそのまま使う。実行前に実ファイルと照合される。
        reference_sha256: binding.sha256,
        ...(binding.transcript.trim()
          ? { reference_transcript: binding.transcript }
          : {}),
        leading_silence_sec: leading,
        ...(caption ? { caption } : {}),
      };
    }
    const parsedSeed = Number.parseInt(seed || "-1", 10);
    if (!fixed.has("seed") && !Number.isFinite(parsedSeed)) {
      setError("seedは整数で入力してください。");
      return null;
    }
    const standalone = !shotId;
    const duration = Number.parseFloat(standaloneDuration);
    if (standalone && !fixed.has("dialogue") && !standaloneText.trim()) {
      setError("読む台詞を入力してください。");
      return null;
    }
    if (
      standalone &&
      !fixed.has("duration_sec") &&
      (!Number.isFinite(duration) || duration < 1 || duration > 15)
    ) {
      setError("目標尺は1秒以上15秒以下で入力してください。");
      return null;
    }
    return {
      profile,
      seed: parsedSeed,
      verify_with_asr: verifyWithAsr,
      pad_to_duration: padToDuration,
      voices,
      ...(standalone
        ? {
            dialogue: [
              {
                speaker: null,
                voice_id: STANDALONE_VOICE_ID,
                text: standaloneText.trim(),
                reading: null,
                start_sec: 0,
              },
            ],
            duration_sec: duration,
          }
        : {}),
    };
  };

  const submit = async () => {
    const recipe = recipes.find((item) => item.id === recipeId);
    if (!recipe && !useInheritedDefaults) return;
    const inputs = buildInputs();
    if (!inputs) return;

    setSubmitting(true);
    setError(null);
    try {
      const job = await api.createJob({
        kind: "voice",
        project_id: projectId,
        scene_id: sceneId,
        shot_id: shotId,
        recipe_id: recipe?.id,
        use_inherited_defaults: useInheritedDefaults,
        ...applyPlanPreset(planPreset, recipe, useInheritedDefaults, inputs),
      });
      setSelectedJobId(job.id);
      onSubmittedJob(job);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const runPreview = async () => {
    const recipe = recipes.find((item) => item.id === recipeId);
    if (!recipe && !useInheritedDefaults) return;
    const inputs = buildInputs();
    if (!inputs) return;

    setPreviewing(true);
    setError(null);
    try {
      const preview = await api.previewJob({
        kind: "voice",
        project_id: projectId,
        scene_id: sceneId,
        shot_id: shotId,
        recipe_id: recipe?.id,
        use_inherited_defaults: useInheritedDefaults,
        ...applyPlanPreset(planPreset, recipe, useInheritedDefaults, inputs),
      });
      setPreviewResult(preview);
      setPreviewError(null);
    } catch (cause) {
      if (cause instanceof ApiError) {
        setPreviewError(cause);
        setPreviewResult(null);
      } else {
        setError(describe(cause));
      }
    } finally {
      setPreviewing(false);
    }
  };

  const engineOf = (id: string) =>
    recipes.find((item) => item.id === id)?.engine ?? null;
  const engineHealth = health?.engines?.find(
    (item) => item.id === engineOf(recipeId),
  );

  return (
    <section className="panel">
      <h2>音声生成</h2>

      <p className="muted">
        {health === null
          ? "Backendの状態を確認中。"
          : health.reachable
            ? `voice-runner: ${health.base_url}`
            : `voice-runnerへ接続できません: ${health.reason ?? "理由不明"}`}
        {engineHealth && !engineHealth.available
          ? ` / ${engineHealth.id}は実行できません (${engineHealth.detail ?? "理由不明"})`
          : ""}
      </p>

      {voiceIds.length === 0 ? (
        <p className="muted">
          選んだShotに台詞がありません。音声Jobは投入できません。
        </p>
      ) : (
        <div className="stack">
          <button
            type="button"
            disabled={!projectId}
            aria-pressed={useInheritedDefaults}
            className={useInheritedDefaults ? "primary" : undefined}
            onClick={() => setUseInheritedDefaults((value) => !value)}
          >
            {useInheritedDefaults ? "Project既定値を使用中" : "Project既定値へ戻す"}
          </button>
          <div>
            <label htmlFor="voice-recipe">Backend</label>
            <select
              id="voice-recipe"
              value={recipeId}
              disabled={useInheritedDefaults}
              onChange={(event) => setRecipeId(event.target.value)}
            >
              {recipes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <PlanPresetNote
            preset={planPreset}
            blocker={planPreset ? planPresetBlocker(planPreset, recipes.find((item) => item.id === recipeId), useInheritedDefaults) : null}
          />

          {!shotId ? (
            <div className="stack">
              <label htmlFor="voice-standalone-text">読む台詞</label>
              <textarea
                id="voice-standalone-text"
                value={standaloneText}
                onChange={(event) => setStandaloneText(event.target.value)}
              />
              <label htmlFor="voice-standalone-duration">目標尺（秒）</label>
              <input
                id="voice-standalone-duration"
                type="number"
                min="1"
                max="15"
                step="0.1"
                value={standaloneDuration}
                onChange={(event) => setStandaloneDuration(event.target.value)}
              />
            </div>
          ) : (
            <>
              <h3 className="muted">台詞</h3>
              <ul className="list plain">
                {dialogue.map((line, index) => (
                  <li key={`${line.voice_id}-${index}`}>
                    <span className="row">
                      <strong>{line.speaker}</strong>
                      <span className="muted">{line.voice_id}</span>
                      {line.start_sec !== null &&
                        line.start_sec !== undefined && (
                          <span className="muted">{line.start_sec}秒〜</span>
                        )}
                    </span>
                    <span>{line.text}</span>
                    <span className="muted">
                      {line.reading
                        ? `読み: ${line.reading}`
                        : "読みの指定なし"}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3 className="muted">
            {projectId
              ? "Voice Canon・参照音声・caption"
              : "参照音声・caption"}
          </h3>
          {voiceIds.map((voiceId) => {
            const binding = bindings[voiceId] ?? EMPTY_BINDING;
            const matched = projectId
              ? matchedCanon(binding.characterIds)
              : null;
            return (
              <div key={voiceId} className="stack">
                <label htmlFor={`reference-${voiceId}`}>{voiceId}</label>
                <MediaRoleTagFields
                  kind="audio"
                  role={binding.role}
                  onRoleChange={(role) => update(voiceId, { role })}
                  characters={characters}
                  characterIds={binding.characterIds}
                  onCharacterIdsChange={(characterIds) =>
                    selectCharacters(voiceId, characterIds)
                  }
                />
                {matched && (
                  <p className="muted">
                    Voice Canon: {matched.display_name} (キャラクターから自動)
                  </p>
                )}
                {projectId && canonError && (
                  <p className="error">
                    Voice Canonを読み込めなかったため、キャラクターから自動で選べません: {canonError}
                  </p>
                )}
                {projectId && !matched && !canonError && canonHint(binding.characterIds) && (
                  <p className="muted">{canonHint(binding.characterIds)}</p>
                )}
                {projectId && !matched && (
                  <select
                    id={`canon-${voiceId}`}
                    value={binding.canonId}
                    onChange={(event) =>
                      update(voiceId, { canonId: event.target.value })
                    }
                  >
                    <option value="">Voice Canonを選ぶ</option>
                    {canon.map((item) => (
                      <option key={item.canon_id} value={item.canon_id}>
                        {canonLabel(item)}
                      </option>
                    ))}
                  </select>
                )}
                {projectId && (
                  <select
                    aria-label={`${voiceId}の登録済みの参照音声`}
                    value={
                      refCandidates.find(
                        (item) =>
                          item.relative_path === binding.relativePath &&
                          linkedToAny(item, binding.characterIds),
                      )?.key ?? ""
                    }
                    onChange={(event) =>
                      selectRegisteredReference(voiceId, event.target.value)
                    }
                  >
                    <option value="">登録済みの参照音声を選ぶ</option>
                    {refCandidates
                      .filter((item) => linkedToAny(item, binding.characterIds))
                      .map((item) => (
                        <option key={item.key} value={item.key}>
                          {item.label ?? item.relative_path}
                        </option>
                      ))}
                  </select>
                )}
                <input
                  id={`reference-${voiceId}`}
                  type="file"
                  accept="audio/wav"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void upload(voiceId, file);
                  }}
                />
                <p className="muted mono">
                  {binding.fileName
                    ? `${binding.fileName} / sha256=${binding.sha256}`
                    : projectId
                      ? "参照音声は未取り込み。Voice Canonのsource_sha256と一致するwavを選ぶ。captionだけで作るならVoice Canonは不要。"
                      : "参照音声は未取り込み。話者の特徴が分かるwavを選ぶか、captionだけで作る。"}
                </p>
                {binding.roleTagError && (
                  <p className="error">{binding.roleTagError}</p>
                )}
                <textarea
                  aria-label={`${voiceId}の参照テキスト`}
                  placeholder={
                    transcriptRequired
                      ? "参照音声の書き起こし"
                      : "参照音声の書き起こし (任意。このengineは生成に使わない)"
                  }
                  value={binding.transcript}
                  onChange={(event) =>
                    update(voiceId, {
                      transcript: event.target.value,
                      transcriptInherited: false,
                    })
                  }
                />
                <input
                  aria-label={`${voiceId}のcaption`}
                  placeholder="caption (例: 落ち着いた若い女性の声)"
                  value={binding.caption}
                  onChange={(event) =>
                    update(voiceId, { caption: event.target.value })
                  }
                />
                <label htmlFor={`silence-${voiceId}`}>
                  先頭無音 (秒)。0.5秒以上なら渡す前に切る。
                </label>
                <input
                  id={`silence-${voiceId}`}
                  type="number"
                  step="0.01"
                  value={binding.leadingSilenceSec}
                  onChange={(event) =>
                    update(voiceId, { leadingSilenceSec: event.target.value })
                  }
                />
              </div>
            );
          })}

          <div className="row">
            <div>
              <label htmlFor="voice-profile">プロファイル</label>
              <input
                id="voice-profile"
                value={profile}
                onChange={(event) => setProfile(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="voice-seed">seed (-1で自動採番)</label>
              <input
                id="voice-seed"
                type="number"
                value={seed}
                onChange={(event) => setSeed(event.target.value)}
              />
            </div>
          </div>

          <label htmlFor="voice-verify">
            <input
              id="voice-verify"
              type="checkbox"
              checked={verifyWithAsr}
              onChange={(event) => setVerifyWithAsr(event.target.checked)}
            />
            ASRで読みを検証する
          </label>
          <label htmlFor="voice-pad">
            <input
              id="voice-pad"
              type="checkbox"
              checked={padToDuration}
              onChange={(event) => setPadToDuration(event.target.checked)}
            />
            {shotId ? "Shotの尺" : "目標尺"}へ無音パディングする
          </label>

          {error && <p className="error">{error}</p>}

          <div>
            <button
              type="button"
              disabled={submitting || previewing || (!recipeId && !useInheritedDefaults)}
              onClick={runPreview}
            >
              {previewing ? "確認中..." : "投入前に確認"}
            </button>
            <button
              type="button"
              className="primary"
              disabled={submitting || previewing || (!recipeId && !useInheritedDefaults)}
              onClick={submit}
            >
              {submitting ? "投入中..." : "音声生成を投入"}
            </button>
          </div>
          <ExecutionPreview
            preview={previewResult}
            error={previewError}
            loading={previewing}
          />
        </div>
      )}

      <h3 className="muted">読み検証</h3>
      <div>
        <label htmlFor="voice-job">音声Job</label>
        <select
          id="voice-job"
          value={selectedJobId ?? ""}
          onChange={(event) => setSelectedJobId(event.target.value || null)}
        >
          <option value="">Jobを選ぶ</option>
          {voiceJobs.map((job) => (
            <option key={job.id} value={job.id}>
              {`順番${job.queue_sequence} / ${job.state}`}
            </option>
          ))}
        </select>
      </div>

      {verificationsLoading ? (
        <EmptyState title="読み検証を取得しています…" />
      ) : verificationsError ? (
        <EmptyState
          title="読み検証の取得に失敗しました。"
          description={verificationsError}
          action={
            <button
              type="button"
              onClick={() => selectedJobId && void loadVerifications(selectedJobId)}
            >
              再試行
            </button>
          }
        />
      ) : !selectedJobId ? (
        <EmptyState
          title="成功した音声Jobを選ぶと、台詞ごとの読み検証と尺を表示する。"
          action={
            <button
              type="button"
              onClick={() => document.getElementById("voice-job")?.focus()}
            >
              音声Jobを選ぶ
            </button>
          }
        />
      ) : selectedVoiceJob?.state !== "succeeded" ? (
        <EmptyState title="選択した音声Jobはまだ完了していません。完了すると読み検証と尺を表示する。" />
      ) : verifications.length === 0 ? (
        <EmptyState title="この音声Jobには読み検証がありません。" />
      ) : (
        <ul className="list plain">
          {verifications.map((item) => (
            <li
              key={item.id}
              className={item.match === false ? "current" : undefined}
            >
              <span className="row">
                <span className="muted">#{item.dialogue_index}</span>
                <span
                  className={`badge ${item.match === true ? "succeeded" : item.match === false ? "failed" : "queued"}`}
                >
                  {item.match === true
                    ? "一致"
                    : item.match === false
                      ? "不一致"
                      : (STATUS_LABEL[item.status] ?? item.status)}
                </span>
                {item.expected_reading === null && item.match === false && (
                  <span className="badge cancelled">読みの追記候補</span>
                )}
                {item.audio_sec > item.target_duration_sec && (
                  <span className="badge cancelled">尺超過</span>
                )}
              </span>
              <audio
                controls
                preload="none"
                src={api.artifactContentUrl(item.artifact_id)}
              />
              <IconButton
                icon={<Icon name="expand" />}
                label="拡大"
                onClick={() =>
                  setViewerIndex(
                    verifications.findIndex((entry) => entry.id === item.id),
                  )
                }
              />
              <span>期待: {item.expected_text}</span>
              <span className="muted">
                {item.expected_reading
                  ? `期待読み: ${item.expected_reading}`
                  : "期待読み: 指定なし (textから正規化)"}
              </span>
              <span className="muted">ASR: {item.asr_text ?? "—"}</span>
              <span className="mono">
                {item.normalized_expected ?? "—"} / {item.normalized_asr ?? "—"}
              </span>
              <span className="muted">
                {`尺 ${item.audio_sec}秒 → パディング後 ${item.padded_sec}秒 / Shot ${item.target_duration_sec}秒`}
                {item.diff_ratio !== null && item.diff_ratio !== undefined
                  ? ` / 差分率 ${item.diff_ratio}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <MediaViewer
        items={verificationViewerItems}
        index={viewerIndex}
        onIndexChange={setViewerIndex}
        onClose={() => setViewerIndex(null)}
      />
    </section>
  );
}
