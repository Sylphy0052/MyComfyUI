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
  /**
   * 別のUIで採否を決める記述か。前後どちらかの記述が該当するhunkは一覧に出さず、常に
   * 採用する。確信度パネルのON/OFFと二重にならないようにする (#441)。
   */
  managed?: (text: string) => boolean;
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
 * 同じ内容のhunkが並ぶ (重複タグの削除など) ときは、内容に出現順を足して区別する。
 */
export function PromptDiffReview({ fields, onCancel, onAccept, children }: Props) {
  const diffs = fields.map((field) => {
    const hunks = diffPrompt(field.current, field.proposed);
    return { field, hunks, keys: hunkSelectionKeys(field, hunks) };
  });

  const [toggled, setToggled] = useState<Set<string>>(() => new Set());

  const isAccepted = (field: PromptDiffField, hunk: DiffHunk, key: string) =>
    isManaged(field, hunk) || isAcceptedByDefault(field, hunk) !== toggled.has(key);

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
    diffs.forEach(({ field, hunks, keys }) => {
      const fieldAccepted = new Set(
        hunks
          .filter((hunk) => isAccepted(field, hunk, keys.get(hunk.id) ?? ""))
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
      {diffs.map(({ field, hunks: allHunks, keys }) => {
        const hunks = allHunks.filter((hunk) => !isManaged(field, hunk));
        if (hunks.length === 0) return null;
        return (
          <div key={field.key}>
            <p className="muted">{field.label}</p>
            <ul className="list plain">
              {hunks.map((hunk) => {
                const id = keys.get(hunk.id) ?? "";
                // 既定採用の削除hunkにのみ「(既定で選択)」の注記を出す。
                const isDefaultRemoval = hunk.kind === "remove" && field.acceptRemovals;
                return (
                  // 採否は内容と出現順で持つ。行のkeyは`hunk.id`で付ける。
                  <li key={hunk.id} className="row">
                    <label className="row">
                      <input
                        type="checkbox"
                        checked={isAccepted(field, hunk, id)}
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

/** 別のUIが採否を決めるhunkか (`PromptDiffField.managed`)。 */
function isManaged(field: PromptDiffField, hunk: DiffHunk): boolean {
  const { managed } = field;
  if (!managed) return false;
  return [hunk.before?.text, hunk.after?.text].some((text) => text !== undefined && managed(text));
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

/**
 * hunkごとの採否キーを`hunk.id`で引けるようにする。同じ内容のhunkには出現順を足し、
 * 1件ずつ選べるようにする。しきい値で作り直しても、同じ内容どうしの順は変わらない。
 */
function hunkSelectionKeys(
  field: PromptDiffField,
  hunks: readonly DiffHunk[],
): Map<string, string> {
  const seen = new Map<string, number>();
  const keys = new Map<string, string>();
  hunks.forEach((hunk) => {
    const contentKey = hunkContentKey(field, hunk);
    const occurrence = seen.get(contentKey) ?? 0;
    seen.set(contentKey, occurrence + 1);
    keys.set(hunk.id, `${contentKey}\u0000${occurrence}`);
  });
  return keys;
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
