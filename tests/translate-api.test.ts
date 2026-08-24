/**
 * `POST /api/translate` route tests.
 *
 * The LLM gateway is mocked module-wide, so these tests exercise only what the
 * route owns: request validation, stage selection, and the mapping from a
 * `StageResult` onto an HTTP status plus Chinese error copy. No network, no
 * database, no API key.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { runStageMock } = vi.hoisted(() => ({ runStageMock: vi.fn() }));

vi.mock("../src/server/llm", () => ({ runStage: runStageMock }));

import { POST } from "../src/app/api/translate/route";
import {
  TRANSLATE_MAX_CHARS,
  type TranslateResponseBody,
} from "../src/lib/translate-contract";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

// Model output, so English — but a cue quotes the original fragment verbatim,
// which is exactly what the translator prompt requires.
const TRANSLATION = {
  benign: { reading: "He is just worn out today", confidence: 0.4 },
  neutral: { reading: "He is stating an arrangement", confidence: 0.4 },
  negative: { reading: "He is hinting at dissatisfaction", confidence: 0.2 },
  cues: ['the softener "而已" ("that\'s all")', "no time is mentioned"],
};

const META = {
  model: "claude-opus-4-8",
  effort: "medium" as const,
  fallbackUsed: false,
  costUsd: 0.0175,
  latencyMs: 1234,
};

function okResult() {
  return { kind: "ok" as const, data: TRANSLATION, meta: META };
}

/** POST a body. `raw` bypasses serialization so malformed JSON can be sent. */
function post(body: unknown, raw?: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
  );
}

async function read(
  response: Response,
): Promise<{ status: number; body: TranslateResponseBody }> {
  return {
    status: response.status,
    body: (await response.json()) as TranslateResponseBody,
  };
}

/* -------------------------------------------------------------------------- */

describe("POST /api/translate", () => {
  beforeEach(() => {
    runStageMock.mockReset();
  });

  /* ---------------------------------------------------------------------- */
  /* Input validation                                                       */
  /* ---------------------------------------------------------------------- */

  describe("input validation", () => {
    it("rejects a body that is not JSON", async () => {
      const { status, body } = await read(await post(null, "not json"));

      expect(status).toBe(400);
      expect(body.ok).toBe(false);
      if (body.ok) return;
      expect(body.code).toBe("invalid_request");
      expect(body.error).toContain("JSON");
      expect(runStageMock).not.toHaveBeenCalled();
    });

    it("rejects a missing text field", async () => {
      const { status, body } = await read(await post({ deep: true }));

      expect(status).toBe(400);
      if (body.ok) return;
      expect(body.code).toBe("invalid_request");
      expect(body.error).toContain("text");
      expect(runStageMock).not.toHaveBeenCalled();
    });

    it("rejects whitespace-only text", async () => {
      const { status, body } = await read(await post({ text: "   \n  " }));

      expect(status).toBe(400);
      if (body.ok) return;
      expect(body.code).toBe("invalid_request");
      expect(body.error).toContain("Enter the line you want translated");
      expect(runStageMock).not.toHaveBeenCalled();
    });

    it("rejects text over the length ceiling and names the limit", async () => {
      const { status, body } = await read(
        await post({ text: "啊".repeat(TRANSLATE_MAX_CHARS + 1) }),
      );

      expect(status).toBe(400);
      if (body.ok) return;
      expect(body.code).toBe("invalid_request");
      expect(body.error).toContain(String(TRANSLATE_MAX_CHARS));
      expect(runStageMock).not.toHaveBeenCalled();
    });

    it("accepts text exactly at the ceiling", async () => {
      runStageMock.mockResolvedValue(okResult());

      const { status } = await read(
        await post({ text: "啊".repeat(TRANSLATE_MAX_CHARS) }),
      );

      expect(status).toBe(200);
      expect(runStageMock).toHaveBeenCalledTimes(1);
    });

    it("rejects a non-boolean deep flag", async () => {
      const { status, body } = await read(
        await post({ text: "随便你", deep: "yes" }),
      );

      expect(status).toBe(400);
      if (body.ok) return;
      expect(body.code).toBe("invalid_request");
      expect(body.error).toContain("deep");
      expect(runStageMock).not.toHaveBeenCalled();
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Stage selection                                                        */
  /* ---------------------------------------------------------------------- */

  describe("stage selection", () => {
    it("runs the default stage with the trimmed text", async () => {
      runStageMock.mockResolvedValue(okResult());

      await post({ text: "  随便你，我无所谓。  " });

      expect(runStageMock).toHaveBeenCalledWith("translate_default", {
        prompt: "随便你，我无所谓。",
      });
    });

    it("runs the default stage when deep is false", async () => {
      runStageMock.mockResolvedValue(okResult());

      await post({ text: "随便你", deep: false });

      expect(runStageMock).toHaveBeenCalledWith("translate_default", {
        prompt: "随便你",
      });
    });

    it("runs the deep stage when deep is true", async () => {
      runStageMock.mockResolvedValue(okResult());

      await post({ text: "随便你", deep: true });

      expect(runStageMock).toHaveBeenCalledWith("translate_deep", {
        prompt: "随便你",
      });
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Result mapping                                                         */
  /* ---------------------------------------------------------------------- */

  describe("successful run", () => {
    it("returns the three readings, the cues and the accounting metadata", async () => {
      runStageMock.mockResolvedValue(okResult());

      const response = await post({ text: "随便你" });
      const { status, body } = await read(response);

      expect(status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body.ok).toBe(true);
      if (!body.ok) return;
      expect(body.data).toEqual(TRANSLATION);
      expect(body.meta).toEqual(META);
    });
  });

  describe("failure mapping", () => {
    it("maps a refusal onto 422 with a Chinese message and the category", async () => {
      runStageMock.mockResolvedValue({
        kind: "refused",
        category: "general_harms",
      });

      const { status, body } = await read(await post({ text: "随便你" }));

      expect(status).toBe(422);
      if (body.ok) return;
      expect(body.code).toBe("refused");
      expect(body.error).toContain("The model declined");
      expect(body.detail).toBe("general_harms");
    });

    it("omits the detail when a refusal carries no category", async () => {
      runStageMock.mockResolvedValue({ kind: "refused" });

      const { status, body } = await read(await post({ text: "随便你" }));

      expect(status).toBe(422);
      if (body.ok) return;
      expect(body.code).toBe("refused");
      expect(body.detail).toBeUndefined();
    });

    it("maps a retryable error onto 503", async () => {
      runStageMock.mockResolvedValue({
        kind: "error",
        retryable: true,
        message: "429: rate limited",
      });

      const { status, body } = await read(await post({ text: "随便你" }));

      expect(status).toBe(503);
      if (body.ok) return;
      expect(body.code).toBe("unavailable");
      expect(body.error).toContain("temporarily unavailable");
      expect(body.detail).toBe("429: rate limited");
    });

    it("maps a non-retryable error onto 500", async () => {
      runStageMock.mockResolvedValue({
        kind: "error",
        retryable: false,
        message: "egress blocked by the pseudonymization gateway: 1 fragment",
      });

      const { status, body } = await read(await post({ text: "随便你" }));

      expect(status).toBe(500);
      if (body.ok) return;
      expect(body.code).toBe("internal");
      expect(body.error).toContain("did not complete");
      expect(body.detail).toContain("egress blocked");
    });
  });
});
