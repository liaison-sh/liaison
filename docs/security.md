---
title: "Keep Liaison and its agents secure"
description: "How Liaison limits what people and agents can see and do, how to run agents safely, and how to report a vulnerability."
---

Liaison runs on your own server, and every person and agent works under the same permission checks. This page explains the protections and what is left to you.

## Report a vulnerability

Do not report security issues in public GitHub issues.

1. Open the [Security tab](https://github.com/liaison-sh/liaison/security) of the repository.
2. Click **Report a vulnerability**.
3. Include the steps to reproduce, the version, and the impact.

You can also email mathieu@liaison.sh.

Fixes land on `main` first and ship in the next release. Only the latest server release, the latest desktop app and the latest phone app get fixes, so upgrade before you report. See [Upgrade Liaison](admin/upgrades.md).

## Understand what limits an agent

Agents read text written by people outside your company: inbound email, tickets, web pages, documents and results from connected tools. That text can carry instructions aimed at the model. This is called prompt injection. No model is immune to it, and Liaison does not claim to detect it. Instead, Liaison limits what a fooled agent can do:

- An agent acts with the permissions of the person it works for. Postgres row-level security enforces this, so the agent cannot read or change anything that person cannot. See [Control what an agent can do](agents/permissions.md).
- Sensitive actions wait for a person to approve them: customer replies, invoices, discounts, record merges. The approval shows what will run, and the person can edit or reject it. See [Approve what agents do](agents/approvals.md).
- Once an agent has read outside content, its actions that leave your company wait for approval, even ones that are normally automatic.
- Every tool call is recorded with the person, agent, routine or MCP client that asked for it.

## Choose the agent safety setting

The setting lives in **Settings › Agent Safety**.

- **Ask for approval after outside content** is on by default. Once a conversation has read outside content, the agent's actions that leave the organization (sending, replying, posting, paying) and its writes to memory and Knowledge wait for a person, unless an auto-approve policy covers them.
- Switch it off only if you accept the risk. Anyone who can email you or publish a page the agent reads may then be able to steer what it sends or saves.

## Run agents safely

- **Use a frontier model** for any agent that reads outside input or does multi-step work. Smaller models follow injected instructions more easily. In Auto mode Liaison picks the cheapest model you have enabled, so choose the model yourself for those agents. See [Choose a model](agents/models.md).
- **Keep approvals on** for anything that leaves your company: customer replies, invoices, refunds, payments.
- **Read the approval before you approve it.** It is the last check between the model and the outside world.
- **Give agents the narrowest permissions that do the job.** An agent that sorts support tickets does not need accounting.
- **Connect only MCP servers and apps you trust.** Their tool descriptions and results reach the model too. See [Connect MCP servers](agents/mcp-servers.md).
- **Review code that computer sessions produce** before you merge or run it. A session runs on your own computer with your access. See [Computer security](computers/security.md).

## Know how sign-in is protected

- Access tokens last 15 minutes. Refresh tokens last 30 days and live in an HttpOnly, Secure, SameSite=Strict cookie.
- Each refresh replaces the refresh token. If a replaced token is used again after its replacement was used, Liaison treats it as stolen and signs out every session that came from that sign-in. A retry within 3 minutes, from the same browser, of a refresh whose answer was lost on the network keeps you signed in.
- Signing out, changing or resetting your password, and deactivating or erasing an account end the session at once: its access tokens are refused within seconds on every server process, even though they have not expired yet, and its open real-time connections close. The desktop and phone apps forget their stored tokens on sign out, even when the server cannot be reached.
- People can add a one-time code (TOTP) to their sign-in.
- Secrets stored by Liaison (connected account tokens, OAuth client secrets, TOTP secrets) are encrypted with AES-256-GCM using the `ENCRYPTION_KEY` you set. See [Environment variables](reference/env.md).
- Apps run in a sandbox with no access to the host. They reach only the data, events and network domains their manifest declares. See [App sandbox](app-sandbox.md).

## Mail encryption

Mail from a personal mailbox is encrypted at rest, in one of two modes each person chooses (if their organization allows private mailboxes):

- **Transparent**: each mailbox has its own data key, stored encrypted with `ENCRYPTION_KEY` (AES-256-GCM). The server opens the mail only for the mailbox's owner and the owner's agent, and records each read in the audit log (who, which mailbox and messages, why; never the content). Your organization's admins cannot read it. Whoever holds both the database and `ENCRYPTION_KEY` (the operator of the server) technically could. `liaison keys rotate` re-encrypts these keys with a new `ENCRYPTION_KEY`; a full export keeps them, so keep `ENCRYPTION_KEY` out of your database backups.
- **Private** (zero-access): sealed to a key only the owner's browser holds, opened with their mailbox password or a passkey. The server cannot read it.

An operator who must keep every mailbox zero-access sets `MAILBOX_ENCRYPTION_ALLOW_MANAGED=false`: `MAILBOX_ENCRYPTION_DEFAULT=private` alone is only a default, which people can change for their own mailboxes. See [Docker](self-hosting/docker.md#mail-encryption).

Mail from a shared (organization) mailbox is not encrypted this way. See [Mail](apps/mail.md#choose-how-your-mailbox-is-encrypted).
