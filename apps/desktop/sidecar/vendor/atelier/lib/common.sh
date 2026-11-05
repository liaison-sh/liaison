#!/usr/bin/env bash
# Shared helpers for the atelier-cc reminder hooks (Stop anti-yield + completion
# gate, PostToolUse heartbeat, SessionStart re-grounding) in the workflow-era
# rewrite. These NEVER write pipeline state — the orchestrator (an LLM) owns
# every state.json write (a single Write call). The hooks' own bookkeeping
# sidecars (`.heartbeat`, `.await-since`) are not pipeline state.

# Bash version gate. Hooks run silently; a cryptic `declare: -A` failure midway
# would be hard to diagnose. Fail loudly at source-time. macOS ships bash 3.2;
# install bash 4+ via `brew install bash`.
if [ -z "${BASH_VERSINFO[0]:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "atelier-cc: bash 4+ required (running ${BASH_VERSION:-unknown}); install via 'brew install bash' on macOS" >&2
  exit 1
fi

die() { echo "atelier-cc: $*" >&2; exit 1; }

require_jq() { command -v jq >/dev/null 2>&1 || die "jq is required but not installed"; }

# Host contract (S37): an embedding host runs Atelier unattended by setting
# ATELIER_AUTONOMY=autonomous. Exact match only; any other value, or none, keeps
# today's behaviour.
atelier_autonomous() { [ "${ATELIER_AUTONOMY:-}" = "autonomous" ]; }

# Walk up from a directory to the workspace root (first ancestor containing
# .atelier/ or .git/). The orchestrator always runs with its cwd in the MAIN
# workspace (worktrees are used only for subagent code changes, and subagents
# fire SubagentStop — which this plugin does not hook — not the orchestrator's
# Stop), so walking up from the Stop hook's cwd lands on the right workspace.
find_workspace_root() {
  local dir="${1:-$PWD}"
  while [ "$dir" != "/" ] && [ -n "$dir" ]; do
    if [ -d "$dir/.atelier" ] || [ -d "$dir/.git" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  printf '%s\n' "${1:-$PWD}"
}

# Print the state.json path of the (at most one) pipeline this session owns and
# that is still running, else nothing. Ownership is keyed strictly on
# sourceSessionId == this session — NEVER a blind "only running pipeline"
# fallback (that was the old cross-session-hijack bug). The one-running-pipeline-
# per-session invariant (driver-enforced) makes the first match unambiguous.
find_owned_running_pipeline() {
  local wsp="$1" sid="$2"
  local pdir="$wsp/.atelier/pipelines"
  [ -d "$pdir" ] || return 0
  local sp owner status
  for sp in "$pdir"/*/state.json; do
    [ -f "$sp" ] || continue
    owner="$(jq -r '.sourceSessionId // empty' "$sp" 2>/dev/null)" || continue
    status="$(jq -r '.status // empty' "$sp" 2>/dev/null)" || continue
    if [ "$owner" = "$sid" ] && [ "$status" = "running" ]; then
      printf '%s\n' "$sp"
      return 0
    fi
  done
  return 0
}

# Like find_owned_running_pipeline but matches an arbitrary status. The Stop
# hook's premature-complete gate needs to see a pipeline its owner JUST marked
# `complete` (find_owned_running_pipeline filters to running and would miss it).
find_owned_pipeline_with_status() {
  local wsp="$1" sid="$2" want="$3"
  local pdir="$wsp/.atelier/pipelines"
  [ -d "$pdir" ] || return 0
  local sp owner status
  for sp in "$pdir"/*/state.json; do
    [ -f "$sp" ] || continue
    owner="$(jq -r '.sourceSessionId // empty' "$sp" 2>/dev/null)" || continue
    status="$(jq -r '.status // empty' "$sp" 2>/dev/null)" || continue
    if [ "$owner" = "$sid" ] && [ "$status" = "$want" ]; then
      printf '%s\n' "$sp"
      return 0
    fi
  done
  return 0
}

# Print the state.json path of the first running pipeline in this workspace,
# REGARDLESS of owner. Used only by the SessionStart hook to offer a resume
# nudge for a pipeline a fresh session does not own (never to auto-adopt).
find_any_running_pipeline() {
  local wsp="$1"
  local pdir="$wsp/.atelier/pipelines"
  [ -d "$pdir" ] || return 0
  local sp
  for sp in "$pdir"/*/state.json; do
    [ -f "$sp" ] || continue
    if [ "$(jq -r '.status // empty' "$sp" 2>/dev/null)" = "running" ]; then
      printf '%s\n' "$sp"
      return 0
    fi
  done
  return 0
}

# ---------------------------------------------------------------------------
# Definition-of-done + reminder primitives (shared by stop / heartbeat /
# session-start hooks). All read state.json; none write it.
#
# Rung/phase are the vocabulary of the single flow; a legacy pipeline may still
# carry `type` and a typed plan[] — both are honoured, never migrated by a hook.
# ---------------------------------------------------------------------------

# Tunables (env-overridable for tests).
: "${HEARTBEAT_EVERY:=12}"        # PostToolUse heartbeat cadence, in tool calls
: "${WORKFLOW_STALE_SECS:=1800}"  # awaiting:"workflow" treated as stranded after this
: "${WORKFLOW_STALE_SECS_EPIC:=5400}"  # ...but epic-rung fan-outs legitimately run longer

# Staleness window for an `awaiting:"workflow"` yield, by rung. The 30-min default
# is right for a feature-rung review fan-out and WRONG at the epic rung (R4), whose
# fan-outs author or review whole document sets and routinely run past it. A false
# STALE is not harmless: stop.sh's reason invites a relaunch, i.e. a duplicate of a
# workflow that is still running.
stale_secs_for_rung() {
  case "${1:-}" in
    4|R4|epic) printf '%s' "$WORKFLOW_STALE_SECS_EPIC" ;;
    *)         printf '%s' "$WORKFLOW_STALE_SECS" ;;
  esac
}

# The one flow — the SINGLE source of truth for "what phases a run must walk",
# mirroring commands/atelier.md §0. Every run walks the same seven phases; the rung
# decides how deep each one goes (a phase can be one line, never absent). Consumed
# by the Stop hook (completion gate), the heartbeat, and the session-start hook.
FLOW_PHASES="frame brainstorm spec review execute validate handoff"
flow_phases() { printf '%s' "$FLOW_PHASES"; }

# Kept for pipelines created by the previous flow (typed stage lists). A state.json
# with a persisted plan[] is authoritative either way; this is only the fallback.
flow_for_type() {
  case "${1:-}" in
    task)    printf '%s' "task_brainstorm review_task implement review_code validate" ;;
    feature) printf '%s' "brainstorm review_spec write_plan review_plan implement review_code simplify e2e_gate write_e2e_plan review_e2e_plan e2e validate" ;;
    epic)    printf '%s' "brainstorm review_spec brainstorm_roadmap review_roadmap validate" ;;
    autonomous-epic) printf '%s' "research brainstorm write_spec review_spec brainstorm_roadmap review_roadmap write_blueprints review_blueprints execute_roadmap gestalt validate" ;;
    *)       flow_phases ;;
  esac
}

# The terminal phase (last of the flow; a legacy typed pipeline keeps its own).
terminal_stage() {
  local flow; flow="$(flow_for_type "${1:-}")"
  printf '%s' "${flow##* }"
}

# The terminal phase for an actual pipeline: prefer the persisted plan[]'s last
# entry (the orchestrator's own declared definition-of-done), else the flow (or,
# for a legacy pipeline that still carries a type, that type's stage list).
terminal_stage_for_state() {
  local sp="$1" t
  t="$(jq -r 'if ((.plan|type)=="array" and (.plan|length>0)) then (.plan[-1]) else "" end' "$sp" 2>/dev/null || true)"
  [ -n "$t" ] && { printf '%s' "$t"; return 0; }
  terminal_stage "$(jq -r '.type // empty' "$sp" 2>/dev/null || true)"
}

# True if <stage> is recorded in the pipeline's done[].
stage_done() { # <state-path> <stage>
  jq -e --arg s "$2" '((.done // []) | index($s)) != null' "$1" >/dev/null 2>&1
}

# Compact ledger line for reminders: what's done, what's left. Remaining is
# (plan | flow) − done, order preserved. A remaining phase may be one line deep by
# the rung's judgment — this is a nudge, not a mandate; only the terminal phase is
# hard-gated.
ledger_line() {
  local sp="$1" type flow done_arr s done_csv rem_csv
  local rem=()
  type="$(jq -r '.type // empty' "$sp" 2>/dev/null || true)"
  flow="$(jq -r 'if ((.plan|type)=="array" and (.plan|length>0)) then (.plan|join(" ")) else "" end' "$sp" 2>/dev/null || true)"
  [ -n "$flow" ] || flow="$(flow_for_type "$type")"
  done_arr="$(jq -r '((.done // []) | join(" "))' "$sp" 2>/dev/null || true)"
  for s in $flow; do
    case " $done_arr " in *" $s "*) : ;; *) rem+=("$s") ;; esac
  done
  rem_csv="$(IFS=','; printf '%s' "${rem[*]:-}")"
  done_csv="$(printf '%s' "$done_arr" | tr ' ' ',')"
  printf 'done=[%s] remaining=[%s]' "$done_csv" "$rem_csv"
}

# Emit a non-blocking context injection (PostToolUse / SessionStart). The
# additionalContext channel feeds the model's next turn from durable state.
emit_additional_context() { # <hookEventName> <text>
  jq -nc --arg e "$1" --arg t "$2" \
    '{hookSpecificOutput: {hookEventName: $e, additionalContext: $t}}'
}
