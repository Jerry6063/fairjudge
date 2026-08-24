/**
 * Deterministic safety detection — layer one of the M3 screening gate.
 *
 * This module is a pure function over text: no database, no network, no model,
 * no clock. It exists so that the question "does this case belong in an
 * adjudication pipeline at all?" has an answer that is available instantly,
 * offline, and identically on every run. HARD RULE #9 makes that a requirement
 * rather than an optimisation: the crisis path may not depend on a model being
 * reachable, so the layer that opens it may not either.
 *
 * Design commitments, in the order they matter:
 *
 * 1. **Recall over precision.** The two errors are not symmetric. A false
 *    positive costs the user one page of resources they did not need and a
 *    second click; a false negative means the product sat down to apportion
 *    responsibility between someone who is being hurt and the person hurting
 *    them. So an ambiguous match escalates — `combineSafetySignals` never
 *    returns `pass` once anything at all has matched, and `riskLevel` only
 *    distinguishes how sure the layer is, not whether it acts.
 *
 * 2. **Both languages, one rulebook.** The evidence in this product is Chinese
 *    (CLAUDE.md language policy) and the interface is English, so a phrase can
 *    arrive in either. Every category below carries patterns in both, tagged
 *    with `language` purely for auditing which half of the list is doing work.
 *
 * 3. **Every pattern is documented with what it deliberately does NOT catch.**
 *    A keyword list rots the moment nobody can tell whether a match was
 *    intended. The traps are real and specific: `打我` must not fire on
 *    「打我电话」, `我想死` must not fire on 「我想死你了」 (an endearment), and
 *    ordinary bitter argument — 「行行行，你说得都对」, 「随便你」 — must not fire
 *    at all, or the gate refuses every case the product exists to hear.
 *
 * What this module is NOT: a diagnosis, a severity ranking, or the final word.
 * It is the cheap first pass. The `safety_screen` stage reads the same material
 * afterwards and can escalate what the patterns missed; the gate in
 * `server/safety/gate.ts` takes either layer's word for it.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The red-flag categories both screening layers speak in.
 *
 * These are the strings persisted into `safety_screens.red_flags`, and the
 * enum the `safety_screen` stage is allowed to answer with, so the local layer
 * and the model layer stay comparable.
 */
export const SAFETY_FLAG_CATEGORIES = [
  "fear",
  "threats",
  "monitoring",
  "coercive_control",
  "physical_violence",
  "self_harm",
] as const;

export type SafetyFlagCategory = (typeof SAFETY_FLAG_CATEGORIES)[number];

/** Plain-language label per category, for the referral page and rationales. */
export const SAFETY_CATEGORY_LABELS: Readonly<
  Record<SafetyFlagCategory, string>
> = {
  fear: "Being afraid of the other person",
  threats: "Threats or intimidation",
  monitoring: "Monitoring, tracking or reading your messages",
  coercive_control:
    "Control over where you go, who you see, or what money you have",
  physical_violence: "Physical violence",
  self_harm: "Risk of self-harm or suicide",
};

/**
 * How sure the layer is, not what it does about it.
 *
 * - `none` — nothing matched.
 * - `elevated` — only ambiguous patterns matched. The phrase has an innocent
 *   reading, and the innocent reading may well be the right one. It still
 *   refers: see commitment 1 above.
 * - `high` — at least one explicit pattern matched.
 */
export const SAFETY_RISK_LEVELS = ["none", "elevated", "high"] as const;

export type SafetyRiskLevel = (typeof SAFETY_RISK_LEVELS)[number];

/**
 * Whether a pattern's match is decisive on its own.
 *
 * `explicit` — the phrase has no ordinary reading in a relationship account
 * ("掐脖子", "kill myself").
 * `ambiguous` — the phrase is consistent with the category but also with a
 * harmless reading ("我有点怕他", "walking on eggshells"). Escalates anyway.
 */
export type PatternConfidence = "explicit" | "ambiguous";

/* -------------------------------------------------------------------------- */
/* The pattern list                                                           */
/* -------------------------------------------------------------------------- */

export interface SafetyPattern {
  /** Stable id — persisted in rationales and asserted on in tests. */
  readonly id: string;
  readonly category: SafetyFlagCategory;
  readonly language: "zh" | "en";
  readonly confidence: PatternConfidence;
  /**
   * Declared WITHOUT the global flag on purpose: `scanText` builds its own
   * global copy per scan, so no shared `lastIndex` can leak between calls and
   * make this module stateful.
   */
  readonly pattern: RegExp;
  /** What it is for, and what it is deliberately written to miss. */
  readonly note: string;
}

/**
 * The rulebook. Grouped by category, Chinese first because that is what the
 * evidence is written in.
 *
 * Editing rule: a new pattern needs a `note` saying what innocent phrase it
 * had to be written around. If no such phrase exists, say so — that is itself
 * the useful record.
 */
export const SAFETY_PATTERNS: readonly SafetyPattern[] = [
  /* ---- physical violence ------------------------------------------------ */
  {
    id: "zh.physical.hit_me",
    category: "physical_violence",
    language: "zh",
    confidence: "explicit",
    pattern: /打我(?!电话|手机)/,
    note: "『打我』. Excludes 「打我电话」/「打我手机」, where 打 is 'to call'.",
  },
  {
    id: "zh.physical.struck_person",
    category: "physical_violence",
    language: "zh",
    confidence: "explicit",
    pattern: /(打|揍|踹|踢|扇|掐|勒|拽|推搡)了?(我|他|她)(?!电话|手机)/,
    note:
      "Verb + person: 揍我 / 踹了他 / 掐我. 推搡 rather than bare 推, since " +
      "「推我一下」 in a crowd is not the same claim as 「推搡我」.",
  },
  {
    id: "zh.physical.named_violence",
    category: "physical_violence",
    language: "zh",
    confidence: "explicit",
    pattern:
      /家暴|殴打|施暴|动手打|拳打脚踢|一巴掌|扇耳光|耳光|掐脖子|掐住脖子|摁在(墙|地|床)上|下死手/,
    note: "Named acts. None of these has a figurative reading in an account of a fight.",
  },
  {
    id: "zh.physical.injury_marks",
    category: "physical_violence",
    language: "zh",
    confidence: "explicit",
    pattern: /淤青|瘀青|验伤|骨折|流鼻血|伤痕/,
    note:
      "Physical traces. 受伤 is excluded on purpose — 「心里受伤」 is the " +
      "commonest use of it in exactly this kind of material.",
  },
  {
    id: "zh.physical.was_beaten",
    category: "physical_violence",
    language: "zh",
    confidence: "explicit",
    pattern: /挨(了)?(他|她)?的?打/,
    note: "『挨打』 in its passive sense — the speaker on the receiving end.",
  },
  {
    id: "zh.physical.smashing",
    category: "physical_violence",
    language: "zh",
    confidence: "ambiguous",
    pattern: /(砸|摔)(东西|杯子|碗|盘子|椅子|手机)/,
    note:
      "Breaking objects: intimidation short of contact. Ambiguous because it " +
      "can be temper alone. 摔门 is excluded — slamming a door is ordinary " +
      "argument behaviour and would fire on half the corpus.",
  },
  {
    id: "en.physical.acts",
    category: "physical_violence",
    language: "en",
    confidence: "explicit",
    pattern:
      /\b(hit me|beat me|beats me|punched me|slapped me|choked me|strangled|kicked me|shoved me|grabbed me by)\b/i,
    note:
      "Object-anchored: 'hit me', never bare 'hit' — a bare 'hit' fires on " +
      "every 'the news hit at a bad time'. ACCEPTED FALSE POSITIVE: 'that " +
      "comment hit me hard' still matches. Excluding it needs a lookahead on " +
      "'hard', and that same lookahead drops 'he hit me hard in the face' — a " +
      "false negative in the category where a false negative costs the most. " +
      "The asymmetry is the whole reason this layer exists, so the figurative " +
      "reading is allowed to refer.",
  },
  {
    id: "en.physical.domestic_violence",
    category: "physical_violence",
    language: "en",
    confidence: "explicit",
    pattern: /\b(domestic violence|physically (hurt|assault|abusive)|battered)\b/i,
    note: "The term of art, plus 'physically abusive'. No innocent reading.",
  },

  /* ---- threats ---------------------------------------------------------- */
  {
    id: "zh.threats.kill_or_destroy",
    category: "threats",
    language: "zh",
    confidence: "explicit",
    pattern: /杀了(你|我|他|她)|弄死(你|我|他|她)|打死(你|我)|整死(你|我)/,
    note: "Explicit threat to kill or maim. Hyperbole is possible; recall wins.",
  },
  {
    id: "zh.threats.retaliation",
    category: "threats",
    language: "zh",
    confidence: "explicit",
    pattern:
      /让你好看|要你好看|等着瞧|别怪我不客气|不会放过(你|我)|后果自负|鱼死网破|同归于尽/,
    note:
      "Retaliation formulas. 「你等着」 alone is excluded — it usually means " +
      "'hold on a second'; only 「等着瞧」 is kept.",
  },
  {
    id: "zh.threats.intimidation_verbs",
    category: "threats",
    language: "zh",
    confidence: "explicit",
    pattern: /威胁我|恐吓|要挟|胁迫/,
    note: "The user naming it as a threat. 威胁 alone is excluded ('威胁到我们的关系').",
  },
  {
    id: "zh.threats.exposure",
    category: "threats",
    language: "zh",
    confidence: "explicit",
    pattern:
      /(照片|视频|裸照|聊天记录).{0,8}(发出去|曝光|传出去|发给)|曝光(你|我)/,
    note: "Threatened exposure of intimate material — image-based abuse.",
  },
  {
    id: "zh.threats.go_die",
    category: "threats",
    language: "zh",
    confidence: "ambiguous",
    pattern: /你去死|去死吧/,
    note:
      "Said in a fight it is an insult, not a plan; still violent speech aimed " +
      "at a person, so it escalates rather than passing.",
  },
  {
    id: "en.threats.kill_hurt",
    category: "threats",
    language: "en",
    confidence: "explicit",
    pattern: /\b(kill (you|him|her|them)|hurt you|make you regret|you'?ll be sorry)\b/i,
    note: "Direct threat formulas.",
  },
  {
    id: "en.threats.named",
    category: "threats",
    language: "en",
    confidence: "explicit",
    pattern: /\b(threatened (me|to)|threatens me|intimidat(es|ed) me)\b/i,
    note: "The user naming it as a threat.",
  },

  /* ---- fear ------------------------------------------------------------- */
  {
    id: "zh.fear.dare_not",
    category: "fear",
    language: "zh",
    confidence: "explicit",
    pattern: /不敢(回家|回去|说话|反抗|拒绝|出门|睡觉|一个人待)/,
    note:
      "『不敢』 + an ordinary act. A person who cannot go home is describing " +
      "danger, whatever else the account contains.",
  },
  {
    id: "zh.fear.afraid_of_harm",
    category: "fear",
    language: "zh",
    confidence: "explicit",
    pattern: /(害怕|怕)(他|她|对方).{0,4}(动手|打|发疯|失控|报复|伤害)|人身安全/,
    note: "Fear naming the harm feared, plus the fixed phrase 人身安全.",
  },
  {
    id: "zh.fear.of_person",
    category: "fear",
    language: "zh",
    confidence: "ambiguous",
    pattern: /(很|非常|特别|有点|有些|真的)?(害怕|怕)(他|她|对方)(?!误会|麻烦|不高兴地|听不)/,
    note:
      "Bare fear of the partner. Genuinely ambiguous — 「怕他生气」 is said in " +
      "ordinary relationships too — so it escalates instead of refusing to " +
      "notice. Excludes 「怕他误会」/「怕他麻烦」, which are politeness.",
  },
  {
    id: "zh.fear.hypervigilance",
    category: "fear",
    language: "zh",
    confidence: "ambiguous",
    pattern: /提心吊胆|战战兢兢|如履薄冰/,
    note: "Hypervigilance idioms. Also used loosely about work stress.",
  },
  {
    id: "en.fear.afraid_of",
    category: "fear",
    language: "en",
    confidence: "explicit",
    pattern:
      /\b(afraid (of|for) (him|her|them|my (safety|life))|scared of (him|her|them)|(feel|felt) unsafe|not safe (at home|with him|with her))\b/i,
    note: "Fear with the object named. Bare 'afraid' is excluded ('afraid I was wrong').",
  },
  {
    id: "en.fear.eggshells",
    category: "fear",
    language: "en",
    confidence: "ambiguous",
    pattern: /\bwalking on eggshells\b/i,
    note: "A strong marker used loosely; escalates rather than refuses.",
  },

  /* ---- monitoring ------------------------------------------------------- */
  {
    id: "zh.monitoring.searches_device",
    category: "monitoring",
    language: "zh",
    confidence: "explicit",
    pattern:
      /(查|翻|偷看)(我的?)?(手机|微信|聊天记录|通话记录|相册|邮件|包)|登录我的(账号|微信|邮箱)/,
    note: "Searching the other person's device or accounts.",
  },
  {
    id: "zh.monitoring.tracking",
    category: "monitoring",
    language: "zh",
    confidence: "explicit",
    pattern:
      /(定位|跟踪|监视|监控)(我|他|她)|查(我的?)定位|装(了)?(监控|定位|跟踪软件)|(要求|逼)我.{0,4}共享位置/,
    note: "Location tracking and surveillance software.",
  },
  {
    id: "zh.monitoring.check_ins",
    category: "monitoring",
    language: "zh",
    confidence: "ambiguous",
    pattern: /查岗|报备行程|随时(汇报|报告)(行程|位置)|夺命连环call|一直打电话/,
    note:
      "Check-in demands. Couples negotiate these consensually, which is why " +
      "they are ambiguous rather than decisive.",
  },
  {
    id: "en.monitoring.tracking",
    category: "monitoring",
    language: "en",
    confidence: "explicit",
    pattern:
      /\b(track(s|ing)? my (location|phone)|reads? my (messages|texts|emails)|checks? my phone|going through my phone|stalk(s|ing|ed)|spyware|shows? up (at|outside) my)\b/i,
    note: "Surveillance in English, all object-anchored.",
  },

  /* ---- coercive control ------------------------------------------------- */
  {
    id: "zh.control.forbids_movement",
    category: "coercive_control",
    language: "zh",
    confidence: "explicit",
    pattern:
      /不让我(出门|上班|工作|回家|见|联系|走)|不许我|不准我|禁止我|不让我(和|跟)(朋友|家人|同事)(联系|来往|见面)/,
    note: "Restriction of movement and contact — the core of coercive control.",
  },
  {
    id: "zh.control.finances_documents",
    category: "coercive_control",
    language: "zh",
    confidence: "explicit",
    pattern:
      /(拿走|抢走|扣着|藏了|没收)(我的)?(身份证|护照|手机|工资|银行卡|钱)|把我的?(身份证|护照|手机|工资|银行卡|钱).{0,8}(拿走|抢走|扣|藏|收走|没收)|控制(我的)?(钱|财|经济|工资|生活)|断了?我的?(经济|生活费)/,
    note:
      "Economic control and confiscation of documents. The second alternative " +
      "is the 把 construction — 「把我的身份证拿走了」 puts the object before " +
      "the verb, which is the more natural phrasing of exactly this complaint " +
      "and which a verb-first pattern alone silently misses.",
  },
  {
    id: "zh.control.coerced_acts",
    category: "coercive_control",
    language: "zh",
    confidence: "explicit",
    pattern: /(逼|强迫|胁迫)我.{0,6}(去|做|说|签|发|删|承认|道歉)|(孤立|隔绝)我/,
    note: "Being made to act. 逼 alone is excluded ('逼自己冷静').",
  },
  {
    id: "zh.control.permission",
    category: "coercive_control",
    language: "zh",
    confidence: "ambiguous",
    pattern: /必须经过(他|她)(的)?(同意|允许)|没有(他|她)的允许|(他|她)决定我所有/,
    note: "Permission structures. Some couples describe joint decisions this way.",
  },
  {
    id: "en.control.restriction",
    category: "coercive_control",
    language: "en",
    confidence: "explicit",
    pattern:
      /\b(won'?t let me (leave|go out|work|see|visit)|controls? (my|the) (money|finances|phone|friends)|isolat(e|ed|ing) me|forced me to|took my (passport|phone|id|wages))\b/i,
    note: "Restriction, economic control and confiscation in English.",
  },

  /* ---- self-harm -------------------------------------------------------- */
  {
    id: "zh.selfharm.explicit",
    category: "self_harm",
    language: "zh",
    confidence: "explicit",
    pattern:
      /自杀|轻生|自残|割腕|跳楼|吞(了|安眠)?药|了结(自己|生命)|结束(自己的)?生命|不想活|活不下去|一了百了|死了算了/,
    note:
      "Named self-harm and the settled Chinese formulas for it. 「累死了」/" +
      "「笑死」 cannot match: every alternative here is anchored on a word, " +
      "not on the bare character 死.",
  },
  {
    id: "zh.selfharm.threatened_by_other",
    category: "self_harm",
    language: "zh",
    confidence: "explicit",
    pattern: /(他|她|我).{0,6}就(去)?死|以死(相逼|威胁)/,
    note:
      "Suicide used as leverage ('你要是走我就去死') — a self-harm risk and a " +
      "control tactic at once. Recorded here; the model layer may add the " +
      "coercive-control reading.",
  },
  {
    id: "zh.selfharm.want_to_die",
    category: "self_harm",
    language: "zh",
    confidence: "ambiguous",
    pattern: /我(真|好|很)?想死(?!你)/,
    note:
      "『我想死』. The lookahead is load-bearing: 「我想死你了」 means 'I miss " +
      "you terribly' and is an endearment, not a crisis.",
  },
  {
    id: "en.selfharm.explicit",
    category: "self_harm",
    language: "en",
    confidence: "explicit",
    pattern:
      /\b(kill myself|suicid(e|al)|end my life|self[- ]harm|cutting myself|hurt myself|better off dead|don'?t want to (live|be here))\b/i,
    note: "Named self-harm in English.",
  },
];

/* -------------------------------------------------------------------------- */
/* Scanning                                                                   */
/* -------------------------------------------------------------------------- */

/** One piece of text to scan, tagged with where it came from. */
export interface SafetySource {
  /** Row id (utterance id, question id) — carried into the signal for audit. */
  readonly id: string;
  readonly kind: "utterance" | "answer";
  /** The text itself, in whatever language it was written. Never normalized. */
  readonly text: string;
}

/**
 * One deterministic hit.
 *
 * `origin` distinguishes a pattern match from a direct questionnaire answer:
 * both are local and both are decisive, but only one of them is a guess about
 * language.
 */
export interface SafetySignal {
  readonly origin: "pattern" | "question";
  /** `SafetyPattern.id`, or the question id for a direct answer. */
  readonly ruleId: string;
  readonly category: SafetyFlagCategory;
  readonly confidence: PatternConfidence;
  /** `SafetySource.id` the signal came from. */
  readonly sourceId: string;
  readonly sourceKind: SafetySource["kind"];
  /**
   * The matched fragment, verbatim and untranslated. Kept in memory for the
   * rationale a human reads; never sent anywhere, and never persisted — the
   * text already lives in `utterances`.
   */
  readonly excerpt: string;
}

/** Characters of context kept on each side of a match in `excerpt`. */
const EXCERPT_PADDING = 12;

/** Every pattern hit in one string. Pure; safe to call in any order. */
export function scanText(source: SafetySource): SafetySignal[] {
  const signals: SafetySignal[] = [];
  if (source.text.trim() === "") return signals;

  for (const rule of SAFETY_PATTERNS) {
    // A fresh global copy per scan: the declared regexes stay stateless, so two
    // calls with the same input can never disagree.
    const global = new RegExp(
      rule.pattern.source,
      rule.pattern.flags.includes("g")
        ? rule.pattern.flags
        : `${rule.pattern.flags}g`,
    );

    for (const match of source.text.matchAll(global)) {
      const at = match.index ?? 0;
      signals.push({
        origin: "pattern",
        ruleId: rule.id,
        category: rule.category,
        confidence: rule.confidence,
        sourceId: source.id,
        sourceKind: source.kind,
        excerpt: source.text.slice(
          Math.max(0, at - EXCERPT_PADDING),
          at + match[0].length + EXCERPT_PADDING,
        ),
      });
    }
  }

  return signals;
}

/** Every pattern hit across a set of sources. */
export function scanForSafetySignals(
  sources: readonly SafetySource[],
): SafetySignal[] {
  return sources.flatMap((source) => scanText(source));
}

/* -------------------------------------------------------------------------- */
/* Decision                                                                   */
/* -------------------------------------------------------------------------- */

/** What the local layer concluded. */
export interface LocalSafetyScreen {
  readonly signals: readonly SafetySignal[];
  /** Distinct categories hit, in `SAFETY_FLAG_CATEGORIES` order. */
  readonly categories: readonly SafetyFlagCategory[];
  readonly riskLevel: SafetyRiskLevel;
  /** `refer` the moment anything matched at all — see commitment 1. */
  readonly decision: "pass" | "refer";
  /** English prose for `safety_screens.rationale`. Carries no evidence text. */
  readonly rationale: string;
}

/**
 * Turn signals into a decision.
 *
 * The whole rule, stated once: **nothing matched → pass; anything matched →
 * refer.** `riskLevel` records how sure the layer was, and is what the audit
 * row and the referral page show, but it does not change the action. That is
 * deliberate — a threshold between "ambiguous" and "act" is precisely where a
 * recall-tuned gate would quietly become a precision-tuned one.
 */
export function combineSafetySignals(
  signals: readonly SafetySignal[],
): LocalSafetyScreen {
  if (signals.length === 0) {
    return {
      signals: [],
      categories: [],
      riskLevel: "none",
      decision: "pass",
      rationale:
        "Local safety rules found no fear, threat, monitoring, coercive-control, " +
        "violence or self-harm pattern in the questionnaire answers or the " +
        "confirmed material.",
    };
  }

  const categories = SAFETY_FLAG_CATEGORIES.filter((category) =>
    signals.some((signal) => signal.category === category),
  );
  const explicit = signals.filter((s) => s.confidence === "explicit");
  const riskLevel: SafetyRiskLevel = explicit.length > 0 ? "high" : "elevated";

  const ruleIds = [...new Set(signals.map((s) => s.ruleId))].sort();
  const where = [...new Set(signals.map((s) => s.sourceKind))].sort().join(" and ");
  const labels = categories.map((c) => SAFETY_CATEGORY_LABELS[c]).join("; ");

  const rationale =
    riskLevel === "high"
      ? `Local safety rules matched ${signals.length} phrase(s) in the ${where} ` +
        `text, ${explicit.length} of them unambiguous. Categories: ${labels}. ` +
        `Rules: ${ruleIds.join(", ")}.`
      : `Local safety rules matched ${signals.length} phrase(s) in the ${where} ` +
        `text. Every match was an ambiguous one, which escalates rather than ` +
        `passes: the phrase has an innocent reading, and this gate is not the ` +
        `place to bet on it. Categories: ${labels}. Rules: ${ruleIds.join(", ")}.`;

  return { signals, categories, riskLevel, decision: "refer", rationale };
}

/** Scan and decide in one call — the shape the gate uses. */
export function screenForSafety(
  sources: readonly SafetySource[],
  extraSignals: readonly SafetySignal[] = [],
): LocalSafetyScreen {
  return combineSafetySignals([
    ...extraSignals,
    ...scanForSafetySignals(sources),
  ]);
}
