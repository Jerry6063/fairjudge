/**
 * Crisis resources and referral copy — HARD RULE #9, in file form.
 *
 * The rule: *when a safety red flag fires, hotline/resource information renders
 * with zero latency and no LLM in the loop.* The way to keep a promise like
 * that is not to be careful at the call site; it is to make the call site
 * impossible. So this module is a constant. It imports nothing — not the
 * database, not the gateway, not a formatter — which means the referral page
 * can render it with the entire LLM module mocked to throw on import, and the
 * test that proves it is a real proof rather than an assertion of intent.
 *
 * Everything here is English (the system's own words). Hotline names carry
 * their official local name as well, because a person dialling 12338 needs to
 * recognise what they are calling, and an English gloss is not what will be on
 * the other end of the line.
 *
 * MAINTENANCE: these numbers are curated by hand and must be re-checked by a
 * human before any release. A dead hotline number on this page is the single
 * worst bug this repository can ship — worse than a wrong judgment, because a
 * wrong judgment can be argued with. There is deliberately no code path that
 * fetches, generates or "improves" this list.
 */

/** Where a resource applies. `intl` entries work from anywhere. */
export type ResourceRegion = "cn" | "us" | "intl";

export interface CrisisResource {
  readonly id: string;
  readonly region: ResourceRegion;
  /** English label. */
  readonly name: string;
  /** Official name in its own language, when that is what the caller will meet. */
  readonly localName?: string;
  /** What to dial, text, or open. Rendered verbatim, never reformatted. */
  readonly contact: string;
  /** When it answers. */
  readonly hours: string;
  /** One line on what it is for. */
  readonly description: string;
}

/** Grouping headers, so the page does not have to invent them. */
export const REGION_LABELS: Readonly<Record<ResourceRegion, string>> = {
  cn: "Mainland China",
  us: "United States and Canada",
  intl: "Anywhere",
};

/**
 * The list. Ordered so that the fastest route to a human is first within each
 * region, and China first overall because that is where this case's material
 * comes from.
 */
export const CRISIS_RESOURCES: readonly CrisisResource[] = [
  {
    id: "cn.emergency",
    region: "cn",
    name: "Police emergency",
    localName: "报警电话",
    contact: "110",
    hours: "24 hours",
    description:
      "For immediate danger. Domestic violence can be reported here, and the " +
      "police can issue a written warning (家庭暴力告诫书) that becomes part of " +
      "the record.",
  },
  {
    id: "cn.womens-federation",
    region: "cn",
    name: "Women's Federation rights and support line",
    localName: "全国妇联妇女维权公益服务热线",
    contact: "12338",
    hours: "Staffed hours vary by province; many lines answer 24 hours",
    description:
      "Free help with domestic violence, personal-safety protection orders, " +
      "and referral to legal aid and shelters.",
  },
  {
    id: "cn.psychological-support",
    region: "cn",
    name: "National psychological support line",
    localName: "全国统一心理援助热线",
    contact: "12356",
    hours: "24 hours",
    description:
      "Free counselling by phone for distress, crisis and suicidal thoughts.",
  },
  {
    id: "cn.beijing-crisis",
    region: "cn",
    name: "Beijing Suicide Research and Prevention Center hotline",
    localName: "北京心理危机研究与干预中心热线",
    contact: "010-8295-1332",
    hours: "24 hours",
    description:
      "A long-running crisis line that takes calls from anywhere in the country.",
  },
  {
    id: "us.988",
    region: "us",
    name: "Suicide and Crisis Lifeline",
    contact: "Call or text 988",
    hours: "24 hours",
    description:
      "Free and confidential support for suicidal thoughts, emotional distress, " +
      "and crises of any kind.",
  },
  {
    id: "us.dv-hotline",
    region: "us",
    name: "National Domestic Violence Hotline",
    contact: "1-800-799-7233, or text START to 88788",
    hours: "24 hours",
    description:
      "Advocates for anyone experiencing abuse, including safety planning and " +
      "local shelter referrals.",
  },
  {
    id: "intl.find-a-helpline",
    region: "intl",
    name: "International helpline directory",
    contact: "findahelpline.com",
    hours: "Directory, always available",
    description:
      "Free helplines by country, for crisis support in your own language.",
  },
  {
    id: "intl.emergency",
    region: "intl",
    name: "Local emergency services",
    contact: "110 (mainland China) · 911 (US/Canada) · 112 (EU) · 999 (UK)",
    hours: "24 hours",
    description: "If you are in danger right now, this is the first call.",
  },
];

/** Resources for one region, in list order. */
export function resourcesForRegion(
  region: ResourceRegion,
): readonly CrisisResource[] {
  return CRISIS_RESOURCES.filter((resource) => resource.region === region);
}

/** Regions that have at least one resource, in display order. */
export const RESOURCE_REGIONS: readonly ResourceRegion[] = [
  "cn",
  "us",
  "intl",
] as const;

/* -------------------------------------------------------------------------- */
/* Referral copy                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The explanation, in plain language, of why the adjudication frame was exited.
 *
 * Written to say three things and no others: what the system noticed, what it
 * has therefore stopped doing, and what it has NOT concluded. The last one is
 * the delicate part — "we are not judging this" must not be heard as "we are
 * judging that you are the problem", and it must not be softened into a verdict
 * either.
 */
export const REFERRAL_HEADLINE = "This case has left the judgment pipeline.";

export const REFERRAL_EXPLANATION: readonly string[] = [
  "The safety screen found something in this case that a judgment cannot help " +
    "with. When fear, threats, monitoring, control, violence, or a risk of " +
    "self-harm is present, working out who was right about the argument is the " +
    "wrong question, and answering it anyway can make things worse.",
  "So the pipeline stopped here. Nothing will be weighed, no responsibility " +
    "will be allocated, and no verdict will be written for this case. That is a " +
    "decision about the situation, not a finding about you.",
  "What is below is a list of people who can actually help, kept on this " +
    "device. It is fixed text: no model was asked anything to produce this page, " +
    "and nothing about your case was sent anywhere to render it.",
];

/** One line under the resource block. */
export const REFERRAL_RESOURCE_NOTE =
  "If you are in immediate danger, call your local emergency number first.";

/** What the user can still do. Kept short and concrete. */
export const REFERRAL_NEXT_STEPS: readonly string[] = [
  "Your material stays on this device, encrypted, exactly as you left it. " +
    "Nothing has been deleted.",
  "If the screen has misread the situation, the safety screen can be re-run " +
    "from the case's intake stage once the answers are corrected.",
];

/**
 * Language this path must never produce.
 *
 * The failure mode being blocked is specific and well documented: telling a
 * person in an abusive situation that responsibility is jointly held. It reads
 * as neutrality and lands as a verdict against the person who asked for help.
 * Any string rendered on the referral path is checked against this list in
 * `tests/safety-referral.test.ts`; the list is here rather than in the test so
 * that it is part of the product, not part of the test's opinion.
 */
export const FORBIDDEN_REFERRAL_PHRASES: readonly string[] = [
  "share responsibility",
  "shared responsibility",
  "responsibility is shared",
  "mutual responsibility",
  "both parties",
  "both of you",
  "you both",
  "each of you",
  "on both sides",
  "50/50",
  "two to tango",
  "双方都有责任",
  "两个人都有问题",
  "各打五十大板",
];

/**
 * Find forbidden phrases in a rendered string. Case-insensitive; returns the
 * offending phrases so a failure names them.
 */
export function findForbiddenReferralPhrases(text: string): string[] {
  const haystack = text.toLowerCase();
  return FORBIDDEN_REFERRAL_PHRASES.filter((phrase) =>
    haystack.includes(phrase.toLowerCase()),
  );
}
