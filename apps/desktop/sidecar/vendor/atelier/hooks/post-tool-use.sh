#!/usr/bin/env bash
# Atelier PostToolUse heartbeat — re-injects the orchestrator's duty on a cadence
# so a long pipeline cannot drift off-task or forget what remains. This is the
# "remind him regularly" guarantee: the Stop hook fires only at a yield, but the
# heartbeat fires throughout autonomous execution, every HEARTBEAT_EVERY tool
# calls. It reads state.json (the durable truth), so the reminder stays correct
# even after the in-context summary has decayed.
#
# Fires ONLY when this session owns a RUNNING, autonomously-executing pipeline:
#   - subagents/fan-out agents have a different session_id → not owners → silent;
#   - interactive design (awaiting:user) is human-paced → suppressed (no drift,
#     and per-tool reminders would be noise);
#   - terminal pipelines → silent.
# Throttling uses a per-pipeline `.heartbeat` sidecar (hook bookkeeping, not
# pipeline state). Output is a non-blocking additionalContext injection.
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
[ -n "$sp" ] || exit 0

status="$(jq -r '.status // empty' "$sp" 2>/dev/null || true)"
awaiting="$(jq -r '.awaiting // empty' "$sp" 2>/dev/null || true)"
[ "$status" = "running" ] || exit 0
[ "$awaiting" = "user" ] && exit 0           # interactive → stay quiet

# Throttle: bump the sidecar counter; speak only every HEARTBEAT_EVERY calls.
pdir="$(dirname "$sp")"
cfile="$pdir/.heartbeat"
count=0
[ -f "$cfile" ] && count="$(cat "$cfile" 2>/dev/null || printf 0)"
[[ "$count" =~ ^[0-9]+$ ]] || count=0
count=$((count + 1))
printf '%s\n' "$count" > "$cfile" 2>/dev/null || true
[ $((count % HEARTBEAT_EVERY)) -eq 0 ] || exit 0

pid="$(jq -r '.id // empty' "$sp" 2>/dev/null || true)"
ptype="$(jq -r 'if .rung != null then "rung \(.rung)" else (.type // "rung ?") end' "$sp" 2>/dev/null || true)"
phase="$(jq -r '.phase // empty' "$sp" 2>/dev/null || true)"
task="$(jq -r '.task // empty' "$sp" 2>/dev/null || true)"; task="${task:0:300}"
term="$(terminal_stage_for_state "$sp")"

msg="⏳ Atelier heartbeat — you are the orchestrator for pipeline ${pid} (${ptype}), phase '${phase}', mid-autonomous execution. Do NOT stop early or drift from the original task.
TASK: ${task}
LEDGER: $(ledger_line "$sp")
DEFINITION OF DONE: you may set status:\"complete\" ONLY after '${term}' is in done[]. Walk every remaining phase (a phase may be one line deep by the rung's judgment, never absent). Keep state.json's done[]/phase current, and set awaiting before any yield."
emit_additional_context PostToolUse "$msg"
exit 0
