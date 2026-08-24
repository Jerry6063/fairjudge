// `/respond/[token]/document` — the document, on the other end of the link.
//
// This route exists because the product had a third instance of the same defect.
// M4 shipped a shareable document ending "Add your side of it here: /respond"
// and `/respond` 404'd. M5 built `/respond/[token]`, and the mint button in the
// client's share panel produced `/respond/<share token>` — a token that route
// could not resolve, so the panel itself carried a warning telling the client
// not to hand the link over. The document was generated, gated, minted, and
// unreachable by anybody it was written to.
//
// Two things fix it, and both live on this side of the line. `resolveArrival`
// now accepts a share token as a credential (see `server/participation/door.ts`),
// so the minted link lands on the arrival screen instead of a refusal. And this
// route serves the text, for all three credentials:
//
//   * a **share token** goes through `readSharedRendition`, unchanged — it does
//     the expiry check and asks the consent log on every open, which is the one
//     place a withdrawal can still reach a copy already handed out;
//   * an **invite or identity token** is the recipient's own credential, and the
//     shareable rendition is the copy addressed to her (doc 05 §A.3: the
//     judgment document is the only aperture, and this is her side of it). The
//     consent question is asked here too, in the same words, through the same
//     `assertNamedRenditionAllowed` the export gate and the mint path use.
//
// The document is a link from the arrival screen and never inlined into it (doc
// 05 §A.5 question 2): reading it has to be her decision rather than the
// consequence of opening a page somebody sent her.

import { NamedRenditionRevokedError } from "../../../../server/access";
import { assertNamedRenditionAllowed } from "../../../../server/access/consent";
import { getDb, type Db } from "../../../../server/db";
import { RenditionError, readJudgment, readSharedRendition } from "../../../../server/judgment";
import { previewShareableDocument } from "../../../../server/judgment/share-view";
import {
  entryHrefs,
  latestFinalJudgmentId,
} from "../../../../server/participation/entry";
import { resolveRespondingParty } from "../../../../server/participation/submission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Resolving the text                                                         */
/* -------------------------------------------------------------------------- */

type DocumentOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly heading: string; readonly message: string };

/**
 * The share-token path: `readSharedRendition`, untouched.
 *
 * Tried first and independently of whether the token also resolves a
 * participant, because it carries checks this route has no business
 * re-implementing — the rendition's own expiry, its `shareable` flag, and the
 * consent question asked on every single open.
 */
function fromShareToken(db: Db, token: string): DocumentOutcome | null {
  try {
    return { ok: true, text: readSharedRendition(db, token).text };
  } catch (cause) {
    if (cause instanceof NamedRenditionRevokedError) {
      return { ok: false, heading: "This document is not being served", message: cause.message };
    }
    if (cause instanceof RenditionError) return null;
    throw cause;
  }
}

/**
 * The recipient's own path: her credential, the copy written to her.
 *
 * The consent gate is asked before a document is derived, not after, so a party
 * who has withdrawn cannot be handed the text by the error path. What she gets
 * back in that case is the refusal's own words, which name who withdrew and
 * when — including when the person who withdrew is her.
 */
function fromOwnCredential(db: Db, caseId: string): DocumentOutcome {
  const judgmentId = latestFinalJudgmentId(db, caseId);
  if (judgmentId === null) {
    return {
      ok: false,
      heading: "Nothing has been written about this case yet",
      message:
        "No analysis of this case has been finished, so there is no document " +
        "to read. What exists is the material described on the first screen.",
    };
  }

  try {
    assertNamedRenditionAllowed({ db, caseId });
  } catch (cause) {
    if (cause instanceof NamedRenditionRevokedError) {
      return { ok: false, heading: "This document is not being served", message: cause.message };
    }
    throw cause;
  }

  const judgment = readJudgment(db, judgmentId);
  /* c8 ignore next 8 -- the id came from a final row a line earlier. */
  if (judgment === null) {
    return {
      ok: false,
      heading: "Nothing has been written about this case yet",
      message: "No finished analysis of this case is on file.",
    };
  }

  try {
    return { ok: true, text: previewShareableDocument(db, judgment) };
  } catch (cause) {
    if (cause instanceof RenditionError) {
      return {
        ok: false,
        heading: "The document is not ready",
        message:
          "An analysis exists, but the copy written to you has not been " +
          "produced yet. Nothing is hidden from you by this — there is no " +
          "second version being kept back.",
      };
    }
    throw cause;
  }
}

/* -------------------------------------------------------------------------- */
/* The page                                                                   */
/* -------------------------------------------------------------------------- */

export default async function RespondDocumentPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const db = getDb();
  const hrefs = entryHrefs(token);

  // A render is not an act (doc 05 §A.5): reading the document written about her
  // is not reported to the person who wrote it, and nothing here writes a row.
  const party = resolveRespondingParty(db, token, { touch: false });
  const outcome =
    fromShareToken(db, token) ??
    (party === null
      ? {
          ok: false as const,
          heading: "This link does not open anything",
          message:
            "It is not one this machine issued, it has expired, or it was " +
            "replaced by a newer one. Nothing has been recorded by your opening it.",
        }
      : fromOwnCredential(db, party.participant.caseId));

  return (
    <>
      <header className="flex flex-col gap-2">
        <p className="text-xs tracking-wide text-neutral-500 uppercase">
          <a href={hrefs.entry} className="underline underline-offset-2">
            Back to the start
          </a>
        </p>
        <h1 className="text-lg font-medium text-neutral-900">
          {outcome.ok ? "The document written about this case" : outcome.heading}
        </h1>
      </header>

      {outcome.ok ? (
        <>
          <p className="text-sm leading-relaxed text-neutral-600">
            This is the copy addressed to you, exactly as it was produced —
            nothing on this page shortens it, summarizes it or re-words it. It
            was written from one account, and it says so in its own text. You
            have not agreed to anything by reading it.
          </p>
          {/* The document is a record. It renders as written: no trimming, no
              paraphrase, no highlighting of anything a component thought was
              important. */}
          <article className="rounded-xl border border-neutral-200 bg-white p-5 text-sm leading-relaxed whitespace-pre-wrap text-neutral-900">
            {outcome.text}
          </article>
        </>
      ) : (
        <p className="text-sm leading-relaxed text-neutral-700">
          {outcome.message}
        </p>
      )}

      <section className="flex flex-col gap-3 border-t border-neutral-200 pt-4">
        <p className="text-sm leading-relaxed text-neutral-600">
          Reading this changes nothing about your position. The three things you
          can do are the same ones as on the first screen, and they carry the
          same weight as each other.
        </p>
        <ul className="grid gap-3 sm:grid-cols-3">
          {[
            { href: hrefs.addYourAccount, label: "Add your account" },
            { href: hrefs.decline, label: "Record that you are not taking part" },
            { href: hrefs.transparency, label: "Read everything held about you" },
          ].map((exit) => (
            <li key={exit.href} className="flex">
              <a
                href={exit.href}
                className="flex w-full items-center rounded-xl border border-neutral-300 p-4 text-sm font-medium text-neutral-900 hover:bg-neutral-50"
              >
                {exit.label}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
