// The "hearing in progress" stream — SPEC M3 wave B ⑧.
//
// Server-sent events, and what it may send is decided by a type rather than by
// this file: it subscribes to the in-process progress hub and forwards
// `JudgmentProgressEvent`s through `encodeProgressEvent`. That union has no
// field a claim, a section, a heading or a quote could be written into, so the
// judgment body cannot reach a viewer here — it is fetched from the judgment
// page after `finalize` has frozen it (`judgment/progress.ts` explains why the
// alternative is unfixable: you cannot un-show a sentence that turned out to
// rest on a citation that does not exist).
//
// The stream is a display, never a dependency. It does not start a hearing, and
// closing it does not stop one — the hearing is a POST to the sibling route,
// running against SQLite whether or not anyone is watching.

import {
  encodeProgressEvent,
  judgmentProgress,
  type JudgmentProgressEvent,
} from "../../../../../../server/judgment";

export const runtime = "nodejs";
/** An event stream must not be buffered by a static optimizer. */
export const dynamic = "force-dynamic";

type Params = { readonly params: Promise<{ readonly id: string }> };

/** Liveness tick, so a proxy does not decide the connection is idle. */
const HEARTBEAT_MS = 15_000;

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const { id: caseId } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;

      const send = (event: JudgmentProgressEvent): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(encodeProgressEvent(event)));
        } catch {
          /* c8 ignore next -- the client went away mid-enqueue. */
          open = false;
        }
      };

      // Replay what has happened so far, so a viewer who arrives late (or
      // reconnects) sees the phase the hearing is in rather than a blank panel.
      for (const event of judgmentProgress.snapshot(caseId).events) send(event);

      const unsubscribe = judgmentProgress.subscribe(caseId, send);
      const ticker = setInterval(() => {
        // An SSE comment: liveness without inventing a progress event.
        if (open) controller.enqueue(encoder.encode(": ping\n\n"));
      }, HEARTBEAT_MS);

      const close = (): void => {
        if (!open) return;
        open = false;
        clearInterval(ticker);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* c8 ignore next -- already closed by the runtime. */
        }
      };

      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
    },
  });
}
