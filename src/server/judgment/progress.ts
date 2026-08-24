/**
 * The "hearing in progress" channel — SPEC M3 wave B ⑧.
 *
 * A judgment takes a long time to produce and the user is staring at a screen
 * while it does. The obvious fix is to stream the text as it arrives. This
 * module exists to make that impossible.
 *
 * The rule from SPEC ⑧ is that the stream carries only summarized thinking and
 * stage heartbeats, and that the judgment body is buffered, persisted,
 * validated and published in one piece. The reason is not aesthetic: a
 * half-streamed judgment has already been read by the time the validator
 * rejects it. A claim citing an utterance that does not exist, a narrative
 * section resting on a claim the skeleton never made, a responsibility
 * allocation at a level that forbids one — every check in
 * `judgment/generation.ts` runs after the model has finished, and anything the
 * user saw before that point was unchecked by construction. You cannot un-show
 * a sentence.
 *
 * ## How that is enforced rather than intended
 *
 * The event type is a closed union whose string fields are **not the caller's
 * to fill in**. Every constructor below takes a phase, a count or an id, and
 * looks the human-readable text up in a table in this file. There is no
 * `message: string` parameter anywhere on the way to the wire, so a caller
 * cannot pass model output into a progress event even by mistake — and the
 * failure events in particular carry a code, never the fault report, because
 * that report quotes the model's own statements back (see
 * `describeCitationFaults`). The detail goes to the server-side result the
 * caller already holds; the stream gets the code.
 *
 * `heartbeat` carries an elapsed millisecond count, which is a fact about the
 * request rather than about the record, and it is the only number that moves
 * between two runs of the same case. Nothing else here reads a clock.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/** The phases a hearing moves through, in order. */
export const JUDGMENT_PHASES = [
  /** Reading the confirmed record and assembling the dossier. */
  "assembling",
  /** The skeleton call: claims, grounded and tiered. */
  "fact_finding",
  /** The narrative call: prose, bound to the skeleton's claims. */
  "drafting",
  /** Server-side checks against the record and the contract. */
  "validating",
  /** Freezing the draft and minting its renditions. */
  "publishing",
] as const;
export type JudgmentPhase = (typeof JUDGMENT_PHASES)[number];

/**
 * What the user is told is happening, per phase.
 *
 * Code-owned strings. This is the entire vocabulary of the "summarized
 * thinking" display: the gateway does not stream thinking deltas (`runStage` is
 * a buffered call), so what a viewer sees is the server narrating its own
 * progress — which is honest, and cannot leak a sentence of the judgment
 * because no sentence of the judgment is reachable from here.
 */
const PHASE_SUMMARY: Readonly<Record<JudgmentPhase, string>> = {
  assembling:
    "Reading the confirmed record: the evidence, the issues as they were " +
    "fixed, and what came back from clarification.",
  fact_finding:
    "Working out what the record can and cannot establish, and grounding each " +
    "finding in the lines it rests on.",
  drafting: "Writing the judgment from the findings.",
  validating:
    "Checking every citation against the record and every paragraph against " +
    "the findings.",
  publishing: "Filing the judgment.",
};

/** Why a hearing ended without a judgment. Codes only — never model text. */
export const JUDGMENT_FAILURE_CODES = [
  /** The adverse-fact gate, the missing lock, or an unmet precondition. */
  "blocked",
  /** Nothing in the case is confirmed, so nothing can be adjudicated. */
  "no_material",
  /** A server-side check rejected the generation twice. */
  "rejected",
  /** The model declined. */
  "refused",
  /** Transport, provider or persistence failure. */
  "error",
] as const;
export type JudgmentFailureCode = (typeof JUDGMENT_FAILURE_CODES)[number];

/**
 * What a viewer is told about a failure.
 *
 * Deliberately incurious: the full fault report names claims and quotes the
 * model's statements back, and the stream is the one place that report must not
 * go. The caller of `generateJudgment` receives the detail and decides what to
 * render on the page, where it can be shown once, whole, after the fact.
 */
const FAILURE_MESSAGE: Readonly<Record<JudgmentFailureCode, string>> = {
  blocked:
    "The hearing cannot start yet — something it depends on is not settled.",
  no_material:
    "Nothing in this case has been confirmed, so there is nothing a judgment " +
    "could be grounded in.",
  rejected:
    "The hearing produced a judgment that did not hold up against the record, " +
    "twice. Nothing was saved.",
  refused: "The model declined this case.",
  error: "The hearing failed before it produced anything.",
};

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Everything that may reach a viewer while a judgment is being produced.
 *
 * Note what is absent: there is no event carrying a claim, a section, a quote,
 * a heading or a sentence of prose. The type is the guarantee.
 */
export type JudgmentProgressEvent =
  | {
      readonly type: "thinking";
      /** SPEC ⑧ permits summarized thinking and nothing else. */
      readonly display: "summarized";
      readonly phase: JudgmentPhase;
      /** From `PHASE_SUMMARY`. Never caller-supplied. */
      readonly summary: string;
    }
  | { readonly type: "heartbeat"; readonly elapsedMs: number }
  | {
      readonly type: "phase";
      readonly phase: JudgmentPhase;
      readonly status: "started" | "finished";
    }
  /** The judgment exists and is published. The body is fetched separately. */
  | {
      readonly type: "done";
      readonly judgmentId: string;
      readonly version: number;
    }
  | {
      readonly type: "failed";
      readonly code: JudgmentFailureCode;
      /** From `FAILURE_MESSAGE`. Never caller-supplied. */
      readonly message: string;
    };

/** Summarized thinking for one phase. The text comes from the table above. */
export function thinkingEvent(phase: JudgmentPhase): JudgmentProgressEvent {
  return {
    type: "thinking",
    display: "summarized",
    phase,
    summary: PHASE_SUMMARY[phase],
  };
}

export function phaseEvent(
  phase: JudgmentPhase,
  status: "started" | "finished",
): JudgmentProgressEvent {
  return { type: "phase", phase, status };
}

/** A liveness tick. The only value here that moves between runs. */
export function heartbeatEvent(elapsedMs: number): JudgmentProgressEvent {
  return { type: "heartbeat", elapsedMs: Math.max(0, Math.round(elapsedMs)) };
}

export function doneEvent(
  judgmentId: string,
  version: number,
): JudgmentProgressEvent {
  return { type: "done", judgmentId, version };
}

/** A failure, as a code. The report stays server-side. */
export function failedEvent(code: JudgmentFailureCode): JudgmentProgressEvent {
  return { type: "failed", code, message: FAILURE_MESSAGE[code] };
}

/** Where a hearing has got to, for a polling client. */
export type JudgmentProgressState = "idle" | "running" | "done" | "failed";

/* -------------------------------------------------------------------------- */
/* The wire format                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One event as an SSE frame.
 *
 * Total over the union, so adding a variant without deciding how it is encoded
 * is a compile error rather than an event that silently serializes whatever
 * fields it happens to carry.
 */
export function encodeProgressEvent(event: JudgmentProgressEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/* -------------------------------------------------------------------------- */
/* The hub                                                                    */
/* -------------------------------------------------------------------------- */

interface CaseChannel {
  state: JudgmentProgressState;
  /** Replayed to a late subscriber so a reconnect is not a blank screen. */
  events: JudgmentProgressEvent[];
  listeners: Set<(event: JudgmentProgressEvent) => void>;
}

/** How many events one case keeps for replay. A hearing emits far fewer. */
const REPLAY_LIMIT = 64;

/**
 * In-process fan-out from a running hearing to whoever is watching it.
 *
 * Single-user, single-process product (CLAUDE.md), so a module-level Map is the
 * right size for this: no broker, no persistence, and a restart simply loses a
 * progress display, never a judgment — the judgment is in SQLite and the
 * hearing that writes it does not depend on anyone listening.
 */
class JudgmentProgressHub {
  private readonly channels = new Map<string, CaseChannel>();

  private channel(caseId: string): CaseChannel {
    let channel = this.channels.get(caseId);
    if (channel === undefined) {
      channel = { state: "idle", events: [], listeners: new Set() };
      this.channels.set(caseId, channel);
    }
    return channel;
  }

  /** Mark a hearing as started, clearing whatever the last one left behind. */
  start(caseId: string): void {
    const channel = this.channel(caseId);
    channel.state = "running";
    channel.events = [];
  }

  publish(caseId: string, event: JudgmentProgressEvent): void {
    const channel = this.channel(caseId);
    if (event.type === "done") channel.state = "done";
    if (event.type === "failed") channel.state = "failed";

    channel.events.push(event);
    if (channel.events.length > REPLAY_LIMIT) channel.events.shift();

    for (const listener of channel.listeners) {
      // One broken subscriber (a closed stream) must not stop the others, and
      // must never stop the hearing — this is a display, not a dependency.
      try {
        listener(event);
      } catch {
        /* c8 ignore next -- a dead listener is dropped on its own close. */
      }
    }
  }

  /** Subscribe; returns the unsubscribe. Past events are NOT auto-replayed. */
  subscribe(
    caseId: string,
    listener: (event: JudgmentProgressEvent) => void,
  ): () => void {
    const channel = this.channel(caseId);
    channel.listeners.add(listener);
    return () => {
      channel.listeners.delete(listener);
    };
  }

  /** What a polling client needs: the state and everything so far. */
  snapshot(caseId: string): {
    readonly state: JudgmentProgressState;
    readonly events: readonly JudgmentProgressEvent[];
  } {
    const channel = this.channels.get(caseId);
    if (channel === undefined) return { state: "idle", events: [] };
    return { state: channel.state, events: [...channel.events] };
  }

  /** Drop a case's channel. Tests use it; nothing in a server path needs it. */
  reset(caseId?: string): void {
    if (caseId === undefined) this.channels.clear();
    else this.channels.delete(caseId);
  }
}

export const judgmentProgress = new JudgmentProgressHub();
