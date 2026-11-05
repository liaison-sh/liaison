#!/usr/bin/env bash
# Atelier autonomy firewall — PreToolUse hook on AskUserQuestion.
#
# Companion to stop.sh. The Stop hook stops the orchestrator from YIELDING
# mid-autonomous-execution, but AskUserQuestion yields to the human through a
# tool call that never fires Stop — so without this guard the orchestrator can
# pop a question to the user in the middle of an autonomous stage (e.g. asking
# for deploy credentials at the end of the blueprint phase), silently breaking
# the full-autonomy contract. After the design stages there is NO escalation to
# the user: anything the user must provide (credentials, secrets, CLI auth,
# deploy targets) is elicited DURING speccing and recorded in the spec's
# "Prerequisites / Required Access" section.
#
# Keyed PURELY on the persisted state machine (state.json), never on tool_input.
# AskUserQuestion is legitimate in EXACTLY ONE pipeline state: an interactive [I]
# design conversation, i.e. awaiting=="user". Everywhere else the orchestrator is
# autonomous and must decide for itself.
#   ALLOW when: no owned running pipeline (covers the §1a classify/worktree
#         questions, which run BEFORE state.json exists) · a terminal pipeline
#         (complete|failed) · awaiting=="user" (the [I] design back-and-forth).
#   DENY  otherwise — status==running with awaiting null OR "workflow":
#         - awaiting==null      → a plain mid-autonomous stage.
#         - awaiting=="workflow" → a fan-out is in flight OR (the bug this closes)
#           has JUST returned and re-invoked the orchestrator, which then tried to
#           ask BEFORE clearing awaiting to null. The Stop hook MUST allow the
#           yield while a fan-out runs, so it tolerates "workflow"; but there is
#           NO state in which asking-during-workflow is correct (during the
#           fan-out the orchestrator has yielded and isn't executing; right after,
#           it's autonomous again). So this firewall — unlike the Stop hook —
#           never treats "workflow" as ask-legal.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/lib/common.sh"
require_jq

input="$(cat)"

# Host contract (S37): an autonomous host session has no human to answer, in any
# pipeline state, including before state.json exists. Without the env this
# branch is skipped and the hook behaves exactly as before.
if atelier_autonomous; then
  needs_you="${ATELIER_HOST_NEEDS_YOU_TOOL:-}"
  [[ "$needs_you" =~ ^mcp__[A-Za-z0-9_]+__[A-Za-z0-9_]+$ ]] || needs_you=""
  # Only an owned running pipeline has a brief.md and a state.json to write;
  # any other task in the session gets a reason that names neither.
  sp=""
  sid="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null || true)"
  if [ -n "$sid" ]; then
    cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
    [ -n "$cwd" ] && cd "$cwd" 2>/dev/null || true
    wsp="$(find_workspace_root "${cwd:-$PWD}" 2>/dev/null || true)"
    [ -n "$wsp" ] && sp="$(find_owned_running_pipeline "$wsp" "$sid" 2>/dev/null || true)"
  fi
  if [ -n "$sp" ]; then
    if [ -n "$needs_you" ]; then
      blocked="call ${needs_you} with the reason, then set awaiting:\"user\" with the reason in failure.reason, write state.json and end the turn"
    else
      blocked='set awaiting:"user" with the reason in failure.reason, write state.json and end the turn'
    fi
    reason="Atelier host contract: this session is autonomous (ATELIER_AUTONOMY). Decide with the sensible default and record the assumption in brief.md. If you are truly blocked, ${blocked}."
  else
    if [ -n "$needs_you" ]; then
      blocked="call ${needs_you} with the reason"
    else
      blocked="say what blocks you in your reply and end the turn"
    fi
    reason="Atelier host contract: this session is autonomous (ATELIER_AUTONOMY), so nobody answers questions. Decide with a sensible default and say so in your reply. If you are truly blocked, ${blocked}."
  fi
  jq -nc --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
fi

sid="$(printf '%s' "$input" | jq -r '.session_id // empty')"
[ -n "$sid" ] || exit 0
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty')"
[ -n "$cwd" ] && cd "$cwd" 2>/dev/null || true
wsp="$(find_workspace_root "${cwd:-$PWD}")"

sp="$(find_owned_running_pipeline "$wsp" "$sid")"
[ -n "$sp" ] || exit 0                       # no owned running pipeline → ALLOW

status="$(jq -r '.status // empty' "$sp" 2>/dev/null || true)"
awaiting="$(jq -r '.awaiting // empty' "$sp" 2>/dev/null || true)"
case "$status" in complete|failed) exit 0 ;; esac      # terminal → ALLOW
[ "$awaiting" = "user" ] && exit 0                      # interactive [I] design → the ONLY ask-legal state
# everything else (status running, awaiting null OR "workflow") → DENY below.

# status==running AND awaiting is null OR "workflow" → autonomous → DENY the question.
# Self-contained reason so a post-compaction orchestrator re-grounds itself and
# knows the autonomous response is DEFAULT-AND-ADVANCE, with FAIL as the rare
# last resort — never ASK.
pid="$(jq -r '.id // empty' "$sp" 2>/dev/null || true)"
phase="$(jq -r '.phase // empty' "$sp" 2>/dev/null || true)"
reason="Atelier full-autonomy contract: pipeline ${pid} is mid-autonomous execution at phase '${phase}' (status running, awaiting '${awaiting:-null}'). You may NOT ask the user — there is no human in the loop after Brainstorm. Almost always the right move is to DECIDE IT YOURSELF: take the sensible default (the most reasonable, reversible, convention-matching choice) and keep driving — a question you were about to ask is a decision you should make. If a fan-out just returned (awaiting is still 'workflow'), process its result autonomously: on a review's findings — however large or architectural — dispatch the fix to MEET THE SPEC/PLAN, because the spec is the contract; build exactly what it requires and do NOT ask the user to set, confirm, or lower the acceptance bar — then set awaiting:null and continue. status:\"failed\" is the LAST RESORT, only when you LEGITIMATELY CANNOT ADVANCE: a genuine hard blocker with no workable default — e.g. a required credential that is truly absent and nothing can substitute (it should have been captured in the spec's 'Prerequisites / Required Access' section during speccing). Only in that case write failure:{stage,reason,lastError} naming the blocker to ${sp} and stop. Do NOT fail for anything a sensible default would carry. A decision only the owner can make goes into a gate file (gates/<id>.md, VERDICT/SIGNED left blank) and the flow continues on everything it does not block. (If this genuinely IS the Brainstorm phase, you forgot to set awaiting:\"user\" in state.json first — set it, then ask.)"
jq -nc --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
exit 0
