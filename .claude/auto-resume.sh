#!/bin/bash
#
# Picks the task back up after a session dies — a token limit, a dropped
# connection, a closed laptop.
#
# WHY THIS EXISTS OUTSIDE THE SESSION. Nothing running inside a Claude session
# can restart it: whatever kills the session kills the thing that would do the
# waking. So this is a launchd job, and it is the only part of the arrangement
# that survives.
#
# IT IS DELIBERATELY HARD TO RUN BY ACCIDENT. It spends tokens with nobody
# watching, so every gate below is a reason NOT to run:
#
#   1. no RESUME-PENDING marker        -> nothing is pending, exit
#   2. a LIVE session is already on it -> exit (heartbeat, stale after 45m)
#   3. a run already in flight         -> exit (lock, stale after 2h)
#   4. the daily cap is used up        -> exit
#
# TO STOP IT, any one of these is enough:
#   rm .claude/RESUME-PENDING                      # this task only
#   launchctl unload ~/Library/LaunchAgents/com.wouchh.auto-resume.plist
#   rm .claude/auto-resume.sh                      # permanently

set -uo pipefail

REPO="/Users/NI013/Documents/Om Docs/depos/wouch/wh-api-unified-service"
MARKER="$REPO/.claude/RESUME-PENDING"
LOCK="$REPO/.claude/.auto-resume.lock"
HEARTBEAT="$REPO/.claude/.session-heartbeat"
COUNT="$REPO/.claude/.auto-resume.count"
LOG="$REPO/.claude/auto-resume.log"
MAX_RUNS_PER_DAY=12
STALE_LOCK_SECONDS=7200
# How long after a live session's last sign of life we assume it is gone. Long
# enough to cover thinking and a slow test run; short enough that recovery is
# not an hour away.
STALE_HEARTBEAT_SECONDS=2700

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# 1. Is anything actually pending?
[ -f "$MARKER" ] || exit 0

# 2. Is a HUMAN-DRIVEN session already working on this?
#
#    Without this the job happily starts a second Claude alongside the first,
#    both editing the same files on the same branch. A live session touches the
#    heartbeat as it works; once it stops being touched, it is gone and this
#    job takes over.
if [ -f "$HEARTBEAT" ]; then
  beat_age=$(( $(date +%s) - $(stat -f %m "$HEARTBEAT" 2>/dev/null || echo 0) ))
  if [ "$beat_age" -lt "$STALE_HEARTBEAT_SECONDS" ]; then
    exit 0
  fi
  say "heartbeat is ${beat_age}s old — assuming that session is gone"
fi

# 3. Is a run already going? A lock older than two hours is from a run that
#    died, not one still working.
if [ -f "$LOCK" ]; then
  lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  if [ "$lock_age" -lt "$STALE_LOCK_SECONDS" ]; then
    exit 0
  fi
  say "clearing a stale lock (${lock_age}s old)"
fi

# 4. The daily cap. Resets by date rather than by a rolling window, because a
#    cap you cannot reason about is one nobody trusts.
today=$(date '+%Y-%m-%d')
runs=0
if [ -f "$COUNT" ]; then
  saved_day=$(cut -d' ' -f1 "$COUNT" 2>/dev/null)
  [ "$saved_day" = "$today" ] && runs=$(cut -d' ' -f2 "$COUNT" 2>/dev/null || echo 0)
fi
if [ "$runs" -ge "$MAX_RUNS_PER_DAY" ]; then
  say "daily cap reached ($runs/$MAX_RUNS_PER_DAY) — not resuming"
  exit 0
fi

echo "$today $((runs + 1))" > "$COUNT"
touch "$LOCK"
trap 'rm -f "$LOCK"' EXIT

say "resuming (run $((runs + 1))/$MAX_RUNS_PER_DAY)"

cd "$REPO" || exit 1

# --print so it runs headless and exits. NOT --dangerously-skip-permissions:
# an unattended run is exactly the wrong place to remove the safety rail, so
# anything needing approval stops and waits for a human instead.
claude --print "$(cat <<'PROMPT'
You are resuming work after the previous session ended unexpectedly — a token
limit, a dropped connection, or a closed laptop. Nobody typed this; a scheduled
job did.

Read .claude/RESUME.md first. It holds the standing rules, where things are,
the gate to run before committing, what is already done, and the next action.
Verify it against `git status` and `git log` before trusting it, and correct it
if they disagree.

Then continue from "Next action".

Two things to get right:
- Keep .claude/RESUME.md updated as you go. It is the only thing that survives
  you, and the next session has nothing else.
- When the whole task is finished, delete .claude/RESUME-PENDING. That marker
  is what stops this job waking you forever.

If you hit something that needs a human decision, write it under "Blocked on
the user" in RESUME.md and stop. Do not guess at it.
PROMPT
)" >> "$LOG" 2>&1

say "run finished (exit $?)"
