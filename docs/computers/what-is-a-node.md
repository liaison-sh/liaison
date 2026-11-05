---
title: What a computer is
description: "Learn how your own computer becomes a place where agents run coding sessions with your Claude account, and what stays on it."
---

In Liaison a "computer" (the technical word is a node) is one of your own machines running the Liaison desktop app, switched on for agents. Agents can then hand it work: a coding session of Claude Code that uses your files, your git login and your tools, signed in as you, outside the Liaison server.

This page explains what that gives you, what it does not, and what you need. To set one up, go to [Connect your computer](../computers/connect.md).

## Where an agent can run

| Place | Where the work happens | Files and tools | Whose Claude account |
| --- | --- | --- | --- |
| **Liaison** | On the Liaison server, from any device | Liaison's own tools. It cannot touch your files or run scripts. | The organization's models |
| **This machine** | In the desktop app, in a folder you pick | Your files and scripts in that folder | Your Claude account |
| **My computer** | On one of your computers, even while you are away | The folders you shared, your git login, your scripts | Your Claude account |

A conversation shows where it runs in the runtime menu, **Where turns run**. See [Run work on your computer](../computers/run-work.md).

## What runs on a computer

- **Sessions.** An agent starts a Claude Code session in a folder you shared, for example "Fix the failing test in my-repo". You follow, steer and stop it in **Sessions**. See [Sessions](../computers/sessions.md).
- **Routines.** A routine can run on your computer instead of the cloud. See [Schedule routines](../agents/routines.md).
- **Chats.** A conversation can run on **My computer**, so the agent works with the computer's files and scripts.
- **Requests from other agents.** An agent you attach to your computer can receive work from the people and agents you allow, within daily limits.
- **Claude Code sessions you already have.** You can import sessions from VS Code or the terminal, to follow them or take them over from Liaison.

A session is Claude Code, run by the desktop app through its Agent SDK sidecar, so the app must be running on the computer. Browsers and the phone app cannot host a computer, but they can start sessions on yours, steer them, and approve what they ask.

## What you need

- The Liaison desktop app on macOS, Windows or Linux. See [Desktop and phone](../getting-started/desktop-and-phone.md).
- A Liaison account on your organization's server.
- A Claude account, signed in inside the app. Sessions use it, not the organization's model keys or credits.

## What stays on your computer

- **Folder paths.** Liaison shows folder names. The server stores the real paths only for you, never sends them to other clients, and agents see `~/...` display paths and opaque ids.
- **Files.** The agent works on the files in place. Liaison receives the session's event stream: its messages, its tool calls and the changes it reports under **Files changed**. Each large piece is cut at 64 KB.
- **Credentials.** The computer keeps its own Liaison credential and your git login. Cloning a repository uses the computer's own git login. No token passes through Liaison.
- **Large outputs.** Tool results over 64 KB stay on the computer and are fetched only when you click **Show full output**.

The computer is online while it holds a live connection to Liaison. The app sends a heartbeat every 30 seconds, and a computer that stays silent for 60 seconds shows as offline. When it goes offline its running sessions become **Paused** and resume when it returns. See [Security](../computers/security.md).

## Limits you control

- **Folders.** Agents only work in the folders you add. See [Choose where agents can work](../computers/folders.md).
- **Guardrail levels.** Each agent runs at a level, **Strict**, **Standard** or **Open**, that decides what its commands may touch. See [Guardrails and permission modes](../computers/guardrails.md).
- **Approvals.** Starting work on your computer is approved by you, and only you.

## Try it in the demo

On the demo, a developer scenario plays a recorded Claude Code session on a simulated computer. The session shows the stream, tool calls, a permission request that waits for your answer, and a pull request. It is marked **Recorded session**, with the hint that no computer is running it, and ends with a card that offers **Download the desktop app** to run your own. See [Try the demo](../getting-started/demo.md).

## Next steps

- [Connect your computer](../computers/connect.md)
- [Choose where agents can work](../computers/folders.md)
- [Run work on your computer](../computers/run-work.md)
