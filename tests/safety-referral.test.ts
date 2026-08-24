/**
 * The crisis-referral page — HARD RULE #9, proved rather than promised.
 *
 * The rule: *when a safety red flag fires, hotline/resource information renders
 * with zero latency and no LLM in the loop.* A test that merely asserts "no
 * model was called" would pass on a page that imports the gateway and happens
 * not to reach it today. So this file arms two tripwires, and they catch
 * different things — neither is redundant:
 *
 *   1. **A use-time tripwire.** `src/server/llm` and `@anthropic-ai/sdk` are
 *      mocked with a Proxy that throws on ANY property read. Vite's SSR
 *      transform turns `import { runStage } from "…"` into a property access at
 *      the point of use, so this fires the moment the render path touches a
 *      model-layer export — not when the module is merely linked. It catches a
 *      call; it does not catch a dormant import. `"proves the tripwire is
 *      armed"` below demonstrates it firing, so it cannot rot into a mock that
 *      quietly stopped being wired up.
 *   2. **A static tripwire.** The page's relative imports are walked on disk and
 *      the reachable set is checked for `server/llm`. THIS is the one that
 *      catches the dormant import — the page that pulls in the `server/safety`
 *      barrel (which re-exports `gate.ts`, which imports `runStage`) and happens
 *      not to call it yet. Verified against a known-bad entry point so it cannot
 *      pass by walking nothing.
 *
 * Then the page is rendered — the real page module, the real component, against
 * a real encrypted-schema SQLite database — and the resource block is checked
 * hotline by hotline. A referral page that renders a heading and no phone number
 * is the worst bug this repository can ship.
 *
 * The last section is about copy: nothing on this path may tell a person in an
 * abusive situation that responsibility is shared.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* -------------------------------------------------------------------------- */
/* Tripwire one: the model layer explodes if anything so much as links it      */
/* -------------------------------------------------------------------------- */

const { holder } = vi.hoisted(() => ({
  holder: { db: null as unknown },
}));

/**
 * A module namespace that throws on any property read.
 *
 * The three exemptions are plumbing, not escapes: `__esModule` and symbol reads
 * are how the ESM/CJS interop layer inspects a namespace, and `then` is read by
 * `await import(...)` to decide whether the namespace is a thenable. Throwing on
 * those would fail the test for reasons that have nothing to do with the rule.
 *
 * What this catches: any code on the render path that reads a model-layer
 * export. What it does NOT catch: an import that is present but never used —
 * that is the static walk's job, at the foot of this file.
 */
function tripwire(moduleName: string) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "__esModule") return true;
        if (property === "then") return undefined;
        if (typeof property === "symbol") return undefined;
        throw new Error(
          `HARD RULE #9 violated: the crisis-referral path linked ${moduleName} ` +
            `(read "${String(property)}"). Crisis resources must render with no ` +
            `LLM in the loop — import server/safety/screen-record and ` +
            `server/safety/resources directly, never the server/safety barrel.`,
        );
      },
      has: () => true,
    },
  );
}

vi.mock("../src/server/llm", () => tripwire("src/server/llm"));
vi.mock("@anthropic-ai/sdk", () => tripwire("@anthropic-ai/sdk"));

// The page reads the local database; hand it the in-memory one. `importActual`
// is how the real `createDb` is still reachable from a mocked module.
vi.mock("../src/server/db", () => ({
  getDb: () => holder.db,
}));

import {
  CRISIS_RESOURCES,
  REFERRAL_EXPLANATION,
  REFERRAL_HEADLINE,
  REFERRAL_NEXT_STEPS,
  REFERRAL_RESOURCE_NOTE,
  findForbiddenReferralPhrases,
} from "../src/server/safety/resources";
import {
  buildReferralView,
  recordSafetyScreen,
} from "../src/server/safety/screen-record";
import { caseParticipants, cases } from "../src/server/db/schema";
import type { Db } from "../src/server/db";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let db: Db;
let sqlite: Database.Database;

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("../src/server/db")>(
    "../src/server/db",
  );
  ({ db, sqlite } = actual.createDb(":memory:"));
  actual.runMigrations(db);
  holder.db = db;
});

afterEach(() => {
  sqlite.close();
});

function seedCase(title = "The car keys"): string {
  const [row] = db
    .insert(cases)
    .values({ stage: "intake", title })
    .returning()
    .all();
  db.insert(caseParticipants)
    .values({
      caseId: row.id,
      role: "initiator",
      pseudonym: "乙",
      isSubmitter: true,
    })
    .run();
  return row.id;
}

/** Refuse a case the way the gate's local layer does, without importing it. */
function refuse(caseId: string): void {
  recordSafetyScreen(db, {
    caseId,
    screenType: "keyword",
    outcome: "refuse",
    redFlags: ["fear", "physical_violence"],
    rationale:
      "Local rules (deterministic, no model). Matched 2 phrase(s) in the " +
      "utterance text, 2 of them unambiguous.",
  });
}

/**
 * Import and render the real page module.
 *
 * The import is inside the helper on purpose: it happens while the tripwires
 * are armed, so linking is part of what is under test.
 */
async function renderPage(caseId: string): Promise<string> {
  const pageModule = await import("../src/app/case/[id]/referral/page");
  const element = await pageModule.default({
    params: Promise.resolve({ id: caseId }),
  });
  return renderToStaticMarkup(element);
}

/**
 * Rendered markup reduced to the words a reader sees.
 *
 * Entities are decoded because React escapes apostrophes to `&#x27;`, and a copy
 * assertion that fails on "Women's" would be testing the escaper rather than the
 * page.
 */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
}

/* -------------------------------------------------------------------------- */
/* The resource block renders with no model in the loop                       */
/* -------------------------------------------------------------------------- */

describe("the referral page renders with the LLM module mocked to throw", () => {
  it("proves the tripwire is armed: reading a model-layer export throws", async () => {
    // Without this, every assertion below could be passing because the mock
    // silently stopped being applied. Reading `runStage` off the mocked module
    // is exactly what the render path would do if it ever called a model.
    const llm = await import("../src/server/llm");
    expect(() => llm.runStage).toThrow(/HARD RULE #9/);

    const sdk = await import("@anthropic-ai/sdk");
    expect(() => sdk.default).toThrow(/HARD RULE #9/);
  });

  it("renders every crisis resource, contact string included", async () => {
    const caseId = seedCase();
    refuse(caseId);

    const text = visibleText(await renderPage(caseId));

    // Every resource, by name and by the thing you actually dial. A page that
    // renders the headings and drops the numbers is the failure this asserts
    // against.
    for (const resource of CRISIS_RESOURCES) {
      expect(text).toContain(resource.name);
      expect(text).toContain(resource.contact);
      expect(text).toContain(resource.hours);
    }

    // The Chinese official names are what the caller meets on the other end of
    // the line, so they are rendered untranslated (CLAUDE.md).
    expect(text).toContain("全国妇联妇女维权公益服务热线");
    expect(text).toContain("12338");
    expect(text).toContain("110");
    expect(text).toContain("988");
  });

  it("explains why the adjudication frame was exited, in plain language", async () => {
    const caseId = seedCase();
    refuse(caseId);

    const text = visibleText(await renderPage(caseId));

    expect(text).toContain(REFERRAL_HEADLINE);
    for (const paragraph of REFERRAL_EXPLANATION) {
      expect(text).toContain(paragraph);
    }
    expect(text).toContain(REFERRAL_RESOURCE_NOTE);
    for (const step of REFERRAL_NEXT_STEPS) {
      expect(text).toContain(step);
    }
  });

  it("names what the screen found, without quoting the case back at the user", async () => {
    const caseId = seedCase();
    refuse(caseId);

    const html = await renderPage(caseId);

    expect(html).toContain("Being afraid of the other person");
    expect(html).toContain("Physical violence");
    // The read model carries no utterance text, so the page cannot leak one.
    const view = buildReferralView(db, caseId);
    expect(JSON.stringify(view)).not.toContain("打我");
  });

  it("still hands over the resources on a case nothing has refused", async () => {
    const caseId = seedCase();

    const html = await renderPage(caseId);

    expect(html).toContain("not on the referral path");
    // No qualification test: the list renders either way.
    for (const resource of CRISIS_RESOURCES) {
      expect(html).toContain(resource.contact);
    }
  });

  it("renders on a case id that does not exist, rather than throwing", async () => {
    // A crisis page is the wrong place to discover a 404. The resources are a
    // constant and do not depend on the case existing.
    const html = await renderPage("no-such-case");
    expect(html).toContain("110");
  });

  it("uses plain anchors, so the page works before hydration", async () => {
    const caseId = seedCase();
    refuse(caseId);

    const html = await renderPage(caseId);
    expect(html).toContain(`href="/case/${caseId}"`);
  });
});

/* -------------------------------------------------------------------------- */
/* Tripwire two: the import graph, read off disk                              */
/* -------------------------------------------------------------------------- */

describe("the referral page's import graph never reaches the model layer", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pageFile = resolve(
    here,
    "../src/app/case/[id]/referral/page.tsx",
  );

  /** Resolve a relative specifier the way the bundler would. */
  function resolveModule(fromFile: string, specifier: string): string | null {
    const base = resolve(dirname(fromFile), specifier);
    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
    ]) {
      if (existsSync(candidate) && !candidate.endsWith("/")) {
        try {
          readFileSync(candidate, "utf8");
          return candidate;
        } catch {
          // A directory: keep trying the index candidates.
        }
      }
    }
    return null;
  }

  /** Every first-party module reachable from `entry`. */
  function reachableFrom(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];

    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);

      const source = readFileSync(file, "utf8");
      // `import … from "x"`, `export … from "x"`, and `import("x")`. Type-only
      // imports are included deliberately: if a `type` import is the only edge
      // to a module, erasing it is a refactor away from being a real one.
      const specifiers = [
        ...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
      ].map((match) => match[1]);

      for (const specifier of specifiers) {
        if (!specifier.startsWith(".")) continue;
        const resolved = resolveModule(file, specifier);
        if (resolved !== null) queue.push(resolved);
      }
    }

    return seen;
  }

  it("walks the graph and finds no server/llm module in it", () => {
    const reachable = [...reachableFrom(pageFile)];

    // Sanity: the walker actually walked something.
    expect(reachable.length).toBeGreaterThan(2);
    expect(reachable.some((f) => f.endsWith("referral-view.tsx"))).toBe(true);
    expect(reachable.some((f) => f.endsWith("screen-record.ts"))).toBe(true);

    const offenders = reachable.filter(
      (file) =>
        file.includes("/server/llm/") ||
        file.endsWith("/server/safety/gate.ts") ||
        // The barrel re-exports the gate, so importing it is the same mistake.
        file.endsWith("/server/safety/index.ts"),
    );
    expect(offenders).toEqual([]);
  });

  it("proves the walker would catch a violation, by pointing it at one", () => {
    // The gate is the module the page must not reach. Walking from it must find
    // `server/llm` — otherwise the assertion above passes for the wrong reason.
    const gateFile = resolve(here, "../src/server/safety/gate.ts");
    const reachable = [...reachableFrom(gateFile)];
    expect(reachable.some((file) => file.includes("/server/llm/"))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The copy this path may never produce                                       */
/* -------------------------------------------------------------------------- */

describe("the referral path never shares out responsibility", () => {
  it("renders no forbidden phrase", async () => {
    const caseId = seedCase();
    refuse(caseId);

    const text = visibleText(await renderPage(caseId));

    // The failure mode being blocked is specific: telling a person in an
    // abusive situation that responsibility is jointly held reads as neutrality
    // and lands as a verdict against the person who asked for help.
    expect(findForbiddenReferralPhrases(text)).toEqual([]);
  });

  it("checks the constants themselves, not just one rendering of them", () => {
    const copy = [
      REFERRAL_HEADLINE,
      REFERRAL_RESOURCE_NOTE,
      ...REFERRAL_EXPLANATION,
      ...REFERRAL_NEXT_STEPS,
      ...CRISIS_RESOURCES.flatMap((r) => [r.name, r.description, r.hours]),
    ].join(" ");

    expect(findForbiddenReferralPhrases(copy)).toEqual([]);
  });

  it("would catch the phrase if someone wrote it", () => {
    // The guard is only worth having if it fires.
    expect(
      findForbiddenReferralPhrases("In the end both parties share responsibility."),
    ).toEqual(expect.arrayContaining(["share responsibility", "both parties"]));
    expect(findForbiddenReferralPhrases("双方都有责任")).toEqual(["双方都有责任"]);
  });
});
