"use client";

// The act of handing this document over — the pause, the question, and the three
// doors, in one place because they are one decision.
//
// Doc 01 §post-judgment ③ asks for two things before a document like this is
// shared: a 24–48 hour pause, and the question "what do you want the other party
// to feel after reading this" asked once more — with a warning when the answer is
// "make them realize they were wrong". Both are implemented as real steps.
//
//   - The **pause** is not a timer this panel starts. It runs from when the
//     document was written, which is a stored fact, so it cannot be begun by
//     opening the page and cannot be waited out in another tab. This panel only
//     reports where it stands; the server re-reads it before anything leaves.
//   - The **question** is a sentence somebody has to write, not a box to tick.
//     An answer doc 01 names is refused on its first submission and comes back
//     with the warning attached; sending anyway is a separate, deliberate second
//     act with that warning on the screen.
//
// Both gates sit in front of BOTH doors. Hanging them on the share link alone
// would have been easy and worthless: the file is the door that actually puts an
// unrecallable copy on somebody else's machine.
//
// The ceiling of what those doors are is deliberate: a file, the clipboard, and a
// link somebody copies. No share sheet, no mail-to, no post-to-anything. The
// export gate refuses every social channel by name if something ever asks, and
// there is no code here that could.
//
// The button being enabled is never the gate. Every refusal below comes from the
// server, which reads the consent log, the cool-down and the export gate itself.

import { useState, useTransition } from "react";

import {
  exportShareableCopyAction,
  mintShareLinkAction,
  type ExportActionData,
  type MintActionData,
} from "./actions";

export interface CoolingOffProps {
  readonly state: "waiting" | "open" | "settled" | "undated";
  readonly anchorIso: string | null;
  readonly anchorLabel: string;
  readonly remainingHours: number;
  readonly elapsed: boolean;
}

type Channel = "file" | "clipboard";

interface TakenCopy {
  readonly data: ExportActionData;
  readonly channel: Channel;
  readonly delivered: boolean;
}

export function SendPanel({
  caseId,
  judgmentId,
  question,
  coolingOff,
  gateBlocked,
  consentBlocked,
  alreadyMinted,
}: {
  caseId: string;
  judgmentId: string;
  question: string;
  coolingOff: CoolingOffProps;
  gateBlocked: boolean;
  consentBlocked: boolean;
  alreadyMinted: boolean;
}) {
  const [intent, setIntent] = useState("");
  const [pending, startTransition] = useTransition();
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState<TakenCopy | null>(null);
  const [minted, setMinted] = useState<MintActionData | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  const blocked = gateBlocked || consentBlocked || !coolingOff.elapsed;
  const acknowledged = warning !== null;

  function takeCopy(channel: Channel) {
    setError(null);
    startTransition(async () => {
      const result = await exportShareableCopyAction({
        caseId,
        judgmentId,
        intent,
        acknowledgedWarning: acknowledged,
        channel,
      });
      if (!result.ok) {
        if (result.code === "intent_flagged") setWarning(result.message);
        else setError(result.message);
        return;
      }
      const delivered =
        channel === "file" ? download(result.data) : await copy(result.data.text);
      setWarning(null);
      setTaken({ data: result.data, channel, delivered });
    });
  }

  function mint() {
    setError(null);
    startTransition(async () => {
      const result = await mintShareLinkAction({
        caseId,
        judgmentId,
        intent,
        acknowledgedWarning: acknowledged,
      });
      if (!result.ok) {
        if (result.code === "intent_flagged") setWarning(result.message);
        else setError(result.message);
        return;
      }
      setWarning(null);
      setMinted(result.data);
    });
  }

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopiedLink(true);
    } catch {
      // Clipboard permission is the browser's to refuse. The link is on screen
      // and selectable either way, which is the fallback.
      setCopiedLink(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <CoolingOffNotice coolingOff={coolingOff} />

      <div className="flex flex-col gap-2">
        <label
          htmlFor="send-intent"
          className="text-sm font-medium text-neutral-900"
        >
          {question}
        </label>
        <p className="text-xs leading-relaxed text-neutral-600">
          Answer it in a sentence, in your own words, before anything leaves this
          machine. It is not stored anywhere — it is asked at the moment of
          sending, and an answer kept on a row would turn this into a form
          somebody filled in weeks ago.
        </p>
        <textarea
          id="send-intent"
          rows={3}
          value={intent}
          onChange={(event) => {
            setIntent(event.target.value);
            setWarning(null);
          }}
          placeholder="e.g. I want her to feel that I finally understood what she was asking for."
          className="w-full rounded-lg border border-neutral-300 bg-white p-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none"
        />
      </div>

      {warning !== null && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3"
        >
          <p className="text-xs font-medium tracking-wide text-amber-900 uppercase">
            Doc 01 asks this question in order to say this
          </p>
          <p className="text-sm leading-relaxed text-amber-900">{warning}</p>
          <p className="text-xs leading-relaxed text-amber-900">
            Nothing was sent. The buttons below now do what you asked the first
            time — that is the second, deliberate act, with this on the screen.
            Or answer it again.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setWarning(null);
              setIntent("");
            }}
            className="w-fit rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-xs text-amber-900 hover:bg-amber-100"
          >
            Answer it again
          </button>
        </div>
      )}

      {error !== null && (
        <p
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs leading-relaxed whitespace-pre-wrap text-rose-900"
        >
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2 border-t border-neutral-100 pt-4">
        <p className="text-sm font-medium text-neutral-900">
          Three ways to hand it over, and there is no fourth
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending || blocked || intent.trim() === ""}
            onClick={() => takeCopy("file")}
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm text-neutral-800 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:border-neutral-200 disabled:text-neutral-400"
          >
            {pending ? "Working…" : "Download the document"}
          </button>
          <button
            type="button"
            disabled={pending || blocked || intent.trim() === ""}
            onClick={() => takeCopy("clipboard")}
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm text-neutral-800 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:border-neutral-200 disabled:text-neutral-400"
          >
            Copy the document
          </button>
          <button
            type="button"
            disabled={pending || blocked || intent.trim() === ""}
            onClick={mint}
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm text-neutral-800 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:border-neutral-200 disabled:text-neutral-400"
          >
            Mint a link
          </button>
        </div>

        <p className="text-xs leading-relaxed text-neutral-600">
          The first two are exports. Each runs the gate and writes one row in the
          log below, carrying the sha256 of the exact bytes and the id stamped in
          their watermark — enough to identify a copy found later, without the log
          becoming a second place the judgment lives. There is no undo: once the
          bytes are on somebody else&apos;s machine this product has no way to
          reach them and will not pretend otherwise. The third is different in
          kind: it mints a token for a document this machine keeps serving, so it
          is the one copy a withdrawal can still reach — the route asks the
          consent log on every open, and a live link stops working while a
          revocation stands.
        </p>

        {blocked && (
          <p className="text-xs text-neutral-500">
            {consentBlocked
              ? "Consent for a document naming a party has been withdrawn. Nothing leaves and no link is minted while that stands."
              : gateBlocked
                ? "The export gate refuses this document. Fix what it names above; every door here exposes the same text."
                : "The pause has not run yet."}
          </p>
        )}
      </div>

      {taken !== null && <TakenNotice taken={taken} />}

      {minted !== null && (
        <MintedNotice
          minted={minted}
          alreadyMinted={alreadyMinted}
          copied={copiedLink}
          onCopy={() => void copyLink(minted.link)}
        />
      )}
    </div>
  );
}

function TakenNotice({ taken }: { taken: TakenCopy }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-neutral-300 bg-neutral-50 p-3">
      <p className="text-sm text-neutral-900">
        {taken.channel === "file"
          ? taken.delivered
            ? `Downloaded as ${taken.data.filename}.`
            : "Exported, but the browser refused the download."
          : taken.delivered
            ? "On the clipboard."
            : "Exported, but the browser refused clipboard access."}{" "}
        One copy, to {taken.data.recipientPseudonym}.
      </p>
      {!taken.delivered && (
        <p className="text-xs leading-relaxed text-amber-900">
          The audit row was written regardless, and that is correct: the gate
          passed the document and released the bytes. Whether they landed is
          between you and the browser, and the log does not get to assume.
        </p>
      )}
      <p className="font-mono text-xs break-all text-neutral-600">
        {taken.data.exportId} · {taken.data.byteSize} bytes · sha256{" "}
        {taken.data.contentSha256}
      </p>
    </div>
  );
}

function MintedNotice({
  minted,
  alreadyMinted,
  copied,
  onCopy,
}: {
  minted: MintActionData;
  alreadyMinted: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-neutral-300 bg-neutral-50 p-4">
      <p className="text-sm font-medium text-neutral-900">
        A link exists. It is shown once.
      </p>
      <p className="text-xs leading-relaxed text-neutral-600">
        Only the hash of this token is stored — a database that could produce the
        link is a database that leaks the judgment. If you lose it, mint another.
      </p>
      <code className="rounded border border-neutral-300 bg-white px-2 py-1.5 font-mono text-xs break-all text-neutral-800">
        {minted.link}
      </code>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onCopy}
          className="w-fit rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-800 hover:bg-neutral-100"
        >
          {copied ? "Copied" : "Copy the link"}
        </button>
        <span className="text-xs text-neutral-500">
          Expires{" "}
          {minted.expiresAtIso.slice(0, 16).replace("T", " ")} UTC
        </span>
      </div>
      <p className="text-xs leading-relaxed text-neutral-600">
        <span className="font-medium text-neutral-900">
          What it opens, in order.
        </span>{" "}
        A share token is a credential this route resolves, so the link lands her
        on the arrival screen rather than on the document: her own position
        stated at its strongest first, then what this case holds about her, then
        three exits of equal weight. The document is one click on from there,
        never inlined into the screen she arrives on — reading it has to be her
        decision rather than the consequence of opening something you sent her.
        Opening any of it is not reported to you.
      </p>
      <p className="text-xs leading-relaxed text-neutral-600">
        <span className="font-medium text-neutral-900">
          It is a document credential, not an invitation.
        </span>{" "}
        It resolves to her row, so she can read and add her side from the same
        screen. What it cannot do is become a door of her own: only an invitation
        is redeemed into her own standing credential, and this one stops
        resolving on the rendition&apos;s schedule — while the document behind it
        stops being served the moment consent for a document naming her is
        withdrawn. An invitation is created on the case overview, not here.
      </p>
      {alreadyMinted && (
        <p className="text-xs text-neutral-500">
          A link had already been minted for this document. The new one replaces
          it: the row holds one token hash, so the previous link has stopped
          working.
        </p>
      )}
    </div>
  );
}

function CoolingOffNotice({ coolingOff }: { coolingOff: CoolingOffProps }) {
  const anchor =
    coolingOff.anchorIso === null
      ? null
      : coolingOff.anchorIso.slice(0, 16).replace("T", " ");

  if (coolingOff.state === "waiting") {
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-amber-300 bg-amber-50 p-3">
        <p className="text-sm font-medium text-amber-900">
          The pause has {coolingOff.remainingHours} hour
          {coolingOff.remainingHours === 1 ? "" : "s"} left to run.
        </p>
        <p className="text-xs leading-relaxed text-amber-900">
          Doc 01 puts 24 to 48 hours between writing something like this and
          sending it. The clock runs from {coolingOff.anchorLabel}
          {anchor === null ? "" : ` (${anchor} UTC)`} — not from when you opened
          this page — so it cannot be started by clicking and it is already
          running. Nothing here needs doing in the meantime.
        </p>
      </div>
    );
  }

  if (coolingOff.state === "undated") {
    return (
      <p className="rounded-lg border border-neutral-300 bg-neutral-50 p-3 text-xs leading-relaxed text-neutral-700">
        This document carries no generation timestamp, so the 24–48 hour pause
        could not be measured. It is not being enforced, and that is reported
        rather than hidden.
      </p>
    );
  }

  return (
    <p className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs leading-relaxed text-neutral-700">
      The pause has run: this document was written
      {anchor === null ? " " : ` at ${anchor} UTC, `}more than 24 hours ago
      {coolingOff.state === "settled"
        ? " — past doc 01's 48-hour window too"
        : ""}
      .
    </p>
  );
}

/** Write the exported bytes to a file. Returns whether the browser took it. */
function download(data: ExportActionData): boolean {
  try {
    const blob = new Blob([data.text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = data.filename;
    anchor.click();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

/** Put them on the clipboard. The browser may refuse; that is its call. */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default SendPanel;
