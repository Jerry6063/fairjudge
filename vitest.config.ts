import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
  // tsconfig sets `jsx: "preserve"` because Next.js compiles the JSX itself.
  // Vite inherits that setting and then refuses to parse any `.tsx` a test
  // imports ("make sure to not set jsx to preserve"). Pinning the automatic
  // runtime here overrides that for the test transform only — the Next build
  // still reads tsconfig and is untouched. Needed by
  // `tests/safety-referral.test.ts`, which renders the crisis-referral page to
  // prove HARD RULE #9 against the real component rather than a copy of it.
  oxc: { jsx: { runtime: "automatic" } },
});
