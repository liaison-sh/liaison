---
title: Guardrails and permission modes
description: "Choose how much each agent may do on your computer with Strict, Standard or Open, and set when a session asks before it acts."
---

Two settings decide what an agent can do on your computer. The guardrail level says what its commands may touch. The permission mode says when a session stops to ask you. This page explains both, and how to change them safely.

## Guardrail levels

Each agent has one level on your computers: **Strict**, **Standard** or **Open**. A session runs at its agent's level.

| | **Strict** (default) | **Standard** | **Open** |
| --- | --- | --- | --- |
| In one line | Only the session's folder, approved websites, in a sandbox. Safest for agents that read mail, tickets or the web. | Reads and writes anywhere except your secrets, any website, in a sandbox. | A plain Claude Code session: no sandbox, your secrets readable, your hooks and MCP servers loaded. |
| Commands run in the OS sandbox | Yes | Yes | No |
| Reads and writes | The session's folder only | Your home folder, except your secrets | Anywhere |
| Network | An allowlist | Open | Open |
| Secrets | Denied | Denied | Readable |
| Install, persistence and config paths | Write-denied | Write-denied | Allowed |
| Destructive git commands | Denied | Denied | Allowed |
| Pre-push hook | On | On | Off |
| Hooks from your Claude Code settings | Off | Off | Loaded |
| MCP servers | Only Liaison's | Yours and the project's tracked ones | All |
| Local ports (dev servers) | Not allowed | Allowed | Allowed |
| Can still ask you about | Writing outside the folder, a website outside the allowlist, pushing to a non-default branch | Writing outside the folder | Nothing |

At every level, protected branches are `main`, `master`, `trunk`, `develop` and `production`. A session below **Open** that works in place on a default or protected branch starts its own branch when it is to finish with a commit or a pull request, so it never switches your checkout.

A few tools are denied below **Open**: `EnterWorktree`, `CronCreate`, `ScheduleWakeup` and `RemoteTrigger`. Standard also lets common Playwright test commands (`npx playwright test` and the `bunx`, `pnpm exec` and `yarn exec` forms) run outside the sandbox, because headless Chromium cannot start inside it. Every such run asks you first. It is never allowed automatically, not in autonomous mode, and not by **Allow for this session**.

### Which level to pick

Give an agent the lowest level that does its job. Untrusted input such as mail, tickets and web pages can steer any model running on your computer, and small, cheap models more easily. Guardrails cost some efficiency, so they are recommended on cheap models.

Liaison suggests **Standard** for frontier models (the Opus and Fable families) and **Strict** for everything else, including models it cannot place and **Auto**. **Open** is never suggested. A **suggested** mark appears beside the suggested level.

The risk note says it plainly: on **Strict** and **Standard**, a determined prompt-injected session can still try to push to the default branch from a script. The pre-push hook refuses it, but a script can get past it.

### Set an agent's level

1. Open **Settings › Computers**, click the computer and open the **Agents** tab (**Agents that can run here**).
2. Find the agent. The column **What it may do** shows its level.
3. Choose **Strict**, **Standard** or **Open**.
4. For a higher level, or for **Open**, a dialog asks first. See the next section.

The level is saved for all your computers and applies from the next session. For each computer, it must be confirmed once. If a level was raised and this computer has not confirmed it, the row reads **Raised from** the old level and **confirm it for** the computer **before it applies**, with **Confirm** and the level.

Under **Liaison tools in its sessions** you choose whether the agent's sessions get the Liaison tools (the Liaison MCP server). **Strict** only allows that one MCP server.

### Raise a level

Raising a level is a decision only you can make, in the app:

1. Choose a higher level. A dialog reads **Raise** the agent **to** the level?, says what the level allows and which computers it applies to.
2. Click **Raise to** the level. **Cancel** changes nothing.

The same dialog protects a single session. When you start a session above its agent's level, it asks **Run this session at** the level, with **Start at** the level. For a running session, it asks **Raise this session to** the level and restarts at the end of its current step.

- Every choice of **Open** asks again.
- A confirmation is valid for 5 minutes unless it is already attached to the change. It is tied to one computer, one agent or session, one level and one purpose, and is used once.
- Nothing can confirm for you. An agent tool, an MCP token, an API key or a computer's own credential cannot. No dialog ever appears on the computer itself.
- Lowering a level asks nothing.

## Permission modes

A permission mode applies to chats that run on a computer. It decides when the session asks before acting.

| Mode | What it does |
| --- | --- |
| **Auto** | Runs Liaison tools and everyday commands without asking. Risky actions still ask. |
| **Manual** | Asks for approval before every edit. |
| **Edit automatically** | Edits files without asking. Other actions still ask. |
| **Plan** | Explores and presents a plan before editing. |
| **Bypass permissions** | Never asks. Runs potentially dangerous commands. |

Where each mode exists:

| Where the chat runs | Modes | Menu |
| --- | --- | --- |
| This machine, in the desktop app | **Auto** (the default), **Manual**, **Edit automatically**, **Plan**, **Bypass permissions** | **How this session asks before it acts** |
| My computer, driven from the web, the phone or the app | **Auto**, **Manual**, **Edit automatically**, **Plan**. Never **Bypass permissions**. | **Permission mode on your computer** |

**Bypass permissions** is available only for a session on **This machine**, where you are at the keyboard. The app asks you through its own native dialog naming the folder. If you decline, the session does not start. A chat driven from the web or a phone cannot use it: the server refuses it with `bypass_unavailable_remote`, the computer refuses it again, and the database cannot store it.

A chat you start from the web or a phone runs in **Manual** until you opt in. In the desktop app, open the computer's **Settings** tab and turn on **Auto for chats started elsewhere**. The question is confirmed on that computer. Until then, every command and file change waits for your answer, because nobody may be at the computer.

How **Auto** decides, on every model and plan:

- A Liaison tool is allowed. Liaison still checks its own scopes, and a gated tool still creates an approval a person decides on the server. Allowing the call is not approving the action.
- A shell command is allowed unless it is clearly destructive.
- Anything outside the folder, anything flagged as dangerous, and every other tool asks, as in **Manual**.
- Once the session has read text written outside the organization, shell commands ask as in **Manual**.

The mode is stored with the conversation. A change applies to the next turn, not to a job already running.

## Permission prompts

When a chat asks before acting, the prompt reaches you in one of two places.

| Session | The prompt | If nobody answers |
| --- | --- | --- |
| Desktop **This machine** | A card in the tool-call row: **Permission needed**, with **Allow** and **Deny** | No time limit: the card stays until you answer. Stopping the turn denies it. |
| A chat on **My computer**, driven remotely | A card: **{agent} on {computer} asks to use {tool}**, labelled **Permission needed on your computer**, with **Allow** and **Deny**, in the chat, above the message box. Home shows **{agent} needs your OK in the chat**, which opens the chat | Denied automatically after 10 minutes. The card says **Denied automatically after 10 minutes without an answer.** and later **Expired: it was denied automatically.** |
| A session in **Sessions** | A card: **Needs your OK to run**, with **Allow once**, **Allow for this session** and **Deny** | The session waits for you with no time limit |

Once you answer a card in the chat, it gives way to a short muted line, **You allowed: {tool}** or **You denied: {tool}**, with what was asked, until the turn ends. A new request appears in the open chat as soon as it is made, without a reload. Your answer in the chat is the only one asked for: the computer shows no dialog of its own for it. The card shows the whole call: the command as it runs, or the tool's full input, a file's content included. A call the card cannot show exactly is denied at once and never reaches you as a card: one whose input contains a secret (the chat shows it with the secret hidden) or one longer than 2000 characters. The agent is told why.

Home shows one **{agent} needs your OK in the chat** row per conversation, for its newest open request. The row leaves Home as soon as the request is answered, expires, or its turn ends.

A prompt never defaults to yes. A session that runs without anyone watching, such as a routine or a request from another agent, runs under its level without asking, and a prompt from it is refused. A request that was already answered or has expired shows **This request was already answered or has expired.**

## Limit unattended runs

A run started by an event, such as an inbound mail or a ticket, has outside text in its prompt and nobody watching. It never runs above the level in `NODE_EVENT_RUN_MAX_LEVEL`, whatever the agent's profile says. The values are `strict`, `standard` and `open`, and the default is `strict`. A scheduled or manual run keeps the profile level. Raise the variable only if event-driven runs on computers truly need more. See [Schedule routines](../agents/routines.md#run-a-routine-on-your-computer).

## Next steps

- [Security of a computer](../computers/security.md)
- [Sessions](../computers/sessions.md)
- [Run work on your computer](../computers/run-work.md)
