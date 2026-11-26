---
title: Build an app for your organization with Claude Code or Codex
description: "Connect Claude Code or Codex to your Liaison organization, ask it for an app, and an admin publishes it: no server, no code checkout."
---

Your coding assistant can build a small app for your organization: a visit log, a returns tracker, a read of an outside service. It writes the app, the Liaison server builds and checks it, the assistant tries each tool, and an admin approves the publish. You need no server and no copy of Liaison's code.

This works on any Liaison server that lets organizations have their own apps: it is on in the managed edition and off on a self-hosted server until its operator sets `LIAISON_CUSTOM_APPS=on` (see [Build an app with your agent](../agents/build-an-app.md#turn-it-on-self-hosted)).

## What you need

- A Liaison account with the `kernel:apps:build` scope (admins have it).
- A person holding `kernel:apps:admin` to approve the publish (an admin; it can be you).
- Claude Code, Codex or another MCP client connected to your organization's MCP server. See [Use Liaison over MCP](mcp.md#connect-claude-code-or-claude-desktop). For Claude Code:

  ```
  claude mcp add --transport http liaison https://<your Liaison address>/mcp
  ```

## Give your assistant the skill

The skill tells the assistant the whole loop: the tools, their inputs, the limits, what each refusal means, and a worked example that the Liaison repository checks with every change. It is the file [`.claude/skills/building-an-org-app/SKILL.md`](https://github.com/liaison-sh/liaison/blob/main/.claude/skills/building-an-org-app/SKILL.md).

- **Claude Code:** save it as `~/.claude/skills/building-an-org-app/SKILL.md`. Claude Code picks it up in every project.
- **Codex:** save it next to your project and add a line to the project's `AGENTS.md`: "To build a Liaison app, follow `building-an-org-app/SKILL.md`."
- **Working inside a Liaison checkout:** nothing to do; the repository's `AGENTS.md` points to it.

## Ask for the app

Tell the assistant what the app should do, for example "build a visit log for our org: log a customer visit with a note, and show the latest visits on a page". The assistant then:

1. starts a draft with `kernel__apps_build_create`, which gives the app its name, `<name>-o<your organization's key>`;
2. writes its files with `kernel__apps_build_update`: the manifest, the handlers and, for a page, the interface;
3. builds and type-checks it with `kernel__apps_build_check`, and fixes every error at the file and line it names;
4. tries each tool with `kernel__apps_build_preview`, as you, without installing anything;
5. asks to publish with `kernel__apps_build_publish`.

A draft holds four files at most (`app.manifest.json`, `handlers.ts`, `ui.tsx`, `README.md`), 512 KiB together. The last 20 versions are kept.

## Try it before it is published

A try runs one tool as you and changes nothing real: writes to your organization's data are refused, and what the app stores goes to a scratch space of the draft, which the next try of the same version still sees. Before the first publish the app has no tables and reaches no website. A try lasts 30 seconds at most, and its log lines come back with the result.

The assistant cannot show you the app's page. Open **Settings › App store**, then the draft under **Apps in the making**: the page runs there in a sealed frame, and its buttons run tries.

## Approve and publish

The publish waits for a person holding `kernel:apps:admin`. The approval card shows the app's name, version and package fingerprint, its type check result, the websites it may reach and what access changes. Nothing is approved automatically. Once approved the app is On, members get its scopes, and its page, when it declares one in the activity bar, is there. The assistant finds the app's tools with `liaison_tool_search` and calls them with `liaison_call_tool`.

## Change it, roll it back, read its logs

- **Change:** ask the assistant. It updates, checks, tries and publishes again; each publish is the next patch version and needs a new approval.
- **Roll back:** the assistant restores the earlier version with `kernel__apps_build_restore` and publishes it as the next version. Tables the old version no longer declares are kept with their data.
- **Logs:** `kernel__apps_build_logs` reads the app's log lines (kept 7 days) for a holder of `kernel:apps:logs`, or your own tries' lines.

## What an organization's app may not do

The server refuses, and the check names: `trusted`, `routes`, `rlsManagedBy`, `network.allowPrivateHostsInTest`, a connection that lists no allowed domains, a capability reserved to apps the server's operator installs, a tool or webhook over 5 seconds or a job over 60 seconds, a webhook body over 1 MB, PDF templates, and tables that reference another app's schema or declare triggers. Outside websites must be listed in `network.allowedDomains`; the approver sees each one. Your plan may limit the number of custom apps and their daily runs. See [Building a Liaison App](../app-development.md) for the full rules, and for apps built inside a Liaison fork instead.
