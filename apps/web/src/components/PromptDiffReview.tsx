import { useState } from "react";
import type { ReactNode } from "react";

import { applyPromptDiff, diffPrompt } from "../prompt/merge";
import type { DiffHunk } from "../prompt/merge";

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
 * `acceptRemovals`を立てた欄だけは削除も採用状態にする。
 */
export function PromptDiffReview({ fields, onCancel, onAccept, children }: Props) {
  const diffs = fields.map((field) => ({
    field,
    hunks: diffPrompt(field.current, field.proposed),
  }));

  const [accepted, setAccepted] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    diffs.forEach(({ field, hunks }) => {
      hunks
        .filter((hunk) => field.acceptRemovals || hunk.kind !== "remove")
        .forEach((hunk) => initial.add(`${field.key}\u0000${hunk.id}`));
    });
    return initial;
  });

  const toggle = (id: string) => {
    setAccepted((current) => {
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
          .filter((hunk) => accepted.has(`${field.key}\u0000${hunk.id}`))
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
                const id = `${field.key}\u0000${hunk.id}`;
                return (
                  <li key={id} className="row">
                    <label className="row">
                      <input
                        type="checkbox"
                        checked={accepted.has(id)}
                        onChange={() => toggle(id)}
                      />
                      <span className={`badge change-${badgeKind(hunk.kind)}`}>
                        {hunkLabel(hunk.kind)}
                      </span>
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
