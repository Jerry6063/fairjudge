// The nine-stage stepper.
//
// Server component, no interactivity: everything it renders is already decided
// by `describePipeline` (server/pipeline), so the page cannot show a stage as
// reachable that the machine would refuse. What each row says is exactly what
// `canAdvance` reads — a requirement rendered here and a requirement enforced
// there are the same object.

import Link from "next/link";
import { Fragment } from "react";

import {
  PIPELINE_STAGES,
  type Requirement,
  type StageStatus,
} from "../../../server/pipeline";

// Nine bordered cards down the left of every screen was the loudest thing on
// this product, and none of the nine is a separate object — they are one list.
// So the stepper is hairline rows in the apparatus voice (globals.css), and the
// only mark on it is which row you are standing in.
const STATE_DOT: Readonly<Record<StageStatus["state"], string>> = {
  done: "border-hairline-strong text-ink-3",
  current: "border-ink-1 bg-ink-1 text-paper-raised",
  upcoming: "border-hairline text-ink-3",
};

function RequirementLine({ requirement }: { requirement: Requirement }) {
  return (
    <li className="flex items-start gap-2">
      <span
        aria-hidden
        className={`text-app-sm ${
          requirement.satisfied ? "text-ink-3" : "text-grade-ink"
        }`}
      >
        {requirement.satisfied ? "\u2713" : "\u2022"}
      </span>
      <span className="text-app-sm leading-normal">
        <span className={requirement.satisfied ? "text-ink-3" : "text-ink-2"}>
          {requirement.need}
        </span>
        {!requirement.satisfied && (
          <span className="block text-grade-ink">{requirement.blocker}</span>
        )}
      </span>
    </li>
  );
}

/** The two terminal phases are not part of the nine, and are numbered as such. */
function isPipelineStage(stage: StageStatus["stage"]): boolean {
  return (PIPELINE_STAGES as readonly string[]).includes(stage);
}

export function StageStepper({
  caseId,
  stages,
}: {
  caseId: string;
  stages: readonly StageStatus[];
}) {
  return (
    <ol className="flex flex-col">
      {stages.map((status, at) => {
        const unmet = status.requirements.filter((r) => !r.satisfied);
        const inPipeline = isPipelineStage(status.stage);
        const firstTerminal =
          !inPipeline && at > 0 && isPipelineStage(stages[at - 1].stage);
        // A stage's requirements are worth reading where they still decide
        // something: the stage the case is in, and the one it is trying to
        // enter. Behind them they are history; further ahead they are noise.
        const showRequirements =
          (status.state === "current" || status.isNext) &&
          status.requirements.length > 0;

        return (
          <Fragment key={status.stage}>
            {firstTerminal && (
              <li
                role="presentation"
                className="fj-eyebrow pt-6 pb-2"
              >
                After the nine stages
              </li>
            )}
            <li
              aria-current={status.state === "current" ? "step" : undefined}
              className="fj-record-row flex gap-3 py-3"
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-app-sm ${STATE_DOT[status.state]}`}
              >
                {inPipeline ? status.meta.index : "·"}
              </span>

              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-app font-medium">
                    <Link
                      href={`/case/${caseId}/${status.stage}`}
                      className={
                        status.state === "upcoming"
                          ? "text-ink-3 hover:text-ink-1"
                          : "text-ink-1 hover:underline"
                      }
                    >
                      {status.meta.title}
                    </Link>
                  </h3>
                  {status.state === "current" && (
                    <span className="fj-eyebrow text-ink-1">Current stage</span>
                  )}
                  {status.isNext && (
                    <span
                      className={`fj-eyebrow ${
                        unmet.length === 0 ? "" : "text-grade-ink"
                      }`}
                    >
                      {unmet.length === 0
                        ? "Ready to enter"
                        : `Blocked · ${unmet.length}`}
                    </span>
                  )}
                </div>

                <p
                  className={`text-app-sm leading-normal ${
                    status.state === "upcoming" ? "text-ink-3" : "text-ink-2"
                  }`}
                >
                  {status.meta.purpose}
                </p>

                {showRequirements && (
                  <ul className="mt-1 flex flex-col gap-1">
                    {status.requirements.map((requirement) => (
                      <RequirementLine
                        key={requirement.id}
                        requirement={requirement}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

export default StageStepper;
