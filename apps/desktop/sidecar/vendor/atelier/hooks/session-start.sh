#!/usr/bin/env bash
# Atelier SessionStart re-grounding — restores the orchestrator's duty when a
# context-losing event begins a fresh context (compaction is the prime suspect
# for "forgot the initial prompt": the summary drops the task + ledger) or when a
# session resumes/starts with a pipeline still running. Re-injects task + ledger
# from state.json the instant the new context begins.
#
# Two modes:
#   - OWNED running pipeline → full re-ground (this session is the orchestrator).
#   - Not owned, but a pipeline is running here → a gentle one-line resume nudge
#     (never auto-adopt; the driver requires an explicit /atelier resume <id>).
# Output is a non-blocking additionalContext injection.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/lib/common.sh"
require_jq

input="$(cat)"
sid="$(printf '%s' "$input" | jq -r '.session_id // empty')"
src="$(printf '%s' "$input" | jq -r '.source // empty')"
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty')"
[ -n "$cwd" ] && cd "$cwd" 2>/dev/null || true
wsp="$(find_workspace_root "${cwd:-$PWD}")"

# Owned + running → full re-ground.
sp=""
[ -n "$sid" ] && sp="$(find_owned_running_pipeline "$wsp" "$sid")"
if [ -n "$sp" ]; then
  pid="$(jq -r '.id // empty' "$sp" 2>/dev/null || true)"
  ptype="$(jq -r 'if .rung != null then "rung \(.rung)" else (.type // "rung ?") end' "$sp" 2>/dev/null || true)"
  phase="$(jq -r '.phase // empty' "$sp" 2>/dev/null || true)"
  task="$(jq -r '.task // empty' "$sp" 2>/dev/null || true)"; task="${task:0:400}"
  term="$(terminal_stage_for_state "$sp")"
  emit_additional_context SessionStart "You are the Atelier orchestrator and pipeline ${pid} (${ptype}) is still RUNNING (context was just ${src:-started}). Re-read ${ROOT}/commands/atelier.md, ${sp}, and the brief.md + PROGRESS.md beside it, then resume driving at phase '${phase}'. Do NOT stop until '${term}' is in done[] and you set status:\"complete\".
TASK: ${task}
LEDGER: $(ledger_line "$sp")"
  exit 0
fi

# Not owned, but a pipeline is running here → resume nudge.
other="$(find_any_running_pipeline "$wsp")"
if [ -n "$other" ]; then
  opid="$(jq -r '.id // empty' "$other" 2>/dev/null || true)"
  ophase="$(jq -r '.phase // empty' "$other" 2>/dev/null || true)"
  emit_additional_context SessionStart "An Atelier pipeline (${opid}) is marked running at phase '${ophase}' but is not owned by this session. To continue it: /atelier resume ${opid}"
  exit 0
fi
exit 0
