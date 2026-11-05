---
title: Set up your organization
description: Sign in as the admin, invite your team, connect a mailbox and create your first agent in a new Liaison organization.
---

Once Liaison is running, you have an organization and an admin account. This page takes you from the first sign-in to a working agent.

## Sign in as the admin

1. Open your Liaison URL, for example `http://127.0.0.1:3000` for a local trial.
2. Enter your **Email** and click **Continue with email**.
3. Enter the 6-digit **Sign-in code** and click **Verify code**. The code expires in 10 minutes.

On a local trial without SMTP, the code is in the app log. See [Install Liaison](install.md#sign-in-the-first-time).

## Invite your team

1. Open **Settings › Users** and click **Invite user**.
2. Enter the **Email address** and pick a **Role**.
3. Click **Send invitation**.

Each new org has three roles: **admin** (every permission), **member** and **viewer**. The **member** and **viewer** roles cover only the shared workspace (messages, contacts, approvals, files). Access to apps such as Tickets or Mail comes from each app's own roles. See [Set up roles](../admin/roles.md) and [Invite and manage users](../admin/users.md).

## Connect a mailbox

1. Open **Settings** and click **Mail** in the **Apps** group.
2. Click **Connect Gmail** or **Connect IMAP/SMTP**.

Gmail needs a Google OAuth client set up first. See [Mail](../apps/mail.md).

## Create your first agent

1. Click **Agents** in the left bar.
2. Click **New agent** at the top of the agents list. You need the `kernel:agents:admin` scope, which the admin role holds.
3. Fill in **Name**, **Description** (one sentence: what this agent is for) and **Instructions**.
4. Leave **Model** on **Auto**, or pick a model.
5. Click **Save**.

See [Create an agent](../agents/create-an-agent.md) for capabilities, the handle and where the agent runs.

## Test the agent

1. Open **Messages**.
2. Mention the agent by its handle, for example `@support`, and ask a question your knowledge answers.

When an agent proposes a sensitive action, such as sending a reply, it waits for your approval on **Home**. See [Approve what agents do](../agents/approvals.md).

## Next steps

- [Schedule routines](../agents/routines.md)
- [Install the desktop and phone apps](desktop-and-phone.md)
- [Provision from a config file](../provisioning-cli.md)
