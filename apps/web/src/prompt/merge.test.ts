import { describe, expect, it } from "vitest";

import { applyPromptDiff, diffPrompt, mergePrompt } from "./merge";
import type { DiffHunk } from "./merge";

/** hunkを`id`と前後の文字列だけの形にして比べやすくする。 */
function summarize(hunks: readonly DiffHunk[]) {
  return hunks.map((hunk) => ({
    id: hunk.id,
    before: hunk.before?.text ?? null,
    after: hunk.after?.text ?? null,
  }));
}

/** 全hunkを採用したときの反映結果。 */
function acceptAll(current: string, proposed: string): string {
  const hunks = diffPrompt(current, proposed);
  return applyPromptDiff(current, hunks, new Set(hunks.map((hunk) => hunk.id)));
}

describe("タグ行と自然文の段落を持つプロンプト", () => {
  const current = "1girl, smile\n\nA girl walks in the rain. She smiles.";
  const proposed = "1girl, smile, rain\n\nA girl walks in the rain at night. She smiles.";

  it("自然文の段落を1つのhunkとして扱う", () => {
    const hunks = diffPrompt(current, proposed);

    expect(summarize(hunks)).toEqual([
      { id: "remove:2", before: "A girl walks in the rain. She smiles.", after: null },
      { id: "add:2", before: null, after: "rain" },
      {
        id: "add:3",
        before: null,
        after: "A girl walks in the rain at night. She smiles.",
      },
    ]);
    expect(hunks[0].before?.paragraph).toBe(true);
    expect(hunks[2].after?.paragraph).toBe(true);
  });

  it("反映するとタグはタグ行へ、段落は空行の後ろへ入る", () => {
    expect(acceptAll(current, proposed)).toBe(proposed);
  });

  it("マージしたタグは段落の前に入る", () => {
    expect(mergePrompt(current, "rain")).toEqual({
      prompt: "1girl, smile, rain\n\nA girl walks in the rain. She smiles.",
      added: 1,
    });
  });
});

describe("重み付けの括弧の内側に空行があるプロンプト", () => {
  const current = "1girl, (masterpiece\n\nbest quality:1.2), smile";

  it("括弧の内側の空行では段落に分けない", () => {
    expect(diffPrompt(current, current)).toEqual([]);
    expect(
      summarize(diffPrompt(current, "1girl, (masterpiece\n\nbest quality:1.2), rain")),
    ).toEqual([
      { id: "remove:2", before: "smile", after: null },
      { id: "add:2", before: null, after: "rain" },
    ]);
  });

  it("反映しても括弧の内側の空行を保つ", () => {
    expect(acceptAll(current, "1girl, (masterpiece\n\nbest quality:1.2), rain")).toBe(
      "1girl, (masterpiece\n\nbest quality:1.2), rain",
    );
  });

  it("マージしたタグは括弧の後ろのタグ行へ入る", () => {
    expect(mergePrompt(current, "rain")).toEqual({
      prompt: "1girl, (masterpiece\n\nbest quality:1.2), smile, rain",
      added: 1,
    });
  });
});

describe("閉じていない括弧があるプロンプト", () => {
  const current = "1girl, (masterpiece, smile\n\nA girl walks in the rain.";
  const proposed = "1girl, (masterpiece, smile\n\nA girl walks in the rain at night.";

  it("空行で段落に分け、自然文をタグ行と別のhunkにする", () => {
    const hunks = diffPrompt(current, proposed);

    expect(summarize(hunks)).toEqual([
      { id: "remove:2", before: "A girl walks in the rain.", after: null },
      { id: "add:2", before: null, after: "A girl walks in the rain at night." },
    ]);
    expect(hunks[0].before?.paragraph).toBe(true);
  });

  it("反映すると自然文だけが置き換わる", () => {
    expect(acceptAll(current, proposed)).toBe(proposed);
  });

  it("マージしたタグは段落の前に入る", () => {
    expect(mergePrompt(current, "rain")).toEqual({
      prompt: "1girl, (masterpiece, smile, rain\n\nA girl walks in the rain.",
      added: 1,
    });
  });
});

describe("空白だけの行を挟んだ3段落", () => {
  const current = "1girl, smile\n  \nA girl walks.\n\t\nShe smiles in the rain.";

  it("空白だけの行を段落の区切りとして扱う", () => {
    expect(
      summarize(diffPrompt(current, "1girl, smile\n\nA girl walks.\n\nShe smiles at night.")),
    ).toEqual([
      { id: "remove:3", before: "She smiles in the rain.", after: null },
      { id: "add:3", before: null, after: "She smiles at night." },
    ]);
  });

  it("反映すると段落の区切りを空行にそろえる", () => {
    expect(acceptAll(current, "1girl, smile\n\nA girl walks.\n\nShe smiles at night.")).toBe(
      "1girl, smile\n\nA girl walks.\n\nShe smiles at night.",
    );
  });

  it("マージしたタグは先頭の段落へ入る", () => {
    expect(mergePrompt(current, "rain")).toEqual({
      prompt: "1girl, smile, rain\n\nA girl walks.\n\nShe smiles in the rain.",
      added: 1,
    });
  });
});

describe("タグだけのプロンプト", () => {
  const current = "masterpiece, 1girl, smile";

  it("タグごとにhunkを作る", () => {
    expect(summarize(diffPrompt(current, "masterpiece, 1girl, (smile:1.2), rain"))).toEqual([
      { id: "change:2", before: "smile", after: "(smile:1.2)" },
      { id: "add:3", before: null, after: "rain" },
    ]);
  });

  it("反映するとカンマ区切りの1行になる", () => {
    expect(acceptAll(current, "masterpiece, 1girl, (smile:1.2), rain")).toBe(
      "masterpiece, 1girl, (smile:1.2), rain",
    );
  });

  it("マージしたタグは同じブロックの後ろへ入り、重複は足さない", () => {
    expect(mergePrompt(current, "rain")).toEqual({
      prompt: "masterpiece, 1girl, smile, rain",
      added: 1,
    });
    expect(mergePrompt(current, "smile")).toEqual({ prompt: current, added: 0 });
  });
});
