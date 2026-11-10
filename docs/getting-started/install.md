---
title: Install Liaison
description: Start a self-hosted Liaison on your machine or server, with your coding agent's setup playbook or with the one-command quickstart.
---

You can install Liaison two ways: let Claude Code or Codex run the setup playbook for you, or run the quickstart script yourself. Both start the same Docker Compose stack.

## What you need

- Docker, Docker Compose v2, `openssl` and `git`.
- A model key from one provider: OpenRouter, Anthropic, OpenAI, Google or Mistral. One OpenRouter key is enough to reach every major model.
- For a server: SSH access, a domain, TLS and an SMTP server.
- A machine with 4 GB of memory or more.

## Set it up with Claude Code or Codex

1. Clone the repository, open the folder in Claude Code or Codex (the app, VS Code or the terminal) and ask "set up Liaison for my company":

   ```bash
   git clone https://github.com/liaison-sh/liaison.git
   ```

2. The agent first asks two things: a trial on this machine or a server, and which features you want (email and Google sign-in, a support inbox, imports from Jira or Freshdesk, Calendar, Drive, Shopify, Facebook and Instagram, Google Ads). It records your answer (`setup.features` in the config), so what it calls left is only what you picked; it states the plan and the time per step, then asks its other questions in one message. Reply with what differs from the defaults:

   | Question | Default |
   |---|---|
   | Company name and one line about what it does | |
   | Website to crawl | none |
   | Git repositories with product docs (GitHub or GitLab URLs) | none |
   | Other documents: folders, PDFs, a Drive or Notion export | none |
   | People: name, email, role (`admin`, `member`, `viewer`) | you, as admin |
   | Support mail: none, an IMAP mailbox or Gmail | none |
   | Model provider and key | |
   | On a server: its SSH address and the domain | |
   | Show a guided tour of each part as it is set up | no |
   | Register this server with the Liaison team, and allow bug reports to be sent to it (two questions) | no, no |

3. Paste your keys into `deploy/.setup-secrets.env` in an editor. The file has mode 600 and is never committed. Avoid pasting keys into the chat.
4. While you answer, the agent starts the stack, crawls your website (at most 150 pages by default) and collects the docs from your repositories. It shows you a count of what it gathered and asks before loading it.
5. It creates your org, admin, members, model keys and a support agent with `liaison config apply`, then loads the knowledge.
6. On a server, it runs `liaison guide server` and walks you through the server's own setup: the domain, the mail sender's records, Sign in with Google, push and backups.
7. Sign in when it asks (see [Sign in the first time](#sign-in-the-first-time)). Then it sets up the features you picked, one at a time and one step per message: each message asks you for one thing, says how long it takes, and says you can skip it and come back any time. The basics come first: the mail sender, Google sign-in and Gmail, the support inbox, then imports (Freshdesk with `liaison tickets import --freshdesk-xml`, Jira through the in-app agent's Jira import, any other tool as canonical NDJSON). After the basics it invites you to explore the app and offers the other connectors as a menu with their times; come back to your coding agent or the in-app setup agent whenever you want more.
   - **Google.** One Web client serves Sign in with Google and every Google connection, with both redirect URIs (`/api/auth/oauth/callback` and `/api/connections/callback`). The agent asks what the consent screen's Audience page shows (a screenshot is fine): Internal, for a project of your own Google Workspace, needs no Trusted mark and no Google review. When Google offers **Download JSON**, give the agent the file's path: it reads the client ID and secret itself. It enables only the APIs of the feature being set up, with links that open in your project (`liaison guide google --feature <app> --project <id>`). For Gmail it runs `liaison guide google --email <address>` and follows the path it gives: connect directly, have the Google Workspace administrator mark an External client as Trusted (it asks first whether you are one, and if not gives you a message to forward), connect a personal Gmail address over IMAP with an app password (read, star, archive and trash sync both ways, Sent mail is imported, new mail arrives every 2 minutes), or create a Google OAuth client. For Google Drive with a personal Google account it gives you the link to the Drive page in Settings, where you choose the files Liaison can see.
   - **Personal or shared.** For each mailbox and calendar it asks whether it is yours or a shared team one: a named person's address is their own connection, a role address such as `support@` is the organization's. For another person's own mailbox it runs `liaison connect mail/gmail --for <their email>`, which prints a one-time link for them: it works once, for 30 minutes, only when they are signed in as themselves, and they pick a standard (transparent) or private mailbox there. It says the trade-off in one sentence each: standard mailboxes are read server-side and routines run unattended; routines and agents can't read private mail while its owner is offline, so those runs wait for them (Run now). Something connected the wrong way it removes with `liaison disconnect <app>/<connection> <account>` and connects again; it never sends you through Settings for either.
   - **Shopify.** With `liaison guide shopify --cli`, the agent writes the `shopify.app.toml`, you run `shopify auth login` and `shopify app config link` in your own terminal (it says what to pick), and it deploys and reads the client back itself. The file uses Shopify-managed installation: a store gets exactly the scopes it lists. The agent turns on full order history first, so the file lists `read_all_orders` from the start; if `shopify app deploy` refuses it (an app that Shopify has not yet approved for it), the agent turns it off, deploys again and requests access. Adding a scope later is the same: the file again, `shopify app deploy`, then reconnect. `liaison guide shopify` gives the Shopify Dev Dashboard steps instead. Logins of other tools are always yours to run: the agent never types into them.
8. It asks the support agent a question from your knowledge with `liaison agent ask` (in a fresh conversation each time, so a second try is not answered from the first), then reports what is done, what is pending (including your answer on sharing with the Liaison team) and how long each step took.

The sharing question is asked once, with the exact fields: a random server id, the Liaison version, the edition and the number of active users, and nothing else. Bug reports are only ever sent when you tick the box on a report. Both answers can be changed in **Settings > System** (see [Share with the Liaison team](../self-hosting/liaison-team.md)).

Every step is safe to run twice. If one fails, fix the cause and the agent reruns that step.

### How long it takes

There are two paths. The quick one takes about 9 minutes for a trial on your own machine (your knowledge and agents, no mailbox yet, so nobody else can sign in), measured on a Mac mini (Apple silicon):

| Step | Who | Time |
|---|---|---|
| Answer the questions | you | 5 min |
| Start Liaison (while you answer) | agent | 65 to 72 s; 2 min 19 s the first time, when the image is built locally |
| Gather knowledge | agent | 13 s for a 2-page site and one repo; about 1 min per 100 pages |
| Check what was gathered | you | 2 min |
| Create the org, admin, agents, load knowledge | agent | 5 s for 60 documents |
| Sign in | you | 1 min |
| Test an agent on your knowledge | agent | 10 s |
| Report | agent | 1 min |

The basic onboarding takes about 15 minutes for the basic onboarding on a server (the mail sender, Google sign-in, your team, the support inbox and your company knowledge). The full onboarding takes up to about 2 hours of your own time for a full onboarding on a server with every connector: the server (`liaison guide server`: domain and https, the mail sender and its SPF, DKIM and DMARC records, Sign in with Google, push, backups) and every connection (`liaison guide <app>/<connection>`). Each step is marked **HUMAN** (a console or a browser, given to you word for word with its page and the values to paste) or **AGENT** (the agent runs it), and `liaison setup state` shows what is left and its time. Some providers add waits of their own, such as Meta's App Review. The [setup reference](../reference/setup.md) lists every step and its time.

## Start it yourself with the quickstart

1. Run:

   ```bash
   git clone https://github.com/liaison-sh/liaison.git
   cd liaison
   ./deploy/quickstart.sh
   ```

   The script writes `deploy/.env` with fresh secrets (it never overwrites an existing one), pulls the published image or builds it locally, starts Postgres, Redis, MeiliSearch, the SeaweedFS object store and the app, and waits until `/healthz` reports every dependency healthy.
2. Open the URL it prints and choose **Create an account**. Enter your name, your email and the one-time setup token the script prints (it is also in `docker compose logs app`). This first registration creates your org and signs you in.
3. On a remote server, the app listens on the server's loopback only, so that URL does not reach it from your computer. To try it without a domain, open a tunnel from your computer and use the same URL in your browser: `ssh -N -L 3000:127.0.0.1:3000 <user>@<server>`. For a domain and https, follow the [production runbook](../runbooks/production-bootstrap.md).

Run `./deploy/quickstart.sh --help` for the other flags: `--port`, `--pull`, `--build` and `--project`. If port 3000 is taken, use `--port 3100`.

To create the org from a config file instead of registering by hand, see [Provision from a config file](../provisioning-cli.md).

## Sign in the first time

Sign-in is passwordless: you enter your email and receive a code or a magic link. On a local trial with no SMTP server, the quickstart's `deploy/.env` sets `LIAISON_CONSOLE_EMAIL_BODIES=true`, so codes and invite links are written to the app log instead. Read the latest code with:

```bash
docker compose -p liaison -f deploy/docker-compose.yml logs --since 10m app | grep 'sign-in code' | tail -1
```

When the first administrator signs in to a new workspace, their agent's conversation starts with a pinned **Set up your space** card: what is set up, what is left, and a link to the demo. Open it with **Chats** at the bottom right, then **Personal agent**. It asks for a model key first, then the agent walks you through what is left. Demo workspaces never show it.

Before anyone else signs in, set the `SMTP_*` variables in `deploy/.env` and remove `LIAISON_CONSOLE_EMAIL_BODIES`. See [Run Liaison with Docker](../self-hosting/docker.md).

## Try it with a sample company

To look around before you load your own data, fill a separate workspace with a fictional company, Resonant Audio Labs: ten people and two weeks of work up to now (team conversations, chats with agents, tickets, routine runs, notifications). Your own org is not touched.

```bash
SAMPLE_PASSWORD='<a password>' docker compose -p liaison -f deploy/docker-compose.yml \
  exec -e SAMPLE_PASSWORD app liaison seed --tier lively --slug sample --passwords-env SAMPLE_PASSWORD
```

Sign in as its founder, `elodie@sample.resonantaudiolabs.example`, with **Sign in with a password** and that password; the other nine people have the same password. Run the command again with `--replace` to start the two weeks from now again. Every flag is in [Provision from a config file](../provisioning-cli.md).

## Stop and restart

- `./deploy/quickstart.sh --down` stops the stack and keeps your data.
- `./deploy/quickstart.sh` starts it again.
- `docker compose -p liaison -f deploy/docker-compose.yml down -v` removes the data permanently.

## Move a trial to a server

When you want the trial on a server, `deploy/move.sh` moves the whole instance: data, members, connected accounts and their keys.

1. Prepare the server: Docker, a checkout of this release or newer, its own `deploy/.env` (SMTP, `BASE_URL`), TLS and DNS, as in the [production runbook](../runbooks/production-bootstrap.md). Do not register on it.
2. Check that `ssh <user>@<server> true` works without a password prompt.
3. From your trial checkout, run:

   ```bash
   ./deploy/move.sh <user>@<server> --base-url https://liaison.resonantaudiolabs.example
   ```

   It stops the local app, takes a backup, copies it to the server, restores it there and prints the checks. Use `--remote-dir <path>` when the server's checkout is not `~/liaison`.
4. Update DNS, the redirect URI in each OAuth client and the webhooks that external services call. Leave the trial stopped: two running instances would sync the same mailboxes.

Then schedule backups on the server: see [Back up and restore](../admin/backups.md).

## Next steps

- [Set up your organization](first-org.md)
- [Install the desktop and phone apps](desktop-and-phone.md)
- [Run Liaison with Docker](../self-hosting/docker.md)
