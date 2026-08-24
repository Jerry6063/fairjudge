/**
 * The polish archive's copy may not assert a rewrite that did not happen.
 *
 * Doc 04 §2.2 lists this first among the screens that state something untrue:
 * the judgment page told every reader of an archived run that "a second vendor
 * rewrote the phrasing of the narrative", and then displayed, four lines below,
 * that the run was `skipped` because the vendor answered HTTP 401. On the real
 * judgment nothing was rewritten. One sentence, one screen, and it contradicted
 * its own provenance table.
 *
 * The fix is a selection rather than a softer adjective, so the test is about
 * the selection: the only outcome whose sentence may describe a rewrite is
 * `applied`, which is the only outcome that ever wrote the polished draft back
 * onto a judgment.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  POLISH_ARCHIVE_PREAMBLE,
  POLISH_ARCHIVE_UNKNOWN,
  POLISH_ARCHIVE_WHAT_HAPPENED,
} from "../src/app/case/[id]/judgment/labels";
import { POLISH_OUTCOMES } from "../src/server/db/schema";

/** Anything that claims the text on screen was changed by the polish layer. */
const CLAIMS_A_REWRITE = /rewrit|rewrote/i;

describe("the polish archive block", () => {
  it("covers every outcome the column can hold", () => {
    for (const outcome of POLISH_OUTCOMES) {
      expect(POLISH_ARCHIVE_WHAT_HAPPENED[outcome]).toBeTruthy();
    }
  });

  it("only lets `applied` describe a rewrite", () => {
    expect(POLISH_ARCHIVE_WHAT_HAPPENED.applied).toMatch(CLAIMS_A_REWRITE);
    for (const outcome of POLISH_OUTCOMES.filter((o) => o !== "applied")) {
      expect(POLISH_ARCHIVE_WHAT_HAPPENED[outcome]).not.toMatch(CLAIMS_A_REWRITE);
    }
    expect(POLISH_ARCHIVE_UNKNOWN).toContain("does not assert");
  });

  it("says what the layer was without saying what it did here", () => {
    // The preamble is the same on every judgment, so it may describe the layer's
    // configuration and its removal — and nothing about this particular run.
    expect(POLISH_ARCHIVE_PREAMBLE).toContain("has since been removed");
    expect(POLISH_ARCHIVE_PREAMBLE).not.toMatch(CLAIMS_A_REWRITE);
  });

  it("states, on a skipped run, that nothing was sent and nothing came back", () => {
    expect(POLISH_ARCHIVE_WHAT_HAPPENED.skipped).toContain("never ran");
    expect(POLISH_ARCHIVE_WHAT_HAPPENED.skipped).toContain("nothing came back");
  });

  it("no longer carries the sentence doc 04 §2.2 recorded", () => {
    const page = readFileSync(
      fileURLToPath(new URL("../src/app/case/[id]/judgment/page.tsx", import.meta.url)),
      "utf8",
    );
    expect(page).not.toContain("a second vendor rewrote the");
    // And the block branches on the row rather than asserting past it.
    expect(page).toContain("POLISH_ARCHIVE_WHAT_HAPPENED[polish.outcome]");
  });
});
