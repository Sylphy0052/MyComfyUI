import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  GenerationJob,
  GenerationPreview,
  Recipe,
  VoiceBackendHealth,
  VoiceVerification,
} from "../api/client";
import type { CanonDescriptor, ShotEnvelope } from "../api/aimedia";
import { ExecutionPreview } from "./ExecutionPreview";

/** 1 つの voice_id に対する Voice Canon と参照音声の指定。 */
interface VoiceBinding {
  canonId: string;
  relativePath: string;
  sha256: string;
  transcript: string;
  leadingSilenceSec: string;
  /** 取り込んだファイルの表示名。指定済みかどうかの目印にする。 */
  fileName: string | null;
}

const EMPTY_BINDING: VoiceBinding = {
  canonId: "",
  relativePath: "",
  sha256: "",
  transcript: "",
  leadingSilenceSec: "0",
  fileName: null,
};

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
}

export function VoicePanel({
  projectId,
  sceneId,
  shotId,
  shot,
  jobs,
  onSubmittedJob,
}: Props) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recipeId, setRecipeId] = useState("");
  const [canon, setCanon] = useState<CanonDescriptor[]>([]);
  const [health, setHealth] = useState<VoiceBackendHealth | null>(null);
  const [bindings, setBindings] = useState<Record<string, VoiceBinding>>({});
  const [seed, setSeed] = useState("-1");
  const [profile, setProfile] = useState("default");
  const [verifyWithAsr, setVerifyWithAsr] = useState(true);
  const [padToDuration, setPadToDuration] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [verifications, setVerifications] = useState<VoiceVerification[]>([]);
  const [previewResult, setPreviewResult] = useState<GenerationPreview | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const dialogue = useMemo(() => shot?.data.dialogue ?? [], [shot]);
  const voiceIds = useMemo(
    () => [...new Set(dialogue.map((line) => line.voice_id))],
    [dialogue],
  );
  const voiceJobs = useMemo(
    () => jobs.filter((job) => job.kind === "voice"),
    [jobs],
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
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId]);

  // Shot が変わったら指定をやり直す。別 Shot の参照音声を引き継がない。
  useEffect(() => {
    setBindings(
      Object.fromEntries(voiceIds.map((id) => [id, { ...EMPTY_BINDING }])),
    );
  }, [voiceIds]);

  const loadVerifications = useCallback(async (jobId: string) => {
    try {
      setVerifications(await api.listVoiceVerifications(jobId));
    } catch (cause) {
      setError(describe(cause));
    }
  }, []);

  useEffect(() => {
    if (!selectedJobId) {
      setVerifications([]);
      return;
    }
    const job = voiceJobs.find((item) => item.id === selectedJobId);
    if (!job || job.state !== "succeeded") {
      setVerifications([]);
      return;
    }
    void loadVerifications(selectedJobId);
  }, [selectedJobId, voiceJobs, loadVerifications]);

  const update = (voiceId: string, patch: Partial<VoiceBinding>) => {
    setBindings((current) => ({
      ...current,
      [voiceId]: { ...(current[voiceId] ?? EMPTY_BINDING), ...patch },
    }));
  };

  const upload = async (voiceId: string, file: File) => {
    setError(null);
    try {
      const stored = await api.createVoiceReference(
        file.name,
        await toBase64(file),
      );
      update(voiceId, {
        relativePath: stored.relative_path,
        sha256: stored.sha256,
        fileName: file.name,
      });
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const buildInputs = (): Record<string, unknown> | null => {
    const voices: Record<string, unknown> = {};
    for (const voiceId of voiceIds) {
      const binding = bindings[voiceId] ?? EMPTY_BINDING;
      if (!binding.canonId) {
        // どの Voice Canon で生成したかを残さない Job は作らない。
        setError(`${voiceId}のVoice Canonを選んでください。`);
        return null;
      }
      if (!binding.relativePath || !binding.sha256) {
        setError(`${voiceId}の参照音声を取り込んでください。`);
        return null;
      }
      if (!binding.transcript.trim()) {
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
        canon_id: binding.canonId,
        reference_relative_path: binding.relativePath,
        // Voice Canon の source_sha256 と突き合わせる値。取り込んだファイルの
        // 内容 hash をそのまま使う。実行前に実ファイルと照合される。
        reference_sha256: binding.sha256,
        reference_transcript: binding.transcript,
        leading_silence_sec: leading,
      };
    }
    const parsedSeed = Number.parseInt(seed || "-1", 10);
    if (!Number.isFinite(parsedSeed)) {
      setError("seedは整数で入力してください。");
      return null;
    }
    return {
      profile,
      seed: parsedSeed,
      verify_with_asr: verifyWithAsr,
      pad_to_duration: padToDuration,
      voices,
    };
  };

  const submit = async () => {
    if (!projectId || !sceneId || !shotId) return;
    const recipe = recipes.find((item) => item.id === recipeId);
    if (!recipe) return;
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
        recipe_id: recipe.id,
        inputs,
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
    if (!projectId || !sceneId || !shotId) return;
    const recipe = recipes.find((item) => item.id === recipeId);
    if (!recipe) return;
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
        recipe_id: recipe.id,
        inputs,
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

      {dialogue.length === 0 ? (
        <p className="muted">
          選んだShotに台詞がありません。音声Jobは投入できません。
        </p>
      ) : (
        <div className="stack">
          <div>
            <label htmlFor="voice-recipe">Backend</label>
            <select
              id="voice-recipe"
              value={recipeId}
              onChange={(event) => setRecipeId(event.target.value)}
            >
              {recipes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>

          <h3 className="muted">台詞</h3>
          <ul className="list plain">
            {dialogue.map((line, index) => (
              <li key={`${line.voice_id}-${index}`}>
                <span className="row">
                  <strong>{line.speaker}</strong>
                  <span className="muted">{line.voice_id}</span>
                  {line.start_sec !== null && line.start_sec !== undefined && (
                    <span className="muted">{line.start_sec}秒〜</span>
                  )}
                </span>
                <span>{line.text}</span>
                <span className="muted">
                  {line.reading ? `読み: ${line.reading}` : "読みの指定なし"}
                </span>
              </li>
            ))}
          </ul>

          <h3 className="muted">Voice Canonと参照音声</h3>
          {voiceIds.map((voiceId) => {
            const binding = bindings[voiceId] ?? EMPTY_BINDING;
            return (
              <div key={voiceId} className="stack">
                <label htmlFor={`canon-${voiceId}`}>{voiceId}</label>
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
                      {item.display_name ?? item.canon_id}
                    </option>
                  ))}
                </select>
                <input
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
                    : "参照音声は未取り込み。Voice Canonのsource_sha256と一致するwavを選ぶ。"}
                </p>
                <textarea
                  aria-label={`${voiceId}の参照テキスト`}
                  placeholder="参照音声の書き起こし (Voice Canonのtranscript)"
                  value={binding.transcript}
                  onChange={(event) =>
                    update(voiceId, { transcript: event.target.value })
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
            Shotの尺へ無音パディングする
          </label>

          {error && <p className="error">{error}</p>}

          <div>
            <button
              type="button"
              disabled={submitting || previewing || !shotId || !recipeId}
              onClick={runPreview}
            >
              {previewing ? "確認中..." : "投入前に確認"}
            </button>
            <button
              type="button"
              className="primary"
              disabled={submitting || !shotId || !recipeId}
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

      {verifications.length === 0 ? (
        <p className="muted">
          成功した音声Jobを選ぶと、台詞ごとの読み検証と尺を表示する。
        </p>
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
    </section>
  );
}
