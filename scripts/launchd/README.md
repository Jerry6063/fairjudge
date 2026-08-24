# The follow-up timer (launchd)

`com.fairjudge.followups.plist` runs `npm run followups:run` once a day, plus
once whenever the agent is loaded. It is checked into the repository and **not
installed** — installing a job into `~/Library/LaunchAgents` is your decision,
not the repository's, so the steps below are yours to run.

Nothing breaks if you never install it. The application catches up at start
(`src/instrumentation.ts`): anything overdue is scheduled and fired when the
dev server comes up, and an overdue check-in shows as overdue on the case page
either way. The timer exists so that a machine that is on but not running the
app still fires on time.

## Install

The plist carries two placeholders, because a launchd agent needs absolute
paths and there is no sensible default for either.

```sh
# 1. Where things are.
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"   # or just: /path/to/fairjudge
NODE_BIN_DIR="$(dirname "$(command -v npm)")"        # e.g. /opt/homebrew/bin

# 2. Render the plist into LaunchAgents.
mkdir -p ~/Library/LaunchAgents "$PROJECT_DIR/data/logs"
sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
    -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" \
    "$PROJECT_DIR/scripts/launchd/com.fairjudge.followups.plist" \
    > ~/Library/LaunchAgents/com.fairjudge.followups.plist

# 3. Load it (macOS 11+ syntax; `launchctl load` is the older equivalent).
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fairjudge.followups.plist
```

`RunAtLoad` means step 3 also fires a run immediately, which is the quickest way
to confirm the whole thing works.

## Check on it

```sh
launchctl print gui/$(id -u)/com.fairjudge.followups   # loaded? last exit code?
launchctl kickstart -p gui/$(id -u)/com.fairjudge.followups   # run it now
tail -f data/logs/followups.log data/logs/followups.err.log
```

The script's exit code is meaningful and `launchctl print` shows the last one:

- **0** — everything due was handled.
- **1** — at least one check-in is overdue with no questions to answer, or the
  run itself failed. The reason is on the row (`followups.last_error`) and on
  the case page, not only in the log.

## Uninstall

```sh
launchctl bootout gui/$(id -u)/com.fairjudge.followups
rm ~/Library/LaunchAgents/com.fairjudge.followups.plist
```

## What it does not solve

launchd re-runs a missed `StartCalendarInterval` job after the machine **wakes**
from sleep. It does not run one for a machine that was **powered off** over the
due date, and it obviously does not run at all before you install it. Both gaps
are covered by the application-start catch-up, which is why the two paths are
built to be safe on top of each other: claiming a due follow-up is a conditional
`UPDATE`, so whichever fires first does the work and the other finds nothing.

## Running it by hand

```sh
npm run followups:run            # schedule what is missing, fire what is due
npm run followups:run -- --list  # what exists and where each one stands
npm run followups:run -- --dry-run
```
