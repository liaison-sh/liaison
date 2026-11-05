---
title: What is Liaison
description: Learn what Liaison is, what is in it, and how its AI agents work under your team's permissions, before you try it or install it.
screenshot: "assets/screens/home.webp"
screenshotAlt: "The Home overview with the sidebar listing approvals and queues, and a feed of pending approval requests with Approve and Reject buttons."
---

Liaison is a workspace for your team's mail, tickets, knowledge, invoicing, shipping and more, where AI agents work alongside you under the same permissions. You run it yourself with Docker Compose. This page tells you what is inside and where to go next.

## What is in the workspace

Kernel apps ship with the platform:

| App | What it does |
|---|---|
| **Mail** | Send and receive email from connected mailboxes |
| **Tickets** | The support inbox: customer issues, returns and warranty cases, with status and assignee |
| **Projects** | Projects and tasks with an owner, a status and a due date |
| **Knowledge** | The organization's shared policies, product facts, FAQ and procedures |
| **Contacts** | The directory of people and companies |
| **Calendar** | Org and personal calendars, synced both ways with Google Calendar |
| **Messages** | Conversations with your team and your agents |

Connectors for Google Drive, GitLab, your own database and your own HTTP API (the API connector) are also built in.

Bundled apps install the same way a third-party app would: Shopify, Invoicing, Shipping (Boxtal), Finance (Pennylane), Ads, Social, Calls and Monitoring.

You can also build your own app with the app SDK. See [Build an app](../app-development.md).

## How agents work

An agent acts through the same tools and access rules as a person. Row-level security in the database, not the agent's judgment, decides what it can see. Sensitive actions, such as sending a reply to a customer, wait for a person to approve them before they run.

MCP works both ways: your agents can use the tools you already run, and outside agents can work inside Liaison.

See [How agents work](../agents/how-agents-work.md) and [Approve what agents do](../agents/approvals.md).

## Where it runs

Liaison is self-hosted. The stack is one app image plus PostgreSQL, Redis, MeiliSearch and an S3-compatible object store (SeaweedFS is bundled). You bring your own model key. Desktop apps for macOS, Windows and Linux and phone apps for iPhone and Android wrap the same web app.

Liaison is source-available under the Functional Source License 1.1 (FSL-1.1-ALv2). You can use, modify and self-host it for your own internal use, including commercial use, but not offer it as a competing product or service. Each release becomes available under the Apache License 2.0 two years after it ships.

## Next steps

- [Try the demo](demo.md): your own temporary copy of a sample company, nothing to install.
- [Install Liaison](install.md): about 9 minutes in the best case with the setup playbook.
- [Set up your organization](first-org.md)
