import { useEffect, useState } from "react";

import { api } from "../api/client";
import { draftString, readFormDraft, writeFormDraft } from "../state/formDraft";
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
  /** 指定すると説明文を下書きとして保存し、作り直しや再読み込みの後も残す (#327)。 */
  draftKey?: string;
  /**
   * 補完結果の反映。呼び出し元の prompt と negative へ入れる。
   * `notes` は AI の説明とタグ訳で、差分の確認中にも見せられるよう呼び出し元へ渡す (#354)。
   */
  onApply: (result: { positive: string; negative: string; notes: AssistResult }) => void;
}

/** 方向を書かずにレビューさせたときに送る指示。 */
const DEFAULT_REVIEW_DIRECTION = "重複・矛盾・不要なタグを整理する。";

/** レビューの方向の前に付ける固定文。 */
const REVIEW_INSTRUCTION_PREFIX =
  "現在のプロンプトをレビューして直す。指示の点だけを直し、関係の無いタグや文は残す。\n指示: ";

/** API の `instruction` の上限。 */
const MAX_INSTRUCTION_LENGTH = 2000;

/** 固定文を付けても API の上限を超えない、レビューの方向の上限。 */
const MAX_REVIEW_DIRECTION_LENGTH = MAX_INSTRUCTION_LENGTH - REVIEW_INSTRUCTION_PREFIX.length;

/** レビューの方向を、現在の prompt を土台に直させる指示へ組み立てる。 */
function reviewInstruction(direction: string): string {
  return REVIEW_INSTRUCTION_PREFIX + (direction.trim() || DEFAULT_REVIEW_DIRECTION);
}

/**
 * 日本語の説明から positive prompt と negative prompt を AI に補完させる入力欄。
 * 画像を添えると、画像と現在の prompt を突き合わせて直した案を返す。
 * レビューを選ぶと、画像なしでも現在の prompt を土台に指示の点だけ直す。
 */
export function PromptAssist({ current, recipeId, onApply, ...rest }: Props) {
  return (
    <PromptAssistField
      {...rest}
      subject="画像の説明"
      outputLabel="プロンプトとネガティブプロンプト"
      submitLabel="プロンプトを補完"
      allowImage
      allowReview
      reviewMaxLength={MAX_REVIEW_DIRECTION_LENGTH}
      onAssist={async ({ image, review, instruction, ...request }) => {
        if (review && !current.positive.trim()) {
          throw new Error("レビューするプロンプトがありません。先にプロンプトを入力してください。");
        }
        if (review && instruction.trim().length > MAX_REVIEW_DIRECTION_LENGTH) {
          throw new Error(`レビューの方向は${MAX_REVIEW_DIRECTION_LENGTH}文字以内にしてください。`);
        }
        const result = await api.assistImagePrompt({
          ...request,
          instruction: review ? reviewInstruction(instruction) : instruction,
          recipe_id: recipeId || null,
          ...(image && { image }),
          ...((image || review) && {
            current_positive_prompt: current.positive,
            current_negative_prompt: current.negative,
          }),
        });
        const notes = { rationale: result.rationale, tagGlosses: result.tag_glosses ?? [] };
        onApply({ positive: result.positive_prompt, negative: result.negative_prompt, notes });
        return notes;
      }}
    />
  );
}

/** 補完欄が呼び出し元へ渡す要求。`image` は画像を添付したときだけ入り、`allowImage` が偽なら常に `null`。 */
export interface AssistRequest {
  instruction: string;
  provider_id: AgentProviderId | null;
  image: { content_base64: string; media_type: string } | null;
  /** 現在の prompt を土台に直させるか。`allowReview` が偽なら常に偽。 */
  review: boolean;
}

/** 補完後に欄の下へ出す、AI の説明とタグの日本語訳。 */
export interface AssistResult {
  rationale?: string;
  tagGlosses?: { tag: string; ja: string }[];
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
  /** 現在の prompt をレビューして直すモードを出すか。 */
  allowReview?: boolean;
  /** レビューの方向の文字数上限。呼び出し元が付ける固定文の分を差し引いた値。 */
  reviewMaxLength?: number;
  projectId?: string | null;
  /** 指定すると説明文を下書きとして保存し、作り直しや再読み込みの後も残す (#327)。 */
  draftKey?: string;
  /** API を呼んで結果を反映する。失敗は例外で返すと欄の下に表示する。 */
  onAssist: (request: AssistRequest) => Promise<AssistResult | void>;
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
  allowReview = false,
  reviewMaxLength,
  projectId,
  draftKey,
  onAssist,
}: FieldProps) {
  const [description, setDescription] = useState(
    () => (draftKey && draftString(readFormDraft(draftKey)?.description)) || "",
  );
  const [providerId, setProviderId] = useState<AgentProviderId | "">("");
  const [images, setImages] = useState<PickedMedia[]>([]);
  const [assisting, setAssisting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [result, setResult] = useState<AssistResult | null>(null);

  useEffect(() => {
    if (draftKey) writeFormDraft(draftKey, { description });
  }, [draftKey, description]);

  const withImage = allowImage && images.length > 0;
  const review = allowReview && reviewing;
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const defaultProvider = providers.find((provider) => provider.is_default);
  // 「既定のAI」のままなら、要求を受けるのは設定の既定Provider。
  const effectiveProvider = providerId ? selectedProvider : defaultProvider;
  const imageUnsupported = withImage && effectiveProvider?.supports_images === false;

  const assist = async () => {
    if (!description.trim() && !review) {
      setError(withImage ? "直したい点を入力してください。" : `${subject}を入力してください。`);
      return;
    }
    if (imageUnsupported) return;
    setAssisting(true);
    setError(null);
    setResult(null);
    try {
      const image = withImage ? await readPickedImage(images[0]) : null;
      const assisted = await onAssist({
        instruction: description,
        provider_id: providerId || null,
        image: image && { content_base64: image.base64, media_type: image.mediaType },
        review,
      });
      if (assisted) setResult(assisted);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAssisting(false);
    }
  };

  return (
    <>
      {allowReview && (
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={reviewing}
            disabled={assisting}
            onChange={(event) => {
              setReviewing(event.target.checked);
              setError(null);
              setResult(null);
            }}
          />
          現在のプロンプトをレビューして直す
        </label>
      )}
      <div>
        <label htmlFor={`${idPrefix}-description`}>
          {review ? "レビューの方向 (任意)" : withImage ? "直したい点" : subject}
        </label>
        <textarea
          id={`${idPrefix}-description`}
          value={description}
          maxLength={review ? reviewMaxLength : undefined}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={
            review
              ? "例: 光の量を増やす。背景を屋外に変える。Aを消してBを追加。重複しているタグを削除。"
              : withImage
                ? "例: 髪がはねすぎ。もっと引いた構図に。"
                : placeholder
          }
        />
        <p className="muted">
          {review
            ? `現在のプロンプトを土台に、AIが指示の点だけ直した${outputLabel}を差分で示します。空なら重複や矛盾を整理します。`
            : withImage
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
            既定のAI{defaultProvider ? ` (${defaultProvider.label})` : ""}
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
          {assisting
            ? "補完中..."
            : withImage
              ? "画像を見て直す"
              : review
                ? "レビューして直す"
                : submitLabel}
        </button>
      </div>
      {imageUnsupported && (
        <p className="error">
          {effectiveProvider?.label}は画像の入力に対応していません。画像に対応するAIを選んでください。
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {result && <AssistNotes result={result} />}
    </>
  );
}

/** AI の説明とタグの日本語訳。補完欄の下と、補完から開いた差分レビューの上に出す。 */
export function AssistNotes({ result }: { result: AssistResult }) {
  return (
    <>
      {result.rationale && <p className="muted">AIの説明: {result.rationale}</p>}
      {result.tagGlosses && result.tagGlosses.length > 0 && (
        <details className="tag-glosses" open>
          <summary>タグの日本語訳 ({result.tagGlosses.length})</summary>
          <dl>
            {result.tagGlosses.map((gloss, index) => (
              <div key={`${gloss.tag}-${index}`}>
                <dt>{gloss.tag}</dt>
                <dd>{gloss.ja}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </>
  );
}
