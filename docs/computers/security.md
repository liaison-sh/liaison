---
title: Security of a computer
description: "Understand what a connected computer trusts, what the Liaison server can and cannot make it do, and what administrators can and cannot see."
---

A computer you connect runs code on your own machine, so Liaison treats it as the most sensitive thing an agent can touch. This page lists the protections, in plain terms. It also says where the limits are.

## The short version

- Only you decide that a computer is used, which folders it shares and which level each agent runs at.
- The server never shows your folder paths to anyone but you, and cannot raise a level without your confirmation in the app.
- Starting work, sharing a folder, cloning a repository and importing a session each need your own approval. No administrator can give it for you.
- A session's results can only carry what the session was allowed to see.
- Nobody else sees your sessions.

## The computer's credential

When you turn a computer on, Liaison issues it a credential and the app keeps it in a private file on that machine (readable only by you).

- It starts with `lnn_` and is long and random. Liaison stores only a hash of it (SHA-256), never the credential itself.
- The computer presents it in the `X-Node-Credential` header, next to your own signed-in session. Both must name the same person. A credential alone does nothing.
- Turning a computer on again after it was removed issues a new credential. Removing the computer revokes it at once.
- A recorded demo computer can never hold a credential.

The folder, session and level routes that you use from the app refuse a computer credential, and they refuse an MCP token as well. So neither a computer nor an agent connected over MCP can share a folder, steer a session or raise a level through them. A restricted sign-in, such as one a command-line client received with limited scopes, cannot steer a computer either.

The Liaison tools inside a session use a separate token that lives 15 minutes and is renewed on its own. If the connection is revoked, the app asks you to approve the device again.

## Decisions that only you can make

| Decision | How it is protected |
| --- | --- |
| Start a session from a chat | Asked of the owner of the computer. If the turn read outside text, or did not start from a message you typed, it parks as an approval that only you can decide. |
| Share a folder, clone a repository | The agent tool is an approval card that only the owner decides. |
| Import a Claude Code session | Only your click approves it. No policy does. |
| Raise a level, or choose **Open** | A confirmation in the app, tied to one computer, one agent or session, one level and one purpose. It lasts 5 minutes and is used once. It cannot be created by an agent tool, an MCP token, an API key or a computer credential. |
| Add an agent to your computer | Only you. A shared role agent also needs an administrator to allow it. |

An administrator, or a colleague holding an approve scope, cannot decide these on your behalf. See [Approve what agents do](../agents/approvals.md).

## What the Liaison server can and cannot make a computer do

The server can:

- Queue work for a computer: a session, a routine run, a request from an attached agent.
- Send your own commands to a running session: messages, stop, mark done, model and level changes you confirmed, your answers to permission requests and questions.
- Ask the computer to look up folders, scan for repositories, clone a repository and list sessions, when you or your approved agent ask.

The server cannot:

- Run anything outside the folders you shared.
- Start a session above the level you confirmed for that agent.
- Pick a model the computer does not offer.
- Read your files. It shows other clients and agents folder names only. The real paths live in a table readable by you alone.
- Raise a level, or make an approval on your behalf.
- Switch a chat on your computer to **Bypass permissions**. The server refuses it, the computer refuses it again, and the database cannot store it.

Work that was created while none of your computers was online is held. The computer fetches it and asks you before running it. A run that was interrupted after it started is never repeated silently. You choose.

## What a session's results can carry

A session's answer is posted back into a conversation. Liaison tags it with the scopes the session could see, and never takes that tag from the computer:

- the scopes of what the agent was allowed to read,
- every scope the session's Liaison tools touched during the whole run,
- plus the scopes of the content that triggered the run.

Anyone who cannot read all of that cannot read the reply either. Text written by the session is also fenced as session data, with angle brackets neutralised, so it cannot pose as instructions to the agent that reads it.

## Untrusted input

Mail, tickets and web pages can try to steer a model.

- **Events are capped.** A run started by an event is limited to `NODE_EVENT_RUN_MAX_LEVEL` (default `strict`), whatever the agent's profile says. See [Guardrails and permission modes](../computers/guardrails.md).
- **Auto asks more.** Once a session has read text from outside the organization, shell commands ask as in **Manual**. A chat that continues an earlier session keeps that session's answer, recorded on the computer after each turn; when there is none, it asks. A large Liaison result the computer saved to a file is judged by the file's text. A download from the Liaison server the computer is connected to is not outside text, and Auto may run what it downloaded, but only with `curl` (or `wget --max-redirect=0`), plain `https://` addresses on exactly that server, and no redirect following (`-L`), proxy or certificate option. Any other host, a mixed command or an address the shell computes asks as before.
- **Starting work parks.** A turn that read outside text cannot start a session without your approval.
- **Guardrails bound the damage.** **Strict** and **Standard** run commands in a sandbox, deny your secrets, deny writes to install and configuration paths, deny destructive git commands and run a pre-push hook. The honest limit: a prompt-injected session can still try to push to the default branch from a script. The hook refuses it, but a script may get past it.

## What stays on the machine

- **Paths.** The server never gets or returns a folder path to clients. Agents see `~/...` display paths and opaque ids that last one hour and work once.
- **Large output.** Results over 64 KB stay on the computer and are fetched for 24 hours on request.
- **Imports.** Liaison strips keys, tokens, private keys and secret lines from an imported transcript before it leaves the computer. This is best effort.
- **Local sessions on This machine.** For a session that runs in the desktop app on **This machine**, the prompts, answers and files never reach the server. Only an audit record does: a hash of the folder, a hash of the prompt, the mode and the model, never a path.
- **Git login.** A clone uses the computer's own ssh key or saved password. No token passes through Liaison.

## Who can see what

- Your sessions are visible to you only. Another user, an organization administrator included, does not see them, and asking for one reads as not found.
- The audit log records the agents that act. For local sessions it holds the hashes above. See [Admin settings](../admin/settings.md).

## What an administrator can do

- Allow the desktop app as a sign-in client with `DEVICE_FLOW_CLIENTS` (the value is `liaison-desktop`).
- Set the highest level an event-started run may use with `NODE_EVENT_RUN_MAX_LEVEL`.
- Allow a shared role agent to be attached to a user's computer.
- Define roles and scopes for who can ask agents to work at all. See [Roles](../admin/roles.md).

An administrator cannot approve work on someone else's computer, see their sessions, or read their folder paths.

## Next steps

- [Guardrails and permission modes](../computers/guardrails.md)
- [Run work on your computer](../computers/run-work.md)
- [Security overview](../security.md)
