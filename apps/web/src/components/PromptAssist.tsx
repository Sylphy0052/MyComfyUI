import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";

import { api } from "../api/client";
import { draftString, readFormDraft, writeFormDraft } from "../state/formDraft";
import type { AgentProvider, AgentProviderId } from "../api/client";
import { noticeSuffix } from "./BackendNotice";
import type { PromptDiffState } from "./PromptDiffReview";

interface Props {
  /** 選択肢として出す AI プロバイダ。取得は呼び出し元が行う。 */
  providers: AgentProvider[];
  /** 説明欄と補完ボタンに付ける id の接頭辞。同一画面での重複を避ける。 */
  idPrefix: string;
  placeholder?: string;
  /** レビューするときに、AI が直す土台として渡す現在の prompt と negative。 */
  current: { positive: string; negative: string };
  /** 選択中の Recipe。Workflow に応じて、タグと自然文を併用するかタグだけで組むかを API が決める。 */
  recipeId?: string | null;
  /** 指定すると説明文を下書きとして保存し、作り直しや再読み込みの後も残す (#327)。 */
  draftKey?: string;
  /**
   * 補完結果の反映。呼び出し元の prompt と negative へ入れる。
   * `notes` は AI の説明とタグ訳で、差分の確認中にも見せられるよう呼び出し元へ渡す (#354)。
   * `review` はレビューさせたか。このとき API は、AI が消すと明示しなかった
   * タグを positive に戻すため、positive から消えたタグは消す意図とみなせる (#356, #357)。
   */
  onApply: (result: {
    positive: string;
    negative: string;
    notes: AssistResult;
    review: boolean;
  }) => void;
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
 * レビューを選ぶと、現在の prompt を土台に指示の点だけ直す。
 */
export function PromptAssist({ current, recipeId, onApply, ...rest }: Props) {
  return (
    <PromptAssistField
      {...rest}
      subject="画像の説明"
      outputLabel="プロンプトとネガティブプロンプト"
      submitLabel="プロンプトを補完"
      allowReview
      reviewMaxLength={MAX_REVIEW_DIRECTION_LENGTH}
      onAssist={async ({ review, instruction, ...request }) => {
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
          ...(review && {
            current_positive_prompt: current.positive,
            current_negative_prompt: current.negative,
          }),
        });
        const blocks = result.tag_confidence_blocks;
        const notes = {
          tagGlosses: result.tag_glosses ?? [],
          tagChanges: result.tag_changes ?? [],
          naturalTextChange: result.natural_text_change,
          tagConfidenceBlocks: blocks && {
            quality_tags: blocks.quality_tags ?? [],
            subject_tags: blocks.subject_tags ?? [],
            character_tags: blocks.character_tags ?? [],
            artist_tags: blocks.artist_tags ?? [],
            general_tags: blocks.general_tags ?? [],
          },
          naturalText: result.natural_text,
        };
        onApply({
          // 確信度の付いた補完は、しきい値の既定値で外したタグを除いて渡す。差分レビューを
          // 持つ画面は`useTagThresholdDiff`でスライダーに合わせて組み直す (#407)。
          positive: notes.tagConfidenceBlocks
            ? composePositivePromptFromBlocks(
                notes.tagConfidenceBlocks,
                DEFAULT_TAG_CONFIDENCE_THRESHOLD,
                notes.naturalText ?? "",
              )
            : result.positive_prompt,
          negative: result.negative_prompt,
          notes,
          review,
        });
        return notes;
      }}
    />
  );
}

/** 補完欄が呼び出し元へ渡す要求。 */
export interface AssistRequest {
  instruction: string;
  provider_id: AgentProviderId | null;
  /** 現在の prompt を土台に直させるか。`allowReview` が偽なら常に偽。 */
  review: boolean;
}

/** 現在の prompt を直した案で、足したか消したタグ1つ (#382)。理由は返さない (#407)。 */
export interface TagChange {
  tag: string;
  change: "added" | "removed";
}

/** 現在の prompt を直した案で、自然文をどう変えたか (#382)。理由は返さない (#407)。 */
export interface NaturalTextChange {
  change: "unchanged" | "added" | "removed" | "modified";
}

/** タグ1つの確信度と日本語訳。ブロック内は確信度の降順で並ぶ (#407)。 */
export interface TagConfidenceItem {
  tag: string;
  confidence: number;
  ja: string;
}

/** ブロックごとの確信度付きタグ一覧 (#407)。 */
export interface TagConfidenceBlocks {
  quality_tags: TagConfidenceItem[];
  subject_tags: TagConfidenceItem[];
  character_tags: TagConfidenceItem[];
  artist_tags: TagConfidenceItem[];
  general_tags: TagConfidenceItem[];
}

/** `TagConfidenceBlocks`のキーを、タグ行を組み立てる順で並べたもの (#407)。 */
const TAG_BLOCK_ORDER: (keyof TagConfidenceBlocks)[] = [
  "quality_tags",
  "subject_tags",
  "character_tags",
  "artist_tags",
  "general_tags",
];

/** しきい値スライダーの既定値。永続化はしない (#407)。 */
export const DEFAULT_TAG_CONFIDENCE_THRESHOLD = 0.2;

/** 重み付きタグの書式。サーバーの`WEIGHTED_TAG_PATTERN`と同じ (#407)。 */
const WEIGHTED_TAG_PATTERN = /^\((.+):\s*[0-9.]+\)$/;

/**
 * 重複判定に使うキー。サーバーの`_dedupe_key`と同じく、重み括弧と、括弧が1組だけの
 * 強調括弧を外し、大文字小文字を無視する (#407)。
 */
function tagDedupeKey(value: string): string {
  let stripped = value.trim();
  const weighted = WEIGHTED_TAG_PATTERN.exec(stripped);
  if (weighted) {
    stripped = weighted[1];
  } else if (stripped.startsWith("(") && stripped.endsWith(")")) {
    const inner = stripped.slice(1, -1);
    if (!inner.includes("(") && !inner.includes(")")) stripped = inner;
  }
  return stripped.trim().toLowerCase();
}

/**
 * しきい値以上のタグだけを残し、サーバーの`compose_tag_line`/`compose_positive_prompt`と
 * 同じ組み立て方でpositive promptへ戻す (#407)。ブロック順で連結し、重複は最初の位置に
 * 1つだけ残す。重み付きと重みなしが並んだときは、サーバーの`_dedupe`と同じく重み付きを残す。
 */
export function composePositivePromptFromBlocks(
  blocks: TagConfidenceBlocks,
  threshold: number,
  naturalText: string,
): string {
  const chosen = new Map<string, string>();
  for (const field of TAG_BLOCK_ORDER) {
    for (const item of blocks[field]) {
      if (item.confidence < threshold) continue;
      const key = tagDedupeKey(item.tag);
      if (!item.tag || !key) continue;
      const current = chosen.get(key);
      if (current === undefined) {
        chosen.set(key, item.tag);
      } else if (WEIGHTED_TAG_PATTERN.test(item.tag.trim()) && !WEIGHTED_TAG_PATTERN.test(current.trim())) {
        chosen.set(key, item.tag);
      }
    }
  }
  const tagLine = [...chosen.values()].join(", ");
  const parts = [tagLine, naturalText].map((part) => part.trim()).filter((part) => part);
  return parts.join("\n\n");
}

/** 補完後に欄の下へ出す、AI の説明とタグの日本語訳、直した案の変更理由。 */
export interface AssistResult {
  /** video/music補完の説明。image_promptは理由を返さないため使わない (#407)。 */
  rationale?: string;
  tagGlosses?: { tag: string; ja: string }[];
  /** 現在の prompt を直したときだけ入る。変更一覧は API が実際の差分から組み立てる (#382)。 */
  tagChanges?: TagChange[];
  naturalTextChange?: NaturalTextChange;
  /** image_prompt補完・レビューだけで入る、しきい値スライダー用のタグ一覧 (#407)。 */
  tagConfidenceBlocks?: TagConfidenceBlocks;
  /** しきい値変更でpositive promptを組み直すための自然文 (#407)。 */
  naturalText?: string;
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
  /** 現在の prompt をレビューして直すモードを出すか。 */
  allowReview?: boolean;
  /** レビューの方向の文字数上限。呼び出し元が付ける固定文の分を差し引いた値。 */
  reviewMaxLength?: number;
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
  allowReview = false,
  reviewMaxLength,
  draftKey,
  onAssist,
}: FieldProps) {
  const [description, setDescription] = useState(
    () => (draftKey && draftString(readFormDraft(draftKey)?.description)) || "",
  );
  const [providerId, setProviderId] = useState<AgentProviderId | "">("");
  const [assisting, setAssisting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [result, setResult] = useState<AssistResult | null>(null);

  useEffect(() => {
    if (draftKey) writeFormDraft(draftKey, { description });
  }, [draftKey, description]);

  const review = allowReview && reviewing;
  const defaultProvider = providers.find((provider) => provider.is_default);

  const assist = async () => {
    if (!description.trim() && !review) {
      setError(`${subject}を入力してください。`);
      return;
    }
    setAssisting(true);
    setError(null);
    setResult(null);
    try {
      const assisted = await onAssist({
        instruction: description,
        provider_id: providerId || null,
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
          {review ? "レビューの方向 (任意)" : subject}
        </label>
        <textarea
          id={`${idPrefix}-description`}
          value={description}
          maxLength={review ? reviewMaxLength : undefined}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={
            review
              ? "例: 光の量を増やす。背景を屋外に変える。Aを消してBを追加。重複しているタグを削除。"
              : placeholder
          }
        />
        <p className="muted">
          {review
            ? `現在のプロンプトを土台に、AIが指示の点だけ直した${outputLabel}を差分で示します。空なら重複や矛盾を整理します。`
            : `日本語で説明するとAIが${outputLabel}を補完します。`}
        </p>
      </div>
      <div className="row">
        <label htmlFor={`${idPrefix}-provider`}>AI</label>
        <select
          id={`${idPrefix}-provider`}
          value={providerId}
          onChange={(event) => setProviderId(event.target.value as AgentProviderId | "")}
        >
          <option value="">
            既定のAI{defaultProvider ? ` (${defaultProvider.label})` : ""}
          </option>
          {providers.map((provider) => (
            <option
              key={provider.id}
              value={provider.id}
              disabled={!provider.available}
            >
              {provider.label}{provider.available ? "" : " (利用不可)"}
              {noticeSuffix(provider)}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={assisting}
          onClick={() => void assist()}
        >
          {assisting
            ? "補完中..."
            : review
              ? "レビューして直す"
              : submitLabel}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {result && <AssistNotes result={result} />}
    </>
  );
}

const NATURAL_TEXT_CHANGE_LABELS: Record<NaturalTextChange["change"], string> = {
  unchanged: "変更なし",
  added: "追加",
  removed: "削除",
  modified: "修正",
};

/** 自然文の変更を「自然文を修正」の形で返す。理由は返さない (#407)。変えていなければ null。 */
export function describeNaturalTextChange(change: NaturalTextChange | undefined): string | null {
  if (!change || change.change === "unchanged") return null;
  return `自然文を${NATURAL_TEXT_CHANGE_LABELS[change.change]}`;
}

/**
 * AI の説明と自然文の変更を補完欄の下と、補完から開いた差分レビューの上に出す。
 * タグの変更理由とタグ訳の一覧は#407でしきい値スライダー付きの確信度一覧へ置き換え、
 * ここでは出さない。
 */
export function AssistNotes({ result }: { result: AssistResult }) {
  const naturalText = describeNaturalTextChange(result.naturalTextChange);
  return (
    <>
      {result.rationale && <p className="muted">AIの説明: {result.rationale}</p>}
      {naturalText && <p className="muted">{naturalText}</p>}
    </>
  );
}

/** しきい値以上/未満で行を分ける表示用の1タグ分。 */
interface DisplayTagItem extends TagConfidenceItem {
  kept: boolean;
}

const TAG_BLOCK_LABELS: Record<keyof TagConfidenceBlocks, string> = {
  quality_tags: "品質",
  subject_tags: "被写体",
  character_tags: "キャラクター",
  artist_tags: "絵師",
  general_tags: "一般",
};

/**
 * 確信度としきい値スライダー。ブロックごとに見出しを出し、タグを確信度の降順で
 * 並べる。しきい値未満のタグは薄く表示し、positive promptからは除く (#407)。
 */
export function TagConfidenceThresholdPanel({
  blocks,
  threshold,
  onThresholdChange,
}: {
  blocks: TagConfidenceBlocks;
  threshold: number;
  onThresholdChange: (threshold: number) => void;
}) {
  const sliderId = useId();
  return (
    <div className="stack">
      <div className="row">
        <label htmlFor={sliderId}>確信度のしきい値 ({threshold.toFixed(2)})</label>
        <input
          id={sliderId}
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={threshold}
          onChange={(event) => onThresholdChange(Number(event.target.value))}
        />
      </div>
      {TAG_BLOCK_ORDER.map((field) => {
        const items = blocks[field];
        if (items.length === 0) return null;
        const display: DisplayTagItem[] = items.map((item) => ({
          ...item,
          kept: item.confidence >= threshold,
        }));
        return (
          <div key={field}>
            <p className="muted">{TAG_BLOCK_LABELS[field]}</p>
            <ul className="list plain">
              {display.map((item, index) => (
                <li
                  key={`${item.tag}-${index}`}
                  className={item.kept ? undefined : "muted"}
                >
                  <span className="mono">{item.tag}</span> ({item.confidence.toFixed(2)})
                  {item.ja && <span> {item.ja}</span>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 差分レビューへ確信度のしきい値スライダーを付ける (#407)。補完結果が変わるたびに
 * しきい値を既定値へ戻し、positive promptの提案文をしきい値以上のタグで組み直す。
 * 確信度の無い差分 (画像prompt以外の補完や、補完以外から開いた差分) はそのまま返す。
 * しきい値の戻しは`notes`の参照で判定するため、呼び出し元は差分をstateに持ち、描画のたびに
 * 作り直さない。
 */
export function useTagThresholdDiff(promptDiff: PromptDiffState | null): {
  diff: PromptDiffState | null;
  panel: ReactNode;
} {
  const blocks = promptDiff?.notes?.tagConfidenceBlocks;
  const [selected, setSelected] = useState<{ blocks?: TagConfidenceBlocks; threshold: number }>({
    threshold: DEFAULT_TAG_CONFIDENCE_THRESHOLD,
  });
  if (!promptDiff || !blocks) return { diff: promptDiff, panel: null };
  const threshold = selected.blocks === blocks ? selected.threshold : DEFAULT_TAG_CONFIDENCE_THRESHOLD;
  const proposed = composePositivePromptFromBlocks(blocks, threshold, promptDiff.notes?.naturalText ?? "");
  return {
    diff: {
      ...promptDiff,
      fields: promptDiff.fields.map((field) =>
        field.key === "positive_prompt" ? { ...field, proposed } : field,
      ),
    },
    panel: (
      <TagConfidenceThresholdPanel
        blocks={blocks}
        threshold={threshold}
        onThresholdChange={(value) => setSelected({ blocks, threshold: value })}
      />
    ),
  };
}
