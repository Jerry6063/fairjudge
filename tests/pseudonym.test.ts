import { describe, it, expect } from "vitest";

import {
  depseudonymize,
  detectUnregisteredNames,
  pseudonymize,
} from "../src/server/pseudonym/gateway";
import { restorePii, scrubPii } from "../src/server/pseudonym/pii";
import type { PersonDict } from "../src/server/pseudonym/types";

const DICT: PersonDict = [
  { canonical: "知夏", pseudonym: "甲", variants: ["夏夏", "小夏"] },
  { canonical: "Adrian", pseudonym: "乙", variants: [] },
];

describe("pseudonymize / depseudonymize", () => {
  it("round-trips canonical names exactly", () => {
    const text = "知夏和Adrian吵架了，知夏很生气。";
    const { text: masked, hits } = pseudonymize(text, DICT);

    expect(masked).toBe("甲和乙吵架了，甲很生气。");
    expect(hits).toEqual([
      { original: "知夏", pseudonym: "甲", index: 0 },
      { original: "Adrian", pseudonym: "乙", index: 3 },
      { original: "知夏", pseudonym: "甲", index: 13 },
    ]);
    expect(depseudonymize(masked, DICT)).toBe(text);
  });

  it("collapses every variant onto the same pseudonym", () => {
    const { text, hits } = pseudonymize("夏夏、知夏、小夏是同一个人", DICT);

    expect(text).toBe("甲、甲、甲是同一个人");
    expect(hits.map((h) => h.original)).toEqual(["夏夏", "知夏", "小夏"]);
    expect(hits.map((h) => h.pseudonym)).toEqual(["甲", "甲", "甲"]);
    // Variants are lossy: they all restore to the canonical name.
    expect(depseudonymize(text, DICT)).toBe("知夏、知夏、知夏是同一个人");
  });

  it("prefers the longest registered name (知夏妈妈 is not 甲妈妈)", () => {
    const dict: PersonDict = [
      { canonical: "知夏", pseudonym: "甲", variants: ["夏夏", "小夏"] },
      { canonical: "知夏妈妈", pseudonym: "丙", variants: [] },
    ];

    const { text } = pseudonymize("知夏妈妈今天来了，知夏没来", dict);
    expect(text).toBe("丙今天来了，甲没来");
  });

  it("does not cascade a freshly written pseudonym into another substitution", () => {
    // "知夏" -> "甲"; a naive re-scan would then turn "甲" into "乙".
    const dict: PersonDict = [
      { canonical: "甲", pseudonym: "乙", variants: [] },
      { canonical: "知夏", pseudonym: "甲", variants: [] },
    ];

    expect(pseudonymize("知夏", dict).text).toBe("甲");
  });

  it("handles empty text and empty dict", () => {
    expect(pseudonymize("", DICT)).toEqual({ text: "", hits: [] });
    expect(pseudonymize("知夏", [])).toEqual({ text: "知夏", hits: [] });
    expect(depseudonymize("甲", [])).toBe("甲");
  });
});

describe("scrubPii", () => {
  it("scrubs a plain mainland mobile number", () => {
    const { text, matches } = scrubPii("打给我13812345678");
    expect(text).toBe("打给我{{PHONE_1}}");
    expect(matches).toEqual([
      { type: "PHONE", placeholder: "{{PHONE_1}}", original: "13812345678" },
    ]);
  });

  it("scrubs +86 and separator phone variants", () => {
    expect(scrubPii("号码 +86 138 1234 5678").text).toBe("号码 {{PHONE_1}}");
    expect(scrubPii("号码+86-139-9876-5432").text).toBe("号码{{PHONE_1}}");
    expect(scrubPii("8613612345678").text).toBe("{{PHONE_1}}");
  });

  it("scrubs emails", () => {
    const { text, matches } = scrubPii("邮箱 a.b+tag@example.co.uk 收");
    expect(text).toBe("邮箱 {{EMAIL_1}} 收");
    expect(matches[0]?.original).toBe("a.b+tag@example.co.uk");
  });

  it("scrubs both WeChat handle forms", () => {
    expect(scrubPii("加我wxid_abc123DEF").text).toBe("加我{{WECHAT_1}}");

    const labelled = scrubPii("微信号：Zhi_Xia-88");
    expect(labelled.text).toBe("微信号：{{WECHAT_1}}");
    expect(labelled.matches[0]?.original).toBe("Zhi_Xia-88");
  });

  it("scrubs 18-digit national ID numbers, including an X check digit", () => {
    expect(scrubPii("身份证110105199001011234").text).toBe("身份证{{ID_1}}");
    expect(scrubPii("身份证11010519900101123X").text).toBe("身份证{{ID_1}}");
  });

  it("does not carve a phone out of the middle of an ID number", () => {
    const { text, matches } = scrubPii("11010519491231002X");
    expect(text).toBe("{{ID_1}}");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.type).toBe("ID");
  });

  it("dedupes repeated values and increments distinct ones", () => {
    expect(scrubPii("13812345678和13812345678").text).toBe(
      "{{PHONE_1}}和{{PHONE_1}}",
    );
    expect(scrubPii("13812345678、13998765432").text).toBe(
      "{{PHONE_1}}、{{PHONE_2}}",
    );
  });

  it("round-trips through restorePii", () => {
    const raw = "电话13812345678，邮箱a@b.com，微信号：hello_world";
    const scrubbed = scrubPii(raw);
    expect(restorePii(scrubbed.text, scrubbed.matches)).toBe(raw);
  });

  it("is nested-safe: a second scrub finds nothing to replace", () => {
    const scrubbed = scrubPii("电话13812345678邮箱a@b.com");
    const again = scrubPii(scrubbed.text);
    expect(again.matches).toHaveLength(0);
    expect(again.text).toBe(scrubbed.text);
  });
});

describe("PII + pseudonym composition", () => {
  it("scrubs PII first, then pseudonymizes without touching placeholders", () => {
    const raw = "夏夏的电话是13812345678";
    const scrubbed = scrubPii(raw); // "夏夏的电话是{{PHONE_1}}"
    const masked = pseudonymize(scrubbed.text, DICT); // "甲的电话是{{PHONE_1}}"

    expect(masked.text).toBe("甲的电话是{{PHONE_1}}");

    // Full inverse: depseudonymize (variant -> canonical) then restore PII.
    const restored = restorePii(depseudonymize(masked.text, DICT), scrubbed.matches);
    expect(restored).toBe("知夏的电话是13812345678");
  });
});

describe("detectUnregisteredNames", () => {
  it("reports residual PII as warnings (NER deferred to a later milestone)", () => {
    const warnings = detectUnregisteredNames("联系13812345678或a@b.com", DICT);

    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.kind)).toEqual(["residual_pii", "residual_pii"]);
    const originals = warnings.map((w) => w.original);
    expect(originals).toContain("13812345678");
    expect(originals).toContain("a@b.com");
    expect(warnings[0]?.index).toBeGreaterThanOrEqual(0);
  });

  it("returns no warnings for already-scrubbed, pseudonymized text", () => {
    const clean = "甲的电话是{{PHONE_1}}";
    expect(detectUnregisteredNames(clean, DICT)).toEqual([]);
  });
});
