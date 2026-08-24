import { describe, expect, it } from "vitest";

import { clusterBubbles, type OcrLine, type OcrPage } from "../src/server/ocr/index.js";

/**
 * The geometry is real — measured off chat screenshots (ChatGPT iOS +
 * Xiaohongshu iOS, 1280 x 2781) — so these tests pin the calibrated constants
 * rather than describing an idealized layout. The text is not: every string
 * below is invented (CLAUDE.md: the codebase knows no case). Clustering reads
 * only the numbers, so the strings merely have to keep each line's shape — a
 * full-width paragraph stays full-width, a ragged wrap tail stays short, UI
 * chrome stays short and narrow.
 *
 * They exercise the pure clustering function only — no Swift binary, no Mac
 * required.
 */

const BODY_HEIGHT = 0.019;

function line(text: string, x: number, y: number, w: number, h = BODY_HEIGHT): OcrLine {
  return { text, x, y, w, h, confidence: 1 };
}

function page(lines: OcrLine[]): OcrPage {
  return { width: 1280, height: 2781, coordinateSystem: "normalized-top-left", lines };
}

describe("clusterBubbles", () => {
  it("keeps a multi-line outgoing bubble together and calls it right", () => {
    const blocks = clusterBubbles(
      page([
        line("他一直没订餐厅，我问过他好几次。", 0.293, 0.115, 0.596),
        line("提前订位这件事对那天的安排其实挺", 0.29, 0.141, 0.615),
        // Ragged last line: left-aligned inside a right-aligned bubble. Judged
        // on its own geometry it looks left-ish; only the block's union box
        // reveals that it is flush right.
        line("重要的", 0.293, 0.167, 0.117),
      ]),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.side).toBe("right");
    expect(blocks[0]?.text).toBe("他一直没订餐厅，我问过他好几次。提前订位这件事对那天的安排其实挺重要的");
  });

  it("splits the outgoing bubble from the reply below it and sides both correctly", () => {
    const blocks = clusterBubbles(
      page([
        line("他一直没订餐厅，我问过他好几次。", 0.293, 0.115, 0.596),
        line("重要的", 0.293, 0.141, 0.117),
        line("这件事和前面那几件不太一样，因为重点不是“有没", 0.035, 0.429, 0.905),
        line("有提前订位”，而是这次的安排最后落在了你一个人", 0.035, 0.455, 0.902),
      ]),
    );

    expect(blocks.map((block) => block.side)).toEqual(["right", "left"]);
  });

  it("does not mistake an indented nested comment reply for an outgoing bubble", () => {
    // Xiaohongshu threads indent replies under an avatar, which skews them
    // right. Width 0.739 clears FULL_WIDTH_MIN and asymmetry 0.163 stays under
    // SIDE_ASYMMETRY_MIN, so both guards independently reject "right".
    const blocks = clusterBubbles(
      page([
        line("明明只是想说一句下次早点订位，结果话到嘴边又咽回去", 0.147, 0.481, 0.79),
        line("一直没想好该怎么开口，原来这样讲出来就行啊", 0.212, 0.204, 0.739),
        line("只是把自己的需要说清楚，也会被当成是在翻旧账了", 0.217, 0.251, 0.728),
      ]),
    );

    expect(blocks.every((block) => block.side !== "right")).toBe(true);
  });

  it("marks the status-bar row as center, extracts the clock, and keeps bleed-through content", () => {
    const blocks = clusterBubbles(
      page([
        // Scrolling screenshots capture real message text above the clock row.
        line("的次数多了就成了习惯；如果只是偶尔一次", 0.05, 0.0, 0.716),
        // Vision routinely fuses the clock with the silent-mode glyph.
        line("12:364", 0.114, 0.026, 0.151, 0.0176),
        // Battery glyph, sharing the clock's row.
        line("の", 0.808, 0.0262, 0.044, 0.016),
        line("这件事和前面那几件不太一样，因为重点不是有没", 0.035, 0.429, 0.905),
      ]),
    );

    const clock = blocks.find((block) => block.timestamp !== undefined);
    expect(clock?.timestamp).toBe("12:36");
    expect(clock?.side).toBe("center");

    const bleed = blocks.find((block) => block.text.startsWith("的次数"));
    expect(bleed?.side).toBe("left");
  });

  it("does not demote content on a screenshot cropped below the status bar", () => {
    // A screenshot that opens straight into content at y = 0.017. Without
    // gating the status-bar rule on an actual clock, this would be swallowed.
    const blocks = clusterBubbles(
      page([
        line("book it next time！", 0.141, 0.017, 0.25),
        line("他只顾着解释自己那天有多忙这一点最让人累", 0.145, 0.059, 0.631),
      ]),
    );

    expect(blocks.every((block) => block.side === "left")).toBe(true);
    expect(blocks.every((block) => block.timestamp === undefined)).toBe(true);
  });

  it("flags narrow UI chrome as noise without dropping it", () => {
    const blocks = clusterBubbles(
      page([
        line("Follow", 0.764, 0.072, 0.092),
        line("两个人过日子，难免会有排不上号的小事、说不清的账、", 0.05, 0.2, 0.89),
      ]),
    );

    const chrome = blocks.find((block) => block.text === "Follow");
    expect(chrome?.noise).toBe(true);

    const body = blocks.find((block) => block.text.startsWith("两个人"));
    expect(body?.noise).toBe(false);
    expect(body?.side).toBe("left");
  });

  it("returns no blocks for a page with no recognizable text", () => {
    expect(clusterBubbles(page([]))).toEqual([]);
    expect(clusterBubbles(page([line("   ", 0.1, 0.1, 0.1)]))).toEqual([]);
  });
});
