import { useState } from "react";
import type { ReactNode } from "react";

import { applyPromptDiff, diffPrompt } from "../prompt/merge";
import type { DiffHunk } from "../prompt/merge";
import type { AssistResult } from "./PromptAssist";

/** 差分計算の対象になる1つのプロンプト欄。 */
export interface PromptDiffField {
  /** `onAccept`が返すオブジェクトのキー。呼び出し元のフィールド名と合わせる。 */
  key: string;
  label: string;
  current: string;
  proposed: string;
  /**
   * 削除のhunkも既定で採用するか。提案が現在のプロンプト全体を土台にしていて、提案に無い
   * 記述を消す意図とみなせる欄だけで立てる (#357)。
   */
  acceptRemovals?: boolean;
}

/**
 * 開いている差分レビュー。差分と、そこに添える AI の説明・タグ訳を1つの値で持ち、
 * 開く・閉じるときに両方が必ず一緒に変わるようにする (#360)。
 */
export interface PromptDiffState {
  fields: PromptDiffField[];
  /** 補完から開いた差分に添える説明とタグ訳。補完以外から開いた差分では null (#354)。 */
  notes: AssistResult | null;
}

interface Props {
  fields: PromptDiffField[];
  onCancel: () => void;
  /** 選んだhunkだけを反映した結果。キーは`fields`の`key`と一致する。 */
  onAccept: (result: Record<string, string>) => void;
  /** 差分の上に出す補足。補完から開いたときの AI の説明やタグ訳など (#354)。 */
  children?: ReactNode;
}

/**
 * AIが提案したプロンプトと、既存のプロンプトの差分をhunk単位で見せ、採否を選ばせる。
 *
 * 採用しなかった追加・削除・変更はすべて既存の記述のまま残る。既定では追加と変更
 * だけを採用状態にし、削除は未選択にする。提案側はAIの再生成結果や抽出タグだけの
 * ことが多く、提案に無い既存の記述をすべて削除扱いにすると、そのまま反映したとき
 * に既存の記述が消えるため。削除したいhunkは利用者が明示的に選ぶ。
 * `acceptRemovals`を立てた欄だけは削除も採用状態にする。既定で選ばれた削除は
 * 利用者が選んだものと見た目で区別できるよう「(既定で選択)」と注記する (#366)。
 *
 * 採否は、既定から利用者が反転したhunkの集合として内容で覚える。`fields`はしきい値
 * スライダーで作り直されることがあり (#407)、位置から作る`hunk.id`はそのたびにずれる。
 * 内容で覚えれば、作り直した後も同じhunkの選択が残り、新しく現れたhunkは既定に従う。
 */
export function PromptDiffReview({ fields, onCancel, onAccept, children }: Props) {
  const diffs = fields.map((field) => ({
    field,
    hunks: diffPrompt(field.current, field.proposed),
  }));

  const [toggled, setToggled] = useState<Set<string>>(() => new Set());

  const isAccepted = (field: PromptDiffField, hunk: DiffHunk) =>
    isAcceptedByDefault(field, hunk) !== toggled.has(hunkContentKey(field, hunk));

  const toggle = (id: string) => {
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const hasChanges = diffs.some(({ hunks }) => hunks.length > 0);

  const apply = () => {
    const result: Record<string, string> = {};
    diffs.forEach(({ field, hunks }) => {
      const fieldAccepted = new Set(
        hunks
          .filter((hunk) => isAccepted(field, hunk))
          .map((hunk) => hunk.id),
      );
      result[field.key] = applyPromptDiff(field.current, hunks, fieldAccepted);
    });
    onAccept(result);
  };

  if (!hasChanges) {
    return (
      <div className="stack">
        {children}
        <p className="muted">既存のプロンプトとの差分はありません。</p>
        <button type="button" onClick={onCancel}>
          閉じる
        </button>
      </div>
    );
  }

  return (
    <div className="stack">
      {children}
      {diffs.map(({ field, hunks }) => {
        if (hunks.length === 0) return null;
        return (
          <div key={field.key}>
            <p className="muted">{field.label}</p>
            <ul className="list plain">
              {hunks.map((hunk) => {
                const id = hunkContentKey(field, hunk);
                // 既定採用の削除hunkにのみ「(既定で選択)」の注記を出す。
                const isDefaultRemoval = hunk.kind === "remove" && field.acceptRemovals;
                return (
                  <li key={id} className="row">
                    <label className="row">
                      <input
                        type="checkbox"
                        checked={isAccepted(field, hunk)}
                        onChange={() => toggle(id)}
                      />
                      <span className={`badge change-${badgeKind(hunk.kind)}`}>
                        {hunkLabel(hunk.kind)}
                      </span>
                      {isDefaultRemoval && <span className="muted">(既定で選択)</span>}
                    </label>
                    <span className="mono">{describeHunk(hunk)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <div className="row">
        <button type="button" onClick={apply}>
          選んだ差分を反映
        </button>
        <button type="button" onClick={onCancel}>
          キャンセル
        </button>
      </div>
    </div>
  );
}

function badgeKind(kind: DiffHunk["kind"]): string {
  if (kind === "add") return "added";
  if (kind === "remove") return "missing";
  return "updated";
}

/** 既定で採用するhunkか。削除は`acceptRemovals`を立てた欄だけ採用する。 */
function isAcceptedByDefault(field: PromptDiffField, hunk: DiffHunk): boolean {
  return field.acceptRemovals === true || hunk.kind !== "remove";
}

/** hunkの採否を覚えるキー。欄と種類と前後の記述から作り、位置に依存させない。 */
function hunkContentKey(field: PromptDiffField, hunk: DiffHunk): string {
  return [field.key, hunk.kind, hunk.before?.text ?? "", hunk.after?.text ?? ""].join(
    "\u0000",
  );
}

function hunkLabel(kind: DiffHunk["kind"]): string {
  if (kind === "add") return "追加";
  if (kind === "remove") return "削除";
  return "変更";
}

function describeHunk(hunk: DiffHunk): string {
  if (hunk.kind === "add") return hunk.after?.text ?? "";
  if (hunk.kind === "remove") return hunk.before?.text ?? "";
  return `${hunk.before?.text ?? ""} → ${hunk.after?.text ?? ""}`;
}
