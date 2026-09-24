import { useState } from "react";

import { api } from "../api/client";
import type { AgentProvider, AgentProviderId } from "../api/client";
import { noticeSuffix } from "./BackendNotice";
import { MediaPicker, readPickedImage } from "./MediaPicker";
import type { PickedMedia } from "./MediaPicker";

interface Props {
  /** 選択肢として出す AI プロバイダ。取得は呼び出し元が行う。 */
  providers: AgentProvider[];
  /** 説明欄と補完ボタンに付ける id の接頭辞。同一画面での重複を避ける。 */
  idPrefix: string;
  placeholder?: string;
  /** 画像を添付したときに、AI が直す土台として渡す現在の prompt と negative。 */
  current: { positive: string; negative: string };
  /** 画像欄で生成物・登録素材を選ぶときの絞り込みに使う。 */
  projectId?: string | null;
  /** 選択中の Recipe。Workflow に応じて、タグと自然文を併用するかタグだけで組むかを API が決める。 */
  recipeId?: string | null;
  /** 補完結果の反映。呼び出し元の prompt と negative へ入れる。 */
  onApply: (result: { positive: string; negative: string }) => void;
}

/**
 * 日本語の説明から positive prompt と negative prompt を AI に補完させる入力欄。
 * 画像を添えると、画像と現在の prompt を突き合わせて直した案を返す。
 */
export function PromptAssist({ current, recipeId, onApply, ...rest }: Props) {
  return (
    <PromptAssistField
      {...rest}
      subject="画像の説明"
      outputLabel="プロンプトとネガティブプロンプト"
      submitLabel="プロンプトを補完"
      allowImage
      onAssist={async ({ image, ...request }) => {
        const result = await api.assistImagePrompt({
          ...request,
          recipe_id: recipeId || null,
          ...(image && {
            image,
            current_positive_prompt: current.positive,
            current_negative_prompt: current.negative,
          }),
        });
        onApply({ positive: result.positive_prompt, negative: result.negative_prompt });
      }}
    />
  );
}

/** 補完欄が呼び出し元へ渡す要求。`image` は画像を添付したときだけ入り、`allowImage` が偽なら常に `null`。 */
export interface AssistRequest {
  instruction: string;
  provider_id: AgentProviderId | null;
  image: { content_base64: string; media_type: string } | null;
}

interface FieldProps {
  providers: AgentProvider[];
  idPrefix: string;
  placeholder?: string;
  /** 説明欄の見出し。例: 「動画の説明」。 */
  subject: string;
  /** AI が補完する項目の名前。説明文に使う。例: 「Prompt」。 */
  outputLabel: string;
  submitLabel: string;
  /** 画像を添えて直せるようにするか。真のときだけ画像欄を出す。 */
  allowImage?: boolean;
  projectId?: string | null;
  /** API を呼んで結果を反映する。失敗は例外で返すと欄の下に表示する。 */
  onAssist: (request: AssistRequest) => Promise<void>;
}

/** 日本語の説明から、媒体ごとの生成条件を AI に補完させる入力欄。 */
export function PromptAssistField({
  providers,
  idPrefix,
  placeholder,
  subject,
  outputLabel,
  submitLabel,
  allowImage = false,
  projectId,
  onAssist,
}: FieldProps) {
  const [description, setDescription] = useState("");
  const [providerId, setProviderId] = useState<AgentProviderId | "">("");
  const [images, setImages] = useState<PickedMedia[]>([]);
  const [assisting, setAssisting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const withImage = allowImage && images.length > 0;
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const defaultProvider = providers.find((provider) => provider.is_default);
  // 「既定のAI」のままなら、要求を受けるのは設定の既定Provider。
  const effectiveProvider = providerId ? selectedProvider : defaultProvider;
  const imageUnsupported = withImage && effectiveProvider?.supports_images === false;

  const assist = async () => {
    if (!description.trim()) {
      setError(withImage ? "直したい点を入力してください。" : `${subject}を入力してください。`);
      return;
    }
    if (imageUnsupported) return;
    setAssisting(true);
    setError(null);
    try {
      const image = withImage ? await readPickedImage(images[0]) : null;
      await onAssist({
        instruction: description,
        provider_id: providerId || null,
        image: image && { content_base64: image.base64, media_type: image.mediaType },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAssisting(false);
    }
  };

  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-description`}>
          {withImage ? "直したい点" : subject}
        </label>
        <textarea
          id={`${idPrefix}-description`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={withImage ? "例: 髪がはねすぎ。もっと引いた構図に。" : placeholder}
        />
        <p className="muted">
          {withImage
            ? `画像と現在のプロンプトを見比べて、AIが直した${outputLabel}を差分で示します。`
            : `日本語で説明するとAIが${outputLabel}を補完します。`}
        </p>
      </div>
      {allowImage && (
        <MediaPicker
          kind="image"
          label="見せる画像 (任意)"
          value={images}
          onChange={(next) => {
            setImages(next);
            setError(null);
          }}
          multiple={false}
          disabled={assisting}
          projectId={projectId}
          autoRegister={false}
        />
      )}
      <div className="row">
        <label htmlFor={`${idPrefix}-provider`}>AI</label>
        <select
          id={`${idPrefix}-provider`}
          value={providerId}
          onChange={(event) => setProviderId(event.target.value as AgentProviderId | "")}
        >
          <option value="">
            既定のAI
            {withImage && defaultProvider?.supports_images === false ? " (画像非対応)" : ""}
          </option>
          {providers.map((provider) => (
            <option
              key={provider.id}
              value={provider.id}
              disabled={!provider.available || (withImage && !provider.supports_images)}
            >
              {provider.label}{provider.available ? "" : " (利用不可)"}
              {withImage && !provider.supports_images ? " (画像非対応)" : ""}
              {noticeSuffix(provider)}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={assisting || imageUnsupported}
          onClick={() => void assist()}
        >
          {assisting ? "補完中..." : withImage ? "画像を見て直す" : submitLabel}
        </button>
      </div>
      {imageUnsupported && (
        <p className="error">
          {effectiveProvider?.label}は画像の入力に対応していません。画像に対応するAIを選んでください。
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
