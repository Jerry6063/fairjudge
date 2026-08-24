import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">fairjudge</h1>
      <p className="text-sm text-neutral-500">
        A plain-speech translator and a fair judge for relationship conflicts.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/translate"
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Open the translator
        </Link>
        <Link
          href="/timeline"
          className="rounded-lg border border-neutral-900 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-100"
        >
          Open the timeline
        </Link>
      </div>
    </main>
  );
}
