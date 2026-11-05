---
name: sub-agent-dispatch
type: skill
description: When and how to fan out sub-agents: briefing, reusable roles, per-entity research.
---

## Sub-Agent Dispatch

When a task naturally decomposes into N independent units of work, and each unit needs deep investigation, untrusted external content, or a different tool surface than your own, use `kernel__spawn_agent` to dispatch a fresh-context sub-agent per unit.

**When TO spawn:**
- Per-record work where reasoning must not bleed between records (e.g. one sub-agent per support ticket).
- **Researching or profiling SEVERAL named entities** (several dealers, companies, contacts, products) where each needs its own web research before you can synthesize. Doing N web-research passes yourself in one turn is what blows the step/time budget and produces shallow, cross-contaminated, or fabricated results; one sub-agent per entity (each with its own budget) is the reliable way. If the user hands you a list ("profile these 5 dealers", "research these companies"), that is a fan-out: one spawn per item, sent together.
- Tasks needing untrusted content (web pages, customer emails) where prompt-injection containment matters.
- Subtasks needing a *different scope set* than yours: let the role declare its narrower ceiling.

**When NOT to spawn:**
- A single tool call would do.
- Reading a known file path: use the read tool.
- Searching for a specific symbol: use search directly.

**How to spawn:**
- **Brief the agent like a smart colleague who just walked into the room: it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.**
  - Explain what you're trying to accomplish and why.
  - Describe what you've already learned or ruled out.
  - Give enough context that the agent can make judgment calls, not just follow a narrow instruction.
- **Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, post the message." Those phrases push synthesis onto the sub-agent. Write prompts that prove you understood: include file paths, ids, what specifically to do.
- If the user asks for parallel work, send a single message with multiple `kernel__spawn_agent` tool calls.
- **`kernel__spawn_agent` requires an existing role `agentType`**: it is not a free-form spawn. Call `kernel__subagent_list` first to see which roles are registered (each has an `agentType` slug, a `whenToUse`, and a scope ceiling), then pass the matching slug as `subagent_type`. If a fitting role already exists (e.g. a `dealer-researcher` for per-dealer web research), reuse it: one spawn per item against that slug. Only when NO suitable role exists and you can author one (you hold the role-admin scope) do you `kernel__subagent_create` a new one first. Never invent an `agentType` you haven't seen in `kernel__subagent_list`.

The sub-agent runs in a hidden thread; you receive only its structured result, not its intermediate steps. The user sees a collapsed card in this thread; expanding it shows the sub-agent's full transcript. Trust the result.

**Reusable sub-agent ROLES.** When the user wants a *recurring* kind of sub-agent, a named role they will spawn over and over (e.g. "a dealer-researcher I can spawn per dealer"), register it once as a durable role with `kernel__subagent_create` instead of crafting a one-off prompt each time. A role carries a slug (`agentType`, lowercase-kebab), a `whenToUse`, and a `scopeCeiling` you design as LEAST PRIVILEGE for its job (a web-researcher wants web + a light read like contacts:read, and NO write scopes). `appName` is optional: omit it for an org-owned role (the ceiling is then bounded by your own scopes). It is idempotent on the slug. Once registered it is referenceable by `agentType` from `kernel__spawn_agent`, so each spawn gets its OWN isolated context and budget: one fresh researcher per dealer, no cross-contamination. Use `kernel__subagent_list` to see what roles already exist before adding one.
