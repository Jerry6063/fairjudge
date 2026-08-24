// UI vocabulary for evidence management.
//
// The server speaks in codes (`grade_suggested`, `GradeReason`,
// `RegistrationKind`); this is the only place those codes become sentences a
// person reads. Keeping the mapping here — rather than storing prose in the
// database — means the stored rationale stays a stable machine record and the
// wording can be rewritten without a migration.

import type {
  EvidenceGrade,
  GradeReason,
  RegistrationKind,
} from "../../lib/evidence-contract";

/** What each grade means, and how strongly it can carry a factual claim. */
export const GRADE_LABELS: Record<
  EvidenceGrade,
  { name: string; hint: string; badge: string }
> = {
  A: {
    name: "A first-hand",
    hint: "An original chat log or recording; can support a finding of fact directly",
    badge: "border-emerald-300 bg-emerald-50 text-emerald-900",
  },
  B: {
    name: "B recollection",
    hint: 'Recalled from memory; rendered as "as you recall it, they said…"',
    badge: "border-sky-300 bg-sky-50 text-sky-900",
  },
  C: {
    name: "C AI-processed",
    hint: "An AI session screenshot or summary; carries one side's framing and cannot settle a fact on its own",
    badge: "border-amber-300 bg-amber-50 text-amber-900",
  },
  D: {
    name: "D public content",
    hint: "A public post or comment section; reflects mood only and has nothing to do with the parties",
    badge: "border-rose-300 bg-rose-50 text-rose-900",
  },
};

/** Why the machine suggested that grade. */
export const REASON_LABELS: Record<GradeReason, string> = {
  source_type: "From the material type you registered",
  derived_from: "Derived from material already in the case",
  ai_artifact_detected: "Recognized as an AI session screenshot",
  mass_content_detected: "Recognized as public content for a mass audience",
};

/** The intake picker: what the uploader says they are handing in. */
export const KIND_LABELS: Record<RegistrationKind, string> = {
  screenshot: "Chat screenshot (default)",
  retelling: "Recollection / retelling",
  ai_session: "AI session screenshot",
  mass_content: "Online post / comments",
};

/** OCR bubble side stored on `utterances.speaker_label` before human review. */
export const SPEAKER_SIDE_LABELS: Record<string, string> = {
  left: "Left (the other party)",
  right: "Right (phone owner)",
  center: "Center (timestamp / system)",
};
