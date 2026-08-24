/**
 * The deterministic safety layer (SPEC M3 wave A ②, layer one).
 *
 * Two failures are possible here and they are not symmetric, so the file is not
 * balanced either:
 *
 *   - A **false negative** means the product sat down to apportion
 *     responsibility between someone being hurt and the person hurting them.
 *     Everything under "escalates" is about that.
 *   - A **false positive** means a page of resources nobody needed. Cheap — but
 *     not free: a rule list that fires on ordinary bitter argument refuses every
 *     case this product exists to hear, so "does not fire" has its own section
 *     with the real traps in it (「打我电话」, 「我想死你了」, 「行行行，你说得都对」).
 *
 * The evidence in the assertions is Chinese and stays Chinese (CLAUDE.md): these
 * are the strings the rules actually meet.
 */

import { describe, expect, it } from "vitest";

import {
  SAFETY_CATEGORY_LABELS,
  SAFETY_FLAG_CATEGORIES,
  SAFETY_PATTERNS,
  combineSafetySignals,
  scanForSafetySignals,
  scanText,
  screenForSafety,
  type SafetyFlagCategory,
  type SafetySource,
} from "../src/server/domain/safety-rules";
import {
  SAFETY_QUESTIONS,
  answerSources,
  answersToSignals,
  buildSafetyAnswers,
} from "../src/server/safety/questionnaire";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function utterance(text: string, id = "u1"): SafetySource {
  return { id, kind: "utterance", text };
}

/** Screen a single line, the way the gate screens a whole transcript. */
function screenLine(text: string) {
  return screenForSafety([utterance(text)]);
}

/* -------------------------------------------------------------------------- */
/* The rulebook itself                                                        */
/* -------------------------------------------------------------------------- */

describe("the pattern list", () => {
  it("gives every pattern a unique id, a live category and a note", () => {
    const ids = SAFETY_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const pattern of SAFETY_PATTERNS) {
      expect(SAFETY_FLAG_CATEGORIES).toContain(pattern.category);
      // The note is the maintenance contract: a keyword list nobody can audit
      // rots, and the note is what says which innocent phrase it was written
      // around.
      expect(pattern.note.length).toBeGreaterThan(20);
    }
  });

  it("declares no pattern with the global flag, so no scan can carry state", () => {
    // A shared `lastIndex` would make the module stateful: the same text would
    // match on one call and not on the next.
    for (const pattern of SAFETY_PATTERNS) {
      expect(pattern.pattern.flags).not.toContain("g");
    }
  });

  it("covers all six categories in both languages", () => {
    for (const category of SAFETY_FLAG_CATEGORIES) {
      const inCategory = SAFETY_PATTERNS.filter((p) => p.category === category);
      expect(inCategory.some((p) => p.language === "zh")).toBe(true);
      expect(inCategory.some((p) => p.language === "en")).toBe(true);
    }
  });

  it("has plain-language copy for every category the schema can hold", () => {
    for (const category of SAFETY_FLAG_CATEGORIES) {
      expect(SAFETY_CATEGORY_LABELS[category]).toBeTruthy();
    }
  });

  it("is pure: the same text scanned twice gives the same signals", () => {
    const line = utterance("他上次动手打我，我不敢回家");
    expect(scanText(line)).toEqual(scanText(line));
  });
});

/* -------------------------------------------------------------------------- */
/* Explicit hits                                                              */
/* -------------------------------------------------------------------------- */

describe("explicit patterns refuse at high risk", () => {
  const cases: ReadonlyArray<readonly [string, SafetyFlagCategory]> = [
    ["他喝多了就动手打我", "physical_violence"],
    ["那天他掐我脖子，第二天胳膊上全是淤青", "physical_violence"],
    ["他说再这样就弄死我", "threats"],
    ["他威胁我说要把照片发出去", "threats"],
    ["我不敢回家，怕他又发疯", "fear"],
    ["他每天翻我的手机，还装了定位", "monitoring"],
    ["他不让我出门，也不许我跟朋友联系", "coercive_control"],
    ["他把我的身份证和银行卡都拿走了", "coercive_control"],
    ["我最近一直想自杀", "self_harm"],
    ["he hit me and then said I made him do it", "physical_violence"],
    ["I am afraid of him when he drinks", "fear"],
    ["he tracks my location and reads my messages", "monitoring"],
    ["he won't let me leave the flat", "coercive_control"],
    ["I keep thinking I should kill myself", "self_harm"],
    ["he threatened to hurt you if I told anyone", "threats"],
  ];

  for (const [text, expected] of cases) {
    it(`refuses ${JSON.stringify(text)} as ${expected}`, () => {
      const screen = screenLine(text);
      expect(screen.decision).toBe("refer");
      expect(screen.riskLevel).toBe("high");
      expect(screen.categories).toContain(expected);
    });
  }

  it("names the rule and keeps the matched fragment verbatim", () => {
    const [signal] = scanText(utterance("他昨天打我了", "u-42"));
    expect(signal.origin).toBe("pattern");
    expect(signal.ruleId).toMatch(/^zh\.physical\./);
    expect(signal.sourceId).toBe("u-42");
    expect(signal.sourceKind).toBe("utterance");
    // Untranslated, and long enough to be read in context.
    expect(signal.excerpt).toContain("打我");
  });
});

/* -------------------------------------------------------------------------- */
/* The one that matters: ambiguity escalates                                  */
/* -------------------------------------------------------------------------- */

describe("an ambiguous phrase escalates instead of passing", () => {
  // Each of these has an innocent reading, and the innocent reading may well be
  // the right one. The gate is not the place to bet on it.
  const ambiguous = [
    "我有点怕他",
    "跟他在一起总是提心吊胆的",
    "他一生气就砸东西",
    "他说你去死吧",
    "他天天查岗，我去哪都要报备行程",
    "什么都必须经过他的同意",
    "我真想死",
    "I've been walking on eggshells for months",
  ];

  for (const text of ambiguous) {
    it(`refers on ${JSON.stringify(text)} at elevated risk, never pass`, () => {
      const screen = screenLine(text);

      // The assertion the whole layer exists for.
      expect(screen.decision).toBe("refer");

      // `elevated` records that the layer was unsure. It does NOT soften the
      // action: risk level is how sure, decision is what it does.
      expect(screen.riskLevel).toBe("elevated");
      expect(screen.signals.every((s) => s.confidence === "ambiguous")).toBe(
        true,
      );
    });
  }

  it("says in the rationale why an ambiguous match still refers", () => {
    const screen = screenLine("我有点怕他");
    expect(screen.rationale).toContain("ambiguous");
    expect(screen.rationale.toLowerCase()).toContain("escalates rather than");
  });

  it("does not let an explicit hit be diluted by ambiguous ones", () => {
    const screen = screenForSafety([
      utterance("我有点怕他", "u1"),
      utterance("上次他动手打我", "u2"),
    ]);
    expect(screen.riskLevel).toBe("high");
    expect(screen.decision).toBe("refer");
  });
});

/* -------------------------------------------------------------------------- */
/* Ordinary conflict must survive                                             */
/* -------------------------------------------------------------------------- */

describe("ordinary argument does not fire", () => {
  const innocent = [
    // The real seed case's material. If these fired, the product would refuse
    // the one case it was built for.
    "行行行，你说得都对",
    "你会先跟我讲吗？",
    "随便你吧，我无所谓",
    "我说了多少次了你根本不听",
    // Documented traps: 打 as "to call", 想死 as an endearment.
    "你到了打我电话",
    "记得打我手机",
    "我想死你了",
    // 死 as an intensifier, which a bare-character pattern would eat.
    "今天累死了",
    "笑死我了",
    // Excluded on purpose: slamming a door is ordinary argument behaviour.
    "他摔门就走了",
    // 受伤 is most often emotional in exactly this kind of material.
    "我心里受伤了",
    // Politeness, not fear.
    "我怕他误会",
    "我怕他麻烦",
    // An object-less English pattern would swallow this one.
    "I was afraid I had got it wrong",
  ];

  for (const text of innocent) {
    it(`passes ${JSON.stringify(text)}`, () => {
      const screen = screenLine(text);
      expect(screen.decision).toBe("pass");
      expect(screen.riskLevel).toBe("none");
      expect(screen.categories).toEqual([]);
    });
  }

  it("passes an empty or whitespace-only line without scanning it", () => {
    expect(scanText(utterance("   "))).toEqual([]);
    expect(scanForSafetySignals([])).toEqual([]);
  });

  it("says so plainly when nothing matched", () => {
    const screen = combineSafetySignals([]);
    expect(screen.decision).toBe("pass");
    expect(screen.rationale).toContain("no fear");
  });

  it("accepts a known false positive rather than buying it with a false negative", () => {
    // "that comment hit me hard" is a figure of speech and it refers. Pinning
    // it here so the behaviour is a decision rather than a surprise: the only
    // way to exclude it is a lookahead on "hard", and that same lookahead
    // drops "he hit me hard in the face". Between a needless resource page and
    // a missed assault, this layer takes the resource page every time. Delete
    // this test only alongside a pattern that can tell the two apart.
    expect(screenLine("that comment really hit me hard").decision).toBe("refer");
    expect(screenLine("he hit me hard in the face").decision).toBe("refer");
  });
});

/* -------------------------------------------------------------------------- */
/* The half that asks instead of inferring                                    */
/* -------------------------------------------------------------------------- */

describe("the intake questionnaire", () => {
  it("treats a yes as explicit — the user said it, it is not an inference", () => {
    const signals = answersToSignals([
      { id: "physical_harm", question: "…", answer: "yes" },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].confidence).toBe("explicit");
    expect(signals[0].category).toBe("physical_violence");
    expect(signals[0].origin).toBe("question");

    const screen = screenForSafety([], signals);
    expect(screen.decision).toBe("refer");
    expect(screen.riskLevel).toBe("high");
  });

  it("escalates an unsure rather than rounding it down to no", () => {
    // "I don't know" is the answer a person actually gives to these questions
    // early on. Reading it as `no` is how a screening instrument loses the
    // cases it exists to find.
    const screen = screenForSafety(
      [],
      answersToSignals([{ id: "fear_of_partner", question: "…", answer: "unsure" }]),
    );
    expect(screen.decision).toBe("refer");
    expect(screen.riskLevel).toBe("elevated");
    expect(screen.categories).toEqual(["fear"]);
  });

  it("takes a no as a no, and ignores an answer to a question that no longer exists", () => {
    expect(
      answersToSignals([
        { id: "fear_of_partner", question: "…", answer: "no" },
        { id: "control", question: "…", answer: "NO" },
        { id: "a_question_from_an_older_form", question: "…", answer: "yes" },
        { id: "monitoring", question: "…", answer: "maybe, sort of" },
      ]),
    ).toEqual([]);
  });

  it("scans the free-text answer with the pattern layer, in the user's own language", () => {
    const answers = buildSafetyAnswers({
      fear_of_partner: "no",
      anything_else: "他上个月摁在墙上过我一次，我没跟别人说",
    });
    const sources = answerSources(answers);

    // Only the free-text question becomes a source; scanning the literal
    // string "no" would be noise.
    expect(sources).toHaveLength(1);
    expect(sources[0].kind).toBe("answer");

    const screen = screenForSafety(sources, answersToSignals(answers));
    expect(screen.decision).toBe("refer");
    expect(screen.categories).toContain("physical_violence");
  });

  it("keeps the question wording that was actually shown, for the audit row", () => {
    const answers = buildSafetyAnswers({ fear_of_partner: "yes" });
    const asked = SAFETY_QUESTIONS.find((q) => q.id === "fear_of_partner");
    expect(answers).toEqual([
      { id: "fear_of_partner", question: asked?.text, answer: "yes" },
    ]);
  });

  it("maps every choice question onto a category the schema can hold", () => {
    for (const question of SAFETY_QUESTIONS) {
      if (question.kind !== "choice") continue;
      expect(SAFETY_FLAG_CATEGORIES).toContain(question.category);
    }
  });
});
