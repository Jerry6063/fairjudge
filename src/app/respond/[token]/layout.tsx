// /respond/[token] — the shell around the other party's entry (SPEC M5 ②).
//
// Deliberately not the case shell. `/case/[id]/layout.tsx` gives every stage the
// stepper, the output-level badge and a link home, and all three would be wrong
// here: this route is opened by the person the case is *about*, holding a link
// and nothing else, and the client's workspace is not hers to walk into. So the
// frame carries no navigation at all — no "Home", no stage list, nothing that
// resolves anywhere under /case, /evidence or /timeline.
//
// That absence is a property, not a preference, and `tests/respond-entry.test.ts`
// asserts it: the rendered page must contain no href into the client's side of
// the product. A link is the kind of thing that gets added by habit, so it is
// tested rather than trusted.
//
// The chrome is otherwise plain on purpose. Every heading, badge and colour on
// this page belongs to the disclosure it sits on; a product frame around it
// would be the machine introducing itself before it says what it has been doing.

import type { ReactNode } from "react";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function RespondLayout({ children }: { children: ReactNode }) {
  return (
    // Pinned light surface for the same reason the case shell pins one: the
    // cards are white, and a dark UA colour scheme would leave the headings
    // unreadable on a page somebody was handed rather than chose.
    <main className="min-h-screen bg-white text-neutral-900">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6 sm:p-10">
        {children}

        <footer className="mt-auto border-t border-neutral-200 pt-4">
          <p className="text-xs leading-relaxed text-neutral-500">
            This page was produced by a program running on one person&rsquo;s
            computer. It has no address for you and cannot contact you: the link
            that brought you here was handed over by a person, not sent by the
            machine. Nothing you read here has been shared with anyone, and
            nothing on this page is sent anywhere by opening it.
          </p>
        </footer>
      </div>
    </main>
  );
}
