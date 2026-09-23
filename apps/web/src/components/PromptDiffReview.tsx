import { useState } from "react";

import { applyPromptDiff, diffPrompt } from "../prompt/merge";
import type { DiffHunk } from "../prompt/merge";

/** 差分計算の対象になる1つのプロンプト欄。 */
export interface PromptDiffField {
  /** `onAccept`が返すオブジェクトのキー。呼び出し元のフィールド名と合わせる。 */
  key: string;
  label: string;
  current: string;
  proposed: string;
}

interface Props {
  fields: PromptDiffField[];
  onCancel: () => void;
  /** 選んだhunkだけを反映した結果。キーは`fields`の`key`と一致する。 */
  onAccept: (result: Record<string, string>) => void;
}

/**
 * AIが提案したプロンプトと、既存のプロンプトの差分をhunk単位で見せ、採否を選ばせる。
 *
 * 採用しなかった追加・削除・変更はすべて既存の記述のまま残る。既定はすべて採用
 * 状態にしておき、不要なhunkだけ外す運用を想定する。
 */
export function PromptDiffReview({ fields, onCancel, onAccept }: Props) {
  const diffs = fields.map((field) => ({
    field,
    hunks: diffPrompt(field.current, field.proposed),
  }));

  const [accepted, setAccepted] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    diffs.forEach(({ field, hunks }) => {
      hunks.forEach((hunk) => initial.add(`${field.key}\u0000${hunk.id}`));
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
        <p className="muted">既存のプロンプトとの差分はありません。</p>
        <button type="button" onClick={onCancel}>
          閉じる
        </button>
      </div>
    );
  }

  return (
    <div className="stack">
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
