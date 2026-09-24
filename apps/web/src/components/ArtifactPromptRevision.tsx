import { useEffect, useState } from "react";

import { ApiError, api } from "../api/client";
import type { AgentProvider, AgentProviderId, GenerationJob, GenerationPromptRevision } from "../api/client";
import { describeApiError } from "../derivation/recipeTemplate";
import { useNotify } from "./ui/notify";

interface Props {
  artifactId: string;
  jobId: string;
  /** 直した結果を新しいJobとして投入できたときに、呼び出し元へ渡す。 */
  onRevisedJob: (job: GenerationJob) => void;
}

/**
 * 生成済み画像を見せて、日本語の指示でpositive/negative promptをAIに直させ、
 * 直した結果をそのまま新しいJobとして投入する (#303)。
 */
export function ArtifactPromptRevision({ artifactId, jobId, onRevisedJob }: Props) {
  const notify = useNotify();
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  const [instruction, setInstruction] = useState("");
  const [providerId, setProviderId] = useState<AgentProviderId | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerationPromptRevision | null>(null);

  useEffect(() => {
    void api
      .listAgentProviders()
      .then((items) => setProviders(items.filter((provider) => provider.supports_images)))
      .catch(() => setProviders([]));
  }, []);

  const execute = async () => {
    if (!instruction.trim()) {
      setError("直したい点を入力してください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const revision = await api.revisePrompt(jobId, {
        artifact_id: artifactId,
        instruction,
        provider_id: providerId || null,
      });
      setResult(revision);
      onRevisedJob(revision.job);
      notify({ tone: "success", message: "直したプロンプトで新しいJobを投入しました。" });
    } catch (cause) {
      setError(cause instanceof ApiError ? describeApiError(cause) : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <h3>この画像を見てプロンプトを直す</h3>
      <label htmlFor="prompt-revision-instruction">直したい点</label>
      <textarea
        id="prompt-revision-instruction"
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        placeholder="例: 髪がはねすぎ。もっと引いた構図に。"
        disabled={busy}
      />
      <div className="row">
        <label htmlFor="prompt-revision-provider">AI</label>
        <select
          id="prompt-revision-provider"
          value={providerId}
          onChange={(event) => setProviderId(event.target.value as AgentProviderId | "")}
          disabled={busy}
        >
          <option value="">既定のAI</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id} disabled={!provider.available}>
              {provider.label}{provider.available ? "" : " (利用不可)"}
            </option>
          ))}
        </select>
        <button type="button" disabled={busy} onClick={() => void execute()}>
          {busy ? "実行中..." : "画像を見て直す"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {result && (
        <dl className="kv">
          <dt>直した理由</dt>
          <dd>{result.prompt.rationale}</dd>
          <dt>プロンプト</dt>
          <dd>{result.prompt.positive_prompt}</dd>
          <dt>ネガティブプロンプト</dt>
          <dd>{result.prompt.negative_prompt}</dd>
          <dt>新しいJob</dt>
          <dd className="mono">{result.job.id}</dd>
        </dl>
      )}
    </div>
  );
}
