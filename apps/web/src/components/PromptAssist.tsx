import { useState } from "react";

import { api } from "../api/client";
import type { AgentProvider, AgentProviderId } from "../api/client";
import { noticeSuffix } from "./BackendNotice";

interface Props {
  /** 選択肢として出す AI プロバイダ。取得は呼び出し元が行う。 */
  providers: AgentProvider[];
  /** 説明欄と補完ボタンに付ける id の接頭辞。同一画面での重複を避ける。 */
  idPrefix: string;
  placeholder?: string;
  /** 補完結果の反映。呼び出し元の prompt と negative へ入れる。 */
  onApply: (result: { positive: string; negative: string }) => void;
}

/** 日本語の説明から positive prompt と negative prompt を AI に補完させる入力欄。 */
export function PromptAssist({ providers, idPrefix, placeholder, onApply }: Props) {
  const [description, setDescription] = useState("");
  const [providerId, setProviderId] = useState<AgentProviderId | "">("");
  const [assisting, setAssisting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assist = async () => {
    if (!description.trim()) {
      setError("画像の説明を入力してください。");
      return;
    }
    setAssisting(true);
    setError(null);
    try {
      const result = await api.assistImagePrompt({
        instruction: description,
        provider_id: providerId || null,
      });
      onApply({ positive: result.positive_prompt, negative: result.negative_prompt });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAssisting(false);
    }
  };

  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-description`}>画像の説明</label>
        <textarea
          id={`${idPrefix}-description`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={placeholder}
        />
        <p className="muted">日本語で説明するとAIがPromptとNegativeを補完します。</p>
      </div>
      <div className="row">
        <label htmlFor={`${idPrefix}-provider`}>AI</label>
        <select
          id={`${idPrefix}-provider`}
          value={providerId}
          onChange={(event) => setProviderId(event.target.value as AgentProviderId | "")}
        >
          <option value="">既定のAI</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id} disabled={!provider.available}>
              {provider.label}{provider.available ? "" : " (利用不可)"}
              {noticeSuffix(provider)}
            </option>
          ))}
        </select>
        <button type="button" disabled={assisting} onClick={() => void assist()}>
          {assisting ? "補完中..." : "Promptを補完"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </>
  );
}
