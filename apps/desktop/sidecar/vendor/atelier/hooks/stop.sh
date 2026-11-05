#!/usr/bin/env bash
# Atelier anti-yield Stop hook — the scripted yield guarantee (rewrite-spec §2.2).
#
# Blocks the orchestrator from yielding mid-autonomous-execution. Gated PURELY on
# the persisted state machine (state.json), never on `stop_hook_active`: Claude
# Code sets that flag on every main-loop re-entry after a blocking Stop —
# including the legitimate re-entry after an Agent tool call returns — so keying
# an exit off it would strand the pipeline after the first block. (old stop.sh
# documented this; stop-hook.bats is the regression test.)
#
# Three gates, all read from durable state:
#   1. ANTI-YIELD  — status==running & awaiting==null → BLOCK (mid-autonomous).
#   2. DEFINITION-OF-DONE (D1) — status==complete is honored ONLY once the flow's
#      terminal stage (validate / last of plan[]) is in done[]; else BLOCK a
#      premature completion. This is the gate that the format-moat run tripped:
#      it set complete with done[] ending at `implement`, 7 stages early.
#   3. WORKFLOW-STRAND (D2) — awaiting=="workflow" is allowed while a fan-out is
#      plausibly in flight, but if the wait has gone stale (no progress in
#      WORKFLOW_STALE_SECS) → BLOCK so the orchestrator collects/relaunches it.
#      Staleness is tracked in an `.await-since` sidecar (hook bookkeeping, not
#      pipeline state); it can only fire on a yield, so it catches a "forgot to
#      clear awaiting" drift, not a fully dead session (only the workflow
#      completion notification or a manual /atelier resume rescues that).
#
# ALLOW (exit 0) otherwise: no owned running pipeline · failed · legitimately
# complete · awaiting:user · awaiting:workflow still fresh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/lib/common.sh"
require_jq

input="$(cat)"
sid="$(printf '%s' "$input" | jq -r '.session_id // empty')"
[ -n "$sid" ] || exit 0
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty')"
[ -n "$cwd" ] && cd "$cwd" 2>/dev/null || true
wsp="$(find_workspace_root "${cwd:-$PWD}")"

sp="$(find_owned_running_pipeline "$wsp" "$sid")"
if [ -z "$sp" ]; then
  # Not running — but the orchestrator may have JUST marked it complete; the
  # premature-complete gate (D1) must still see it. (failed = terminal → no
  # match here → stays allowed.)
  sp="$(find_owned_pipeline_with_status "$wsp" "$sid" complete)"
  [ -n "$sp" ] || exit 0                     # nothing owned that needs gating → ALLOW
fi

status="$(jq -r '.status // empty' "$sp" 2>/dev/null || true)"
awaiting="$(jq -r '.awaiting // empty' "$sp" 2>/dev/null || true)"
pid="$(jq -r '.id // empty' "$sp" 2>/dev/null || true)"
ptype="$(jq -r 'if .rung != null then "rung \(.rung)" else (.type // "rung ?") end' "$sp" 2>/dev/null || true)"
phase="$(jq -r '.phase // empty' "$sp" 2>/dev/null || true)"
pdir="$(dirname "$sp")"

block() { jq -nc --arg r "$1" '{decision: "block", reason: $r}'; exit 0; }

# --- failed → terminal → ALLOW ---
[ "$status" = "failed" ] && exit 0

# --- complete → honor only if the terminal stage is actually done (D1) ---
if [ "$status" = "complete" ]; then
  term="$(terminal_stage_for_state "$sp")"
  if [ -n "$term" ] && ! stage_done "$sp" "$term"; then
    block "PREMATURE COMPLETE BLOCKED — pipeline ${pid} (${ptype}) is marked status:\"complete\" but the terminal stage '${term}' is NOT in done[]. $(ledger_line "$sp"). You stopped early — the rest of the flow never ran. Set status:\"running\", awaiting:null, set phase to the first remaining stage, and keep driving (re-read ${ROOT}/commands/atelier.md for the flow). You may complete ONLY once '${term}' is in done[]."
  fi
  rm -f "$pdir/.heartbeat" "$pdir/.await-since" 2>/dev/null || true   # tidy sidecars
  exit 0
fi

# --- awaiting:user → interactive, human-paced → ALLOW ---
if [ "$awaiting" = "user" ]; then
  rm -f "$pdir/.await-since" 2>/dev/null || true
  exit 0
fi

# --- awaiting:workflow → ALLOW while fresh; BLOCK if stranded (D2) ---
if [ "$awaiting" = "workflow" ]; then
  awf="$pdir/.await-since"
  now="$(date +%s)"
  win="$(stale_secs_for_rung "$(jq -r '.rung // .type // empty' "$sp" 2>/dev/null || true)")"
  if [ -f "$awf" ]; then
    since="$(cat "$awf" 2>/dev/null || printf '%s' "$now")"
    [[ "$since" =~ ^[0-9]+$ ]] || since="$now"
    if [ "$((now - since))" -gt "$win" ]; then
      rm -f "$awf" 2>/dev/null || true        # re-arm the clock for the next genuine wait
      block "STALE WORKFLOW WAIT — pipeline ${pid} (${ptype}) has been awaiting:\"workflow\" for >$((win / 60))min at phase '${phase}'. CHECK THE WORKFLOW'S RESULT FIRST — if it is still running, just keep waiting; only relaunch if it is genuinely dead or never launched. Then set awaiting:null and keep driving. $(ledger_line "$sp")."
    fi
  else
    printf '%s\n' "$now" > "$awf" 2>/dev/null || true   # first sight → arm the clock
  fi
  exit 0
fi

# --- status==running AND awaiting==null → mid-autonomous → BLOCK ---
# Self-contained reason so a post-compaction orchestrator re-grounds itself.
rm -f "$pdir/.await-since" 2>/dev/null || true
block "You are the Atelier orchestrator for pipeline ${pid} (type ${ptype}), mid-autonomous execution. Do NOT yield. Re-read the driver at ${ROOT}/commands/atelier.md, the pipeline state at ${sp}, and its brief.md + PROGRESS.md, then continue driving at phase '${phase}'. $(ledger_line "$sp"). Update state.json (a single Write) as you advance."
