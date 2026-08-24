/**
 * Placeholder locking (HARD RULE #8).
 *
 * **These tests were kept when their caller was deleted.** The GPT polish layer
 * was the only thing that ever locked a document, and it was removed on
 * 2026-08-16 (doc 02 §1.1a); the lock itself stayed, because it is the general
 * mechanism for handing text to a model to rewrite without letting the model
 * touch the facts inside it, and hard rule #8 now requires it of any future
 * rewriting pass. A safety mechanism with no current caller still has to work
 * on the day it acquires one, and an untested one would not.
 *
 * The property under test is round-tripping: whatever the lock takes out, the
 * refill must put back byte for byte. If that ever fails, a rewriting layer
 * silently rewrites evidence — which is the one thing the lock exists to make
 * impossible.
 *
 * The load-bearing case is the Chinese quotation. Evidence in this product is
 * Chinese and quoted verbatim inside English prose, and the naive order (lock
 * numbers, then quotes) turns one quotation into three fragments a rewriter
 * can reorder. So the tests assert not only that the text survives, but that a
 * quote is exactly ONE token with nothing locked inside it.
 */

import { describe, expect, it } from "vitest";

import {
  EMPTY_LOCK_STATE,
  findTokens,
  lockSurfaceLayer,
  lockText,
  refillSurfaceLayer,
  refillText,
} from "../src/server/judgment/placeholders";
import type { SurfaceLayer } from "../src/server/judgment";

/** Evidence stays Chinese, verbatim — CLAUDE.md language policy. */
const CHINESE_QUOTE = "“你上次说3月2号会打电话，结果又没打”";

describe("lockText", () => {
  it("locks a Chinese quotation as one atom, numbers and dates included", () => {
    const source = `The record shows ${CHINESE_QUOTE} and nothing after it.`;
    const { text, entries } = lockText(source);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      token: "{{Q1}}",
      kind: "Q",
      value: CHINESE_QUOTE,
    });
    // The naive order would have produced {{D1}} / {{N1}} inside the quote and
    // split it into three fragments; the quote must survive as one token.
    expect(text).toBe("The record shows {{Q1}} and nothing after it.");
    expect(refillText(text, entries)).toBe(source);
  });

  it("locks nested Chinese quotation marks on the outer pair", () => {
    const source = "她写道「他说“三次”都没来」，然后就没下文了。";
    const { text, entries } = lockText(source);

    expect(entries).toHaveLength(1);
    expect(entries[0].value).toBe("「他说“三次”都没来」");
    expect(text).toBe("她写道{{Q1}}，然后就没下文了。");
    expect(refillText(text, entries)).toBe(source);
  });

  it("gives every occurrence its own token — nothing is deduplicated", () => {
    const source = `${CHINESE_QUOTE} … ${CHINESE_QUOTE}`;
    const { text, entries } = lockText(source);

    expect(entries.map((e) => e.token)).toEqual(["{{Q1}}", "{{Q2}}"]);
    // "exactly once" is only a checkable rule if the lock never emits a token
    // twice; see the deterministic validator.
    expect(findTokens(text)).toEqual(["{{Q1}}", "{{Q2}}"]);
    expect(refillText(text, entries)).toBe(source);
  });

  it("locks dates, grades, confidences and counts outside quotations", () => {
    const source =
      "On 2026-08-09 the grade B screenshot put confidence at 0.62, " +
      "and 3 of the 5 messages were sent on 8月9日 (40% of the thread).";
    const { text, entries } = lockText(source);

    const byKind = (kind: string) =>
      entries.filter((e) => e.kind === kind).map((e) => e.value);

    expect(byKind("D")).toEqual(["2026-08-09", "8月9日"]);
    expect(byKind("G")).toEqual(["grade B"]);
    expect(byKind("N")).toEqual(["0.62", "3", "5", "40%"]);
    // Nothing numeric survives outside a token (the tokens carry digits of
    // their own, so they are removed before looking).
    expect(text.replace(/\{\{[A-Z]\d+\}\}/g, "")).not.toMatch(/\d/);
    expect(refillText(text, entries)).toBe(source);
  });

  it("leaves the egress gateway's PII placeholders intact", () => {
    const source = "Reach them at {{PHONE_1}} or {{EMAIL_2}} — 2 channels.";
    const { text, entries } = lockText(source);

    expect(entries.map((e) => e.value)).toEqual(["2"]);
    expect(text).toContain("{{PHONE_1}}");
    expect(text).toContain("{{EMAIL_2}}");
    // Locking the digits inside a PII placeholder would produce
    // `{{PHONE_{{N1}}}}` and destroy the mask.
    expect(text).not.toContain("PHONE_{{");
    expect(refillText(text, entries)).toBe(source);
  });

  it("threads counters so two texts share one token namespace", () => {
    const first = lockText("Seen 3 times.", EMPTY_LOCK_STATE);
    const second = lockText("Seen 4 times.", first.state);

    expect(first.entries[0].token).toBe("{{N1}}");
    expect(second.entries[0].token).toBe("{{N2}}");
    // A shared namespace is what lets the claim summary travel in the same
    // request without two different facts wearing the same token.
    expect(refillText(second.text, [...first.entries, ...second.entries])).toBe(
      "Seen 4 times.",
    );
  });

  it("leaves a token it did not mint standing rather than guessing a value", () => {
    // A polisher that invents `{{Q9}}` must not have a value invented for it.
    expect(refillText("kept {{Q9}} here", [])).toBe("kept {{Q9}} here");
  });

  it("passes prose with no facts in it through unchanged", () => {
    const source = "This judgment cannot settle who ended the conversation.";
    const { text, entries } = lockText(source);
    expect(entries).toHaveLength(0);
    expect(text).toBe(source);
  });
});

describe("lockSurfaceLayer", () => {
  const surface: SurfaceLayer = {
    sections: [
      {
        section_id: "s1",
        kind: "finding",
        audience: "both",
        heading: "What the record shows on 2026-08-09",
        text: `甲 wrote ${CHINESE_QUOTE}; the hearing reads it at 0.62 confidence.`,
        claim_ids: ["c1"],
      },
      {
        section_id: "s2",
        kind: "limits",
        audience: "both",
        heading: "What this cannot decide",
        text: "None of 乙's own five lines is confirmed, so none was read.",
        claim_ids: [],
      },
    ],
  };

  it("round-trips a whole surface layer, headings included", () => {
    const locked = lockSurfaceLayer(surface);

    expect(locked.surfaceLayer.sections[0].heading).toBe(
      "What the record shows on {{D1}}",
    );
    expect(locked.surfaceLayer.sections[0].text).toContain("{{Q1}}");
    expect(refillSurfaceLayer(locked.surfaceLayer, locked.map)).toEqual(surface);
  });

  it("changes text and only text", () => {
    const locked = lockSurfaceLayer(surface);

    expect(
      locked.surfaceLayer.sections.map((s) => ({
        section_id: s.section_id,
        kind: s.kind,
        audience: s.audience,
        claim_ids: s.claim_ids,
      })),
    ).toEqual(
      surface.sections.map((s) => ({
        section_id: s.section_id,
        kind: s.kind,
        audience: s.audience,
        claim_ids: s.claim_ids,
      })),
    );
  });

  it("numbers tokens across sections in document order", () => {
    const locked = lockSurfaceLayer(surface);
    const tokens = locked.map.map((entry) => entry.token);
    expect(tokens).toEqual([...new Set(tokens)]);
    expect(tokens[0]).toBe("{{D1}}");
  });
});
