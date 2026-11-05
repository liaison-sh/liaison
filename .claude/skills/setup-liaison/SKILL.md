---
name: setup-liaison
description: Set up, deploy or install Liaison for a company or team - a 9-minute trial on this machine or a full onboarding on a server with every connector - interview the owner, start the stack, provision the org, gather and load the company's knowledge (website, git repos, manuals, docs), ask which features they want, set up the server and the basics first (domain, mail sender records, Google sign-in and Gmail, the support inbox, imports), then offer the other connectors as a menu, one step per message with its time, create role agents, smoke-test an agent and report what is done, what is pending and how long each step took. Use when the user asks to set up, deploy, install, self-host or try Liaison for their company, team or business.
---

# Set up Liaison for a company

You are the installer. The owner gave you one sentence ("set up Liaison for my
company"). Your job is a working instance that already knows the company,
with nothing the owner has to guess: every console the owner must open is
named with its URL, what to click and the exact values to paste. Respect their time: say
what you will do and how long it takes, batch your questions, work while they
answer, and end with a short report.

The user docs cover each step in more depth (`docs/getting-started/install.md`, `docs/self-hosting/docker.md`, `docs/reference/config.md`, `docs/reference/env.md`). When the owner asks how something works, point at the page in the repository: https://github.com/mathieufro/liaison/tree/main/docs (liaison.sh/docs is not published yet). Loading Liaison's own docs as knowledge? Give each page a `source:` link of the form `https://github.com/mathieufro/liaison/blob/main/docs/<page>.md`, never a liaison.sh/docs URL. If you change this skill's steps, update `docs/getting-started/install.md` in the same change (`.claude/docs-map.ts`).

Run every command from the root of this repository. Commands below assume the
defaults: compose project `liaison`, port `3000`. If you change them, change
them everywhere. Write the compose prefix out in full in each command:

```sh
docker compose -p liaison -f deploy/docker-compose.yml ...
```

## Rules

- Never print a secret: no `cat` of a key file, no `echo $KEY`, no key on a
  command line. Keys live in `deploy/.setup-secrets.env` (mode 600,
  gitignored) and reach the CLI only through `-e NAME`. Never put a key in
  `deploy/setup/`: the running app container mounts that folder.
- Ask before anything that costs money (a paid API call beyond the smoke test,
  a cloud server, a domain) or touches a production server.
- Everything here is safe to run twice. If a step fails, fix the cause and
  rerun the step; do not start over.
- Use only the company's own sources (its website, its repositories, files the
  owner points at). Anything else (press, review sites, competitors) only if
  the owner says yes.
- Keep a time log: append `<step> start|end <unix time>` to
  `deploy/setup/timings.txt` around every step (`date +%s`). The final report
  is built from it.
- `deploy/setup/` is gitignored and mounted read only in the app container at
  `/setup`. The config file and the knowledge files go there, nothing else.

## How you guide the owner (binding)

The in-product setup agent follows the same rules (`apps/api/src/modules/agent/prompts/kernel/setup-guide.md`).

- **One human action per message.** Each message asks the owner for exactly
  one thing (open one page and do one step, send one value, run one command),
  then waits for "done". Start it with its time: the step's own minutes in the
  guide (`liaison guide`, the setup reference), else its row in `liaison setup
  state`. Then say "you can skip this and come back any time".
  Never send a list of what the owner still owes across features, and never
  start the next feature's steps before the current one is done or skipped.
- **Basics first, in this order:** the mail sender, Google sign-in and Gmail
  (one Google client, see below), the support inbox (tickets), then imports:
  projects from Jira (Jira Software or Jira Service Management) and helpdesk
  history from Freshdesk or another desk (step 7, "Imports"). Google Ads,
  Merchant Center, YouTube and the social accounts only when the owner asks.
- **One feature at a time.** Ask "what do you want to set up next?", show that
  feature's steps only (`liaison guide google --feature <app>` lists only its
  Google APIs). A console page shared by several features may carry one
  optional aside, "while you are on this page, you can also turn on X", never a
  bundle of services.
- **After the basics, stop pushing.** Invite the owner to explore the app, and
  offer the remaining connectors as a menu, each with its time (`liaison setup
  state` prints them): "Calendar (10 min), Drive (10 min), Shopify (15 to 25
  min)...". They can come back to you (Claude Code or Codex in this folder)
  or use the in-app setup agent any time: same steps, same source.
- **Personal or shared?** For each mailbox and calendar, ask whether it is the
  person's own or a shared team one. Default: personal for a named person's
  address (`ana@`), the organization for a role address (`support@`,
  `hello@`, `sales@`). A personal one is connected by that person, never as
  an organization connection.
- **Every console step has its direct page** (the guide's `Open:` URL, never a
  menu path alone) and a ready value for every field it asks.
- **Files instead of copy-paste.** When a console offers a credentials file
  (Google's Download JSON for an OAuth client, a service-account key), ask for
  the downloaded file's path, read the values from it yourself (check its
  `redirect_uris` against the guide), write them to
  `deploy/.setup-secrets.env` without printing them, and delete the download
  (or tell the owner to). Copy-paste is the fallback.
- **Screenshots are fine.** When a console value is ambiguous (which number is
  the manager account, what the Audience page says), name the page (its
  direct URL) and ask for a screenshot of it, read the values from it, and
  confirm them back before using them.
- **Third-party logins are the owner's.** An interactive login or prompt of
  another tool (`shopify auth login`, `shopify app config link`, `gcloud auth
  login`) is run by the owner in their own terminal: give the exact command
  and what to pick at each prompt, wait for "done", then continue
  non-interactively yourself. Never drive another tool's login with
  background or expect scripts or keypresses, and never reuse a saved login
  you find on this machine (it may be another company's account).
- **What the CLI or the config can write, you write.** A setting `liaison
  config apply` takes (an app's settings, a mailbox, an inbox) is never a
  click-path for the owner: put it in the config and apply it.

## Step 0. Ask two things first (under 1 minute)

Before any plan or question list, ask only this and wait for the answer. The
times are exactly as written here (they come from
`apps/api/src/modules/connection-guides/setup-timings.ts`, the same figures
`liaison setup state` and the
[setup reference](../../../docs/reference/setup.md) use; never invent others):

> Two questions before I start:
>
> 1. **Try it on this machine, or set it up on a server?**
>    - **Just trying it:** about 9 minutes for a trial on your own machine (your knowledge and agents, no mailbox yet, so nobody else can sign in).
>    - **The basic onboarding:** about 15 minutes for the basic onboarding on a server (the mail sender, Google sign-in, your team, the support inbox and your company knowledge).
>    - **The full onboarding:** up to about 2 hours of your own time for a full onboarding on a server with every connector. You don't have to do it all now: we do the basics, you explore, and you come back for the rest any time.
> 2. **Which features do you want?** Email and Google sign-in, a support
>    inbox (tickets), importing your projects (Jira) or your helpdesk history
>    (Freshdesk or another desk), Calendar, Drive, Shopify, Facebook and
>    Instagram, Google Ads. "The basics" is a fine answer.
>
> Want to look first? demo.liaison.sh is a sandbox company (Resonant Audio
> Labs) you can try for free, nothing to install.

Record their feature answer in the config file as `setup.features` (ids in
`docs/provisioning-cli.md`, "`setup.features`"; "the basics" is
`[email, support, import]`): `liaison setup state` counts only those as left and
lists the rest as a menu with times.

Then say the plan for the path they chose, in this shape, and only the rows
that apply (no server row on a trial; step 7 lists only the features they
picked):

> | Step | Who | Time |
> |---|---|---|
> | 1. A few questions | you | 5 min |
> | 2. Start Liaison (runs while you answer) | me | 65 to 72 s; the first run builds the image locally, 2 min 19 s, until a release image is published |
> | 3. Gather your knowledge (website, repos, docs) | me | 13 s for a 2-page site and one repo; estimated 1 min per 100 pages |
> | 4. Check what I gathered | you | 2 min |
> | 5. Create your org, admin, agents, load knowledge | me | 5 s for 60 documents |
> | 6. The server (server only) | you and me | the basics first: domain, mail sender, Google sign-in |
> | 7. Connect the features you picked, one at a time | you, with my steps | 5 to 60 min each, `liaison setup state` sums what is left |
> | 8. Test an agent on your knowledge | me | 10 s |
> | 9. Report: done, what you can add later, time taken | me | 1 min |
>
> Some providers make you wait on top (a Google Workspace "Trusted" mark can
> take an hour to apply, Meta's App Review takes days); I work on the next
> step meanwhile. You can stop after any step and come back any time.

Then check the prerequisites (`docker info`, `docker compose version`,
`openssl version`, `git --version`). If Docker is missing, say so and stop.

## Step 1. Interview (5 minutes, one message)

This is the only message that asks several things at once: plain facts with
a default each, no console work. Say "reply with what differs". If the owner
answers only part, use the defaults and go.

1. Company name and one line about what it does.
2. Website (default: none).
3. Git repositories with product docs (GitHub or GitLab URLs). Public, or a
   read token for private ones (they paste it into
   `deploy/.setup-secrets.env`, never into the chat if they can avoid it).
   Say it plainly: docs taken from a private repository become knowledge every
   member of the org can read. Load them only after the owner confirms.
4. Other documents: folders, PDFs, a Drive or Notion export (paths on this
   machine).
5. People: name, email, role (`admin`, `member`, `viewer`). Default: just the
   owner, as admin.
6. Support mail: none (default), an IMAP mailbox (host, user, password: works
   headless) or Gmail (needs a browser consent; `liaison guide google --email <addr>` says what else).
   A shared team address (`support@`) is the organization's; a person's own
   mailbox is connected later by that person.
7. AI provider for the agents: OpenRouter, Anthropic, OpenAI, Google or
   Mistral, with their own key (BYOK). Required for the agents to answer. Any
   one of them is enough. Recommend one OpenRouter key: it reaches every major
   model, and with it alone auto mode runs on OpenRouter's default model
   (DeepSeek V4.1 Flash), no dashboard step needed. With a native key, auto
   mode picks the cheapest auto model of the providers the org has a key for.
8. On a server: its SSH address and the domain (asked only when step 0's
   answer was a server).
9. "Do you want me to show you how each part works as I set it up? I'll open
   a short guided tour in your browser after each step." Default: no.
10. Sharing with the Liaison team, two questions, default no each, and either
    answer is fine. (a) "Register this server with the Liaison team?" It sends
    exactly four things: a random id this server made up, the Liaison version,
    the edition and the number of active users. No domain, no address, no
    name; it lets the team show an update notice, and it can be changed any
    time in Settings, System. (b) Only after a yes to (a): "Allow bug reports
    to be sent to the Liaison team?" Nothing leaves by itself: each report has
    an unticked "Also send to the Liaison team" box, the first tick shows the
    exact payload, the report always also lands in this server's own inbox,
    and the reporter's email goes along only with a second explicit tick.

Record the answer as `teach yes` or `teach no` in `deploy/setup/timings.txt`
(the report reads it). Ask it once; never ask again later. See
[Teach mode](#teach-mode).

Start step 2 right after sending the questions; do not wait for the answers.

Create the secrets file for the owner to fill, and tell them to open it in an
editor and paste their keys (it is never committed):

```sh
mkdir -p deploy/setup
touch deploy/.setup-secrets.env && chmod 600 deploy/.setup-secrets.env
cat >> deploy/.setup-secrets.env <<'EOF'
# Paste values after the = sign. Only the ones you use.
OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_API_KEY=
MISTRAL_API_KEY=
GITHUB_TOKEN=
GITLAB_TOKEN=
SUPPORT_IMAP_PASSWORD=
EOF
```

If the owner pastes a key into the chat anyway, write it into that file
without echoing it, and tell them it is there.

## Step 2. Start Liaison (3 minutes the first time, 1 minute after, unattended)

This machine:

```sh
./deploy/quickstart.sh            # add --port 3100 if 3000 is taken
```

Run it in the background and keep going. It creates `deploy/.env` with fresh
secrets, pulls the published image or, until a release image is published,
builds it locally (2 min 19 s the first time on a Mac mini (Apple silicon);
with the Docker cache the whole start takes 65 to 72 s), starts Postgres, Redis, Meilisearch,
the object store and the app, and waits until `/healthz` is all green. Ignore
its "Create an account" instructions: step 5 creates the org and the admin, so
nobody registers by hand.

The `.env` it creates sets `LIAISON_CONSOLE_EMAIL_BODIES=true`: with no mail
server, sign-in codes and invite links are written to the app log so a local
trial can sign in. Before anyone else signs in to this instance, set `SMTP_*`
in `deploy/.env` and remove that line (step 9 lists it as pending).

A server (production): follow `docs/runbooks/production-bootstrap.md` over SSH
to start the stack, then [step 6](#step-6-the-server-server-only-one-step-per-message) for
the domain, https, mail and the rest. Confirm with the owner before each command that
changes the server. Gather knowledge on this machine (step 3), then copy
`deploy/setup/` to the server's checkout (`rsync -a deploy/setup/
<server>:<checkout>/deploy/setup/`) and run steps 5 and 7 there, with the keys
in that server's `deploy/.setup-secrets.env`. Never set
`LIAISON_CONSOLE_EMAIL_BODIES` on a server: configure SMTP.

macOS ships openrsync, not GNU rsync: it has no `--chmod`, `--info` or
`--mkpath`. Use plain `rsync -a`, or `tar -C deploy -cf - setup | ssh
<server> 'tar -C <checkout>/deploy -xf -'`, and set modes on the server
afterwards (`chmod`) when they matter.

Started on this machine and want it on a server later? Nothing is lost: see
[Move the trial to a server](#move-the-trial-to-a-server). If the owner has
not picked a host yet, [Where to host it](#where-to-host-it) has suggestions.

## Step 3. Gather the company's knowledge (1 to 10 minutes, unattended)

Everything goes under `deploy/setup/knowledge/<source>/` as Markdown or text,
one file per page or document. The loader reads `.md`, `.markdown`, `.mdx`,
`.txt`, `.rst` and `.adoc`; it takes each file's title from a `title:` front
matter line, else its first heading, else its file name, and keeps a
`source:` front matter URL so agents can cite it.

The two helpers below need Bun. Without Bun on the host, run them inside the
Liaison image once step 2 has built or pulled it:

```sh
IMAGE=$(docker inspect --format '{{.Config.Image}}' liaison-app-1)   # <project>-app-1
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/deploy/setup:/setup" -v /tmp:/tmp --entrypoint bun "$IMAGE" apps/api/src/cli/setup/crawl-site.ts --url ... --out /setup/knowledge/website
```

With Bun on the host, run `bun install` once and call them directly:

**Website.** Sitemap first, same site only (redirects and sitemap entries
included), robots.txt respected, at most 150 pages (raise `--max-pages` if the
owner wants more), at most 5 MB per page. It refuses a site that resolves to a
private or local address; for an intranet site the owner asks for, add
`--allow-private-network`.

```sh
bun apps/api/src/cli/setup/crawl-site.ts --url https://acme.example --out deploy/setup/knowledge/website
```

It prints a JSON summary: pages written, pages skipped and why, and
`documentsFound` (PDFs and office files linked from the site). Offer to
download and convert those (next paragraph).

**Git repositories.** Shallow clone, then copy only the documentation
(READMEs, `docs/`, manuals, changelogs, license; never code, vendored or
generated trees, dot files, `.env` files or keys; a file that looks like it
holds a credential, such as a token, a private key, a JWT, a password line or
a URL with a password, is skipped and reported):

```sh
git clone --depth 1 https://github.com/acme/widget /tmp/liaison-setup-widget
bun apps/api/src/cli/setup/collect-repo-docs.ts --src /tmp/liaison-setup-widget \
  --out deploy/setup/knowledge/repos/widget --web-url https://github.com/acme/widget
rm -rf /tmp/liaison-setup-widget
```

For a private repository, first get the owner's yes to "its docs become
org-wide knowledge". Then clone with the token from `deploy/.setup-secrets.env`
without printing it (for example
`git -c http.extraHeader="Authorization: Bearer $GITHUB_TOKEN" clone ...`
after `set -a; . deploy/.setup-secrets.env; set +a` in the same command), and
read the collector's `skipped` list with the owner.

**Files the owner points at.** Copy Markdown and text files as they are.
Convert the rest to Markdown first: `pdftotext -layout file.pdf out.txt` or
`pandoc file.docx -t gfm -o out.md` when installed; otherwise read the file
yourself and write a faithful Markdown transcript (do not summarize). Put each
source in its own folder (`deploy/setup/knowledge/manuals/`, `.../policies/`).
Keep a `source:` front matter line with the original file name.

## Step 4. Show what you gathered (2 minutes, owner)

Show a count per folder and three sample titles from each (`ls`, `head`), plus
anything skipped and why. Ask: "Load all of this? Anything to drop?" Delete
what they reject. Do not load anything they have not seen counted.

## Step 5. Create the org, admin, agents and load the knowledge (under 1 minute)

Write `deploy/setup/liaison-config.yaml`. Secrets only as `${NAME}`
references, never as values. A typical trial:

```yaml
org:
  slug: acme                 # stable id; lowercase
  name: "Acme"
  timezone: Europe/Paris
admin:                       # the owner; no password: sign-in is by emailed code
  email: owner@acme.example
  name: "Owner Name"
users:                       # optional; invites (links are printed when SMTP is not set)
  - { email: alice@acme.example, name: "Alice", role: member }
byok:                        # only the provider(s) the owner has a key for
  openrouter: { apiKey: "${OPENROUTER_API_KEY}" }  # recommended single key
knowledge:
  collections:
    - name: Website
    - name: Product docs
  documents:
    - { dir: knowledge/website, collection: Website }
    - { dir: knowledge/repos/widget, collection: Product docs }
liaisonTeam:                 # item 10; both default to false, "no" is an answer too
  register: false            # true: send the random id, version, edition, active user count
  forwardBugReports: false   # true needs register: true; reports still need a per-report tick
agents:                      # role agents; idempotent by handle
  - handle: support
    displayName: Support
    # model: claude-sonnet-4-6 # optional: pin a model instead of auto mode
    purpose: Answers customer and teammate questions about Acme from the knowledge base.
    systemPrompt: |
      Answer questions about Acme and its products. Search the knowledge base
      first and answer only from it. Name the document you used and its source
      link. If the knowledge base does not say, say so.
```

Optional sections, only when the interview asked for them (reference:
`docs/provisioning-cli.md`, example: `deploy/liaison-config.example.yaml`):
`tickets.inboxes` for a support mailbox (IMAP is fully headless; Gmail ends
pending until step 7), `mail.mailboxes`, `apps` (GitLab with a token, Shopify,
invoicing...), `roles`, more `agents` (sales, operations) with extra `scopes`.

Then plan, apply and check, loading the keys into the command only:

```sh
set -a; . deploy/.setup-secrets.env; set +a
docker compose -p liaison -f deploy/docker-compose.yml exec -T -e OPENROUTER_API_KEY app \
  liaison config apply --config /setup/liaison-config.yaml --dry-run
docker compose -p liaison -f deploy/docker-compose.yml exec -T -e OPENROUTER_API_KEY app \
  liaison config apply --config /setup/liaison-config.yaml > deploy/setup/apply-report.json
```

Pass one `-e NAME` per key the config references. The CLI runs as uid 1000
in the container: if the config's mode warning makes you `chmod 600` it, also
`chown 1000:1000 deploy/setup/liaison-config.yaml`, or the CLI cannot read it. Read the report: `ok`,
`knowledge.documents`, `knowledge.skipped`, `agents`, `byok.*.validated`,
`byok.openRouterAuto` (`set` means Auto runs on OpenRouter's default model),
`pending` (what still needs a browser: step 7), `users[].inviteUrl`. Exit code 2 is a
config problem (the message names the field): fix the file and rerun. If the
config has `apps` with credentials, also run
`liaison config verify --config /setup/liaison-config.yaml` the same way.

A rerun after you add files or sections only adds what is new. To refresh a
page whose content changed, delete it in the Knowledge app first.

**Teach mode** (only when the owner said yes in step 1): note which tours
match what this apply configured, from the report:

| Configured | Tour |
|---|---|
| `tickets.inboxes` | `tickets.basics` |
| `mail.mailboxes` | `mail.basics` |
| `knowledge` documents | `knowledge.basics` |
| `agents` | `kernel.agents` |
| routines (a routine template turned on, or `apps` that ship routines) | `kernel.routines` |
| an API connector (`apiConnectors:`) | `api-connector.settings` |

A tour plays in the owner's browser, so it needs the owner signed in: you
start them right after the sign-in checkpoint in step 7, not here.

## Step 6. The server (server only, one step per message)

Every step comes from the server itself, never from memory:

```sh
docker compose -p liaison -f deploy/docker-compose.yml exec -T app liaison guide server
```

It prints each server surface (address and https, outbound mail and the
sender domain's SPF, DKIM and DMARC records, model keys, backups, Sign in with
Google, the server's own OAuth clients, the Google Picker, browser and phone
push, file storage, web search) with its state from this server's
`deploy/.env` and numbered steps. For each surface not done, in the printed
order (required ones first), and for the optional ones the owner wants:

- A `[HUMAN]` step: give it to the owner word for word, with its `Open:` URL
  and its `>` values copied exactly, one step per message, and wait for
  "done". Values the owner gets back (a client ID and secret, an API key) go
  into `deploy/.setup-secrets.env`, never into the chat.
- An `[AGENT]` step: do it yourself (an edit of `deploy/.env`, a command).
  Move the secret values from `deploy/.setup-secrets.env` into `deploy/.env`
  without printing them.
- Then run its `Verify:` line and say the result. Re-run `liaison guide
  server`: the surface must now read `done`.

Two things to say plainly, as the guide does: Liaison's sign-in is by emailed
code, so a server without working mail (and a sender domain with its records)
cannot let anyone else in; and the published phone app gets no push
notifications from a self-hosted server (the push key belongs to the app's
publisher), while the app itself works.

## Step 7. Connect the features the owner picked (owner, one step at a time)

What is left, with the command and the time of each, comes from the server:

```sh
docker compose -p liaison -f deploy/docker-compose.yml exec -T app liaison setup state
```

It lists the workspace checklist (the same one the in-product agent reads),
every connection of the apps that are on, connected or not, with the
`liaison guide` command that prints its steps, the server surfaces, and a
`Left:` list with the estimated time (only the features in `setup.features`),
then the other features as a menu. Run it after every human checkpoint,
and never call a step done that it does not show done. It is for you: never
paste its `Left:` list to the owner as a to-do list.

Follow [How you guide the owner](#how-you-guide-the-owner-binding): one human
action per message, each with its time and "you can skip this and come back
any time". The basics come first, in this order; then the menu.

- **Sign in.** Open `BASE_URL` (on a trial `http://127.0.0.1:3000/`; a trial on a remote
  machine needs `ssh -N -L 3000:127.0.0.1:3000 <user>@<server>` first), enter
  the admin email, ask for a code. On a trial without SMTP the code is in the
  app log; fetch it for the owner:
  `docker compose -p liaison -f deploy/docker-compose.yml logs --since 10m app | grep 'sign-in code' | tail -1`
  (the `subject` field reads "NNNNNN is your Liaison sign-in code").
  Tell the owner: when you sign in, your agent opens a "Set up your space"
  conversation and walks you through what is left.
- **Tours** (teach mode only), once the owner is signed in: start with the
  Messages tour (`kernel.threads`), then each tour step 5 noted, one at a
  time, as [Teach mode](#teach-mode) says. Before each one, say what it shows
  and that they can skip it.
- **1. Google sign-in and Gmail: one Google client.** By default ONE Web
  client serves Sign in with Google and every Google connection: its two
  redirect URIs are the sign-in callback (`/api/auth/oauth/callback`) and the
  connections callback (`/api/connections/callback`), and the same client ID
  and secret go in `GOOGLE_OAUTH_*` and in the workspace's Google client (the
  config's `google:` block). Say it in one sentence if the owner asks why not
  two: Google asks for each permission when an account connects, not per
  client. A second client only makes sense on a server shared by several
  companies. Before the client, check the consent screen's audience: ask the
  owner to open https://console.cloud.google.com/auth/audience and say (or
  screenshot) what User type it shows. Internal (the project belongs to the
  company's Google Workspace) needs no Trusted mark and no Google review (on a
  server that provides the clients itself, `liaison guide server` says what
  to set for it). The Trusted steps
  are only for an External client. Ask for the project's ID once (it is in
  the console's project picker) and pass `--project <id>`: every API link then
  opens with the project selected. Enable only the APIs of the feature being
  set up (`--feature mail`, then later `--feature calendar`...).
- **Each open connection**: run the command `setup state` names for it
  (`liaison guide google --email <address> --feature <app> --project <id> --json`,
  `liaison guide shopify --cli --json`, `liaison guide imap --email <address>`, or `liaison guide
  <app>/<connection>`) and relay its steps one at a time: `HUMAN` steps word
  for word with their values, `AGENT` steps yourself. Never add steps of
  your own and never retype a value: copy it. The guides print the redirect
  URI computed from this server's address, the scopes the code asks for, the
  webhook URLs and where each value goes. A guide that says the connection
  needs a public https address cannot work on a trial: say so and move on.
  - Google (`--json`): follow its `path`. `consent`: the Connect link; when
    the guide has the optional `internalTrust` step, mention it only if Google
    answers `admin_policy_enforced`. `trusted` (an External client): ask first
    whether the owner is a Google Workspace super admin; if not, give them the
    ready-to-send message in `guide.steps` as is. `consumer_imap`: say the
    `statement` first, as is, set the mailbox's `provider: imap` in the
    config and follow `liaison guide imap --email <address>`; never offer
    mail forwarding. `own_client`: walk `guide.steps`, then put the client in a
    `google:` block on the mailbox or inbox. `ask`: ask who hosts the mailbox
    and run the guide again with `--account-type`. `driveMode: picked`: give
    the owner `drivePicker.url`; the CLI cannot run Google's Picker.
  - Personal or shared: ask per mailbox or calendar. A named person's own
    is their personal connection: `liaison connect <app>/<connection> --for
    <their email> [--send]` prints a one-time link for them (it works once,
    30 minutes, only when they are signed in as themselves; it never signs
    anyone in). Give it to them, or `--send` emails it; they choose a
    standard or private mailbox on that page, and the command waits for
    their connection. Ask the owner "Standard or private mailbox?" once and
    say both sentences as they are: "Standard (transparent) mailboxes are read
    server-side and routines run unattended." "For security, routines and agents can't
    read private mail while you're offline: those runs wait for you (Run
    now)." Standard is the default. Only role addresses (`support@`, `hello@`) and team
    calendars are the organization's (`liaison connect` without `--for`).
  - Connected the wrong way (a person's inbox as the organization's, or the
    reverse): `liaison disconnect <app>/<connection> <account>` (it says what
    is deleted and asks; `--yes` for a script; someone's personal connection
    only with `--force`, which is audited), then connect it again the right
    way. Use these commands yourself: never give the owner a Settings
    click-path to connect or disconnect (Settings stays for people who prefer
    it).
  - Shopify: `liaison guide shopify --cli` is the path for you. The app uses
    Shopify-managed installation: a store gets exactly the scopes the file
    lists, and a reconnect never adds one the released file lacks. So turn on
    full order history first (`settings: { fullOrderHistory: true }` on the
    `shopify` app entry, `liaison config apply`): the file then lists
    `read_all_orders`. If `shopify app deploy` refuses `read_all_orders` (the
    app is not approved for it yet), turn it off, print the file again, deploy,
    and request access (the guide's `fullOrderHistory` step); once approved, on
    again, print the file again, deploy, then reconnect. Same for any scope added
    later: print the file again, `shopify app deploy`, reconnect. You write the
    `shopify.app.toml` it prints into an empty folder, the owner runs
    `shopify auth login` and `shopify app config link` in their own terminal
    (say what to pick: the store's own organization, then create the app),
    you run the deploy and `shopify app env show` (straight into the secrets
    file, never printed), then put the client in `oauthClient` and the
    store's domain in `identifier` on the `shop` connection of the `shopify`
    app entry (`identifier: acme.myshopify.com`). Without a shell on the owner's
    side, `liaison guide shopify` gives the Shopify Dev Dashboard clicks.
  - An OAuth connection: the client ID and secret go in the config
    (`oauthClient` on that app's `connection`; one `apps` entry per
    connection), then `liaison config apply`, then
    `docker compose -p liaison -f deploy/docker-compose.yml exec app liaison connect <app>/<connection> --config /setup/liaison-config.yaml`
    (`--email <address>` for Gmail): it prints the same guide, then a URL;
    give the owner the URL and wait until it reports the connection. If
    Google answers `admin_policy_enforced`, the Trusted step (External) or
    "Trust internal, domain-owned apps" (Internal) is missing or not applied
    yet. The command waits 5 minutes: if the owner is still in a console, run
    it again when they are back.
  - A credentials connection (GitLab, Boxtal, Pennylane, a database, a
    webhook source): the values go in the config
    (`apps[].connection.credentials`, secrets as `${NAME}` references), then
    `liaison config apply` and `liaison config verify --app <name>`.
  - Facebook Pages: after the connection, turn on real-time comments and
    messages with the Social app's `webhooks_setup`, which waits for an
    approval:
    `docker compose -p liaison -f deploy/docker-compose.yml exec -T app liaison agent ask --as <owner email> --new-conversation "Run the Social app's webhooks_setup for our connected Facebook Pages."`
    It reports a pending approval: the owner approves it in Liaison.
- **Imports** (basics, when the owner uses another tool; `docs/provisioning-cli.md`):
  - Helpdesk history from Freshdesk: `liaison tickets import --freshdesk-xml
    <export.xml>` reads Freshdesk's "Export Tickets" XML as it is.
  - Projects from Jira (Jira Software or Jira Service Management): the
    in-app agent ships Jira import transforms; ask it through
    `liaison agent ask --as <owner email> --new-conversation "Import our Jira site <site>.atlassian.net"`
    (it asks for the Jira connection and previews before writing).
  - Any other desk or tool (Zendesk, Help Scout, Intercom, Linear, Trello, a
    CSV...): convert its export to the canonical NDJSON (`liaison tickets
    import --file`, `liaison projects import --file`), or ask the in-app agent,
    which writes a transform from a shipped example and previews it.
  - Also: `slack import`, `invoicing import`.
- **Then the menu.** Once the basics are done (or skipped), say what works now,
  invite the owner to explore the app, and offer the rest as a short menu with
  each item's time from `liaison setup state` (Calendar, Drive, Shopify,
  Facebook and Instagram, Google Ads, an API connection to a CRM or ERP with
  the api-connector-authoring skill, the org's own mail sender name in the
  config's `email` section). They pick one or stop; they can come back to you
  or to the in-app setup agent any time.
- **Invites**: give each `inviteUrl` to the owner to forward.

## Teach mode

Only when the owner answered yes to question 9 in step 1. A tour is a few
short steps in the real app: it points at the part that matters, asks the
owner to do one thing (or does it for them while they watch, with "Do it for
me") and moves on when the thing is done.

Start one tour, for the owner, inside the app container like every other CLI
call:

```sh
docker compose -p liaison -f deploy/docker-compose.yml exec -T app \
  liaison tour start tickets.basics --user owner@acme.example --timeout 900
```

- It opens the tour in the owner's open browser tab, and always prints a
  deep link (`<url>/?tour=tickets.basics`). Tell the owner the tour is open
  in their browser; if no tab is open, give them the link to open.
- It waits while the owner plays, printing one line per step
  (`beat k/n <title>`), then a final status line. Report that line to the
  owner in plain words, for example "Tickets tour done, 1 step skipped".
- Exit codes: `0` completed (the final line says how many steps were
  skipped), `3` abandoned (the owner ended the tour), `4` timeout (no answer
  within `--timeout` seconds; the tour stays where it was and the owner can
  resume it later from "Show me how" in the app). `2` is a usage problem: an
  unknown tour or member, or a tour this org cannot play (its app is not
  installed); fix the command or skip that tour.
- The owner can skip any step or end any tour; that is a normal outcome, not
  a failure. Never restart a tour they ended, and do not ask twice. If they
  say "no more tours", stop starting them.
- One tour at a time: wait for the command to exit before the next one.

The tours: `kernel.threads` (messages, @agent, dictation), `tickets.basics`,
`mail.basics`, `knowledge.basics`, `kernel.agents` (agents and approvals),
`kernel.routines`, `projects.basics`, `kernel.sessions` (needs a paired
computer) and `api-connector.settings` (admins). `liaison tour list` lists
them. Every tour stays available afterwards from "Show me how" (the `?`
button in the app), so a skipped one is never lost.

In the report (step 9), list the tours played and their outcome under Done.

## Step 8. Smoke test (1 minute)

Ask the role agent a question whose answer is in what you loaded (a fact from
the website or a README the owner would know):

```sh
docker compose -p liaison -f deploy/docker-compose.yml exec -T app \
  liaison agent ask --as owner@acme.example --agent @support --new-conversation \
  --timeout 180 "What does Acme's warranty cover? Cite your source."
```

`--new-conversation` asks in a fresh conversation, so asking again after a
fix is answered from the loaded knowledge, not from the previous answer.
It acts as the member named by `--as` (the owner) with a short-lived token
that opens no session, records the question on the audit log, and prints
JSON: `answer`, `model`, `toolCalls`, `seconds`, and `error` when the turn
failed. Pass when `ok` is true, a `knowledge__search` or `knowledge__get` call
is listed and the answer names the document. On `error`, show it: "credit
balance is too low", "no usable model key" or "No API key available" is the AI key (fix it in
`deploy/.setup-secrets.env`, rerun step 5, ask again); a timeout means check
`docker compose -p liaison -f deploy/docker-compose.yml logs --since 5m app`.

## Step 9. Report (1 minute)

End with three short parts built from `timings.txt` and the reports:

1. **Done**: URL, org, admin, members invited, documents loaded per
   collection, agents, channels connected, the smoke test answer (one line),
   and in teach mode the tours played with their outcome.
2. **You can add later**: the remaining features as a short menu, each with
   the time a fresh `liaison setup state` prints (never phrased as tasks the
   owner owes), and that they can come back to you or the in-app setup agent
   any time; plus, on a trial, the
   move to a server (`docs/runbooks/production-bootstrap.md`, then
   `./deploy/move.sh <user>@<server> --base-url <url>`) and `liaison guide
   server` for what the server then needs.
3. **Time per step** as a table, with the total.

Include one line for the Liaison team answer: registered or not, and whether
bug report forwarding is allowed (the answer to item 10, or "not asked").

Also say how to stop and restart: `./deploy/quickstart.sh --down` keeps the
data; `./deploy/quickstart.sh` starts it again.

## Move the trial to a server

When the owner wants the trial on a server (a VPS, an office machine), move
the whole instance: data, members, connected accounts and their keys. Ask
before anything that changes the server or costs money.

1. Prepare the server once: Docker, a checkout of this release or newer, its
   own `deploy/.env` with the server's settings (SMTP, `BASE_URL`), TLS and
   DNS, as in `docs/runbooks/production-bootstrap.md`. Do not register on it
   and do not run step 5 there: the move brings the org.
2. Check SSH works without a password prompt: `ssh <user>@<server> true`.
3. From this checkout:
   ```sh
   ./deploy/move.sh <user>@<server> --base-url https://liaison.example.com
   ```
   It stops this machine's app (so nothing changes after the snapshot), runs
   `deploy/backup.sh`, copies the one archive to the server's
   `deploy/backups/`, runs `deploy/restore.sh` there, and prints the restore's
   verification (health, organization and file counts, an object read back).
   `--remote-dir <path>` names the server's checkout when it is not
   `~/liaison`.
4. Relay what the restore printed as pending for the owner: DNS, the new
   redirect URI in each OAuth client (Google sign-in, Gmail), and the webhooks
   external services call at the old URL (Gmail push, Shopify, Facebook,
   ticket intake). Leave this machine's app stopped: two running instances
   would both sync the same mailboxes.
5. Suggest nightly backups on the server: `./deploy/backup.sh --keep 14` from
   cron, with each archive copied off the server. The archive holds the data
   keys; never print it or paste it anywhere.

The same scripts work by hand (`backup.sh` here, copy the archive,
`restore.sh <archive> --base-url ...` there) when SSH from this machine to the
server is not possible.

Version control is the owner's choice. Keeping `deploy/setup/` (the config and
the knowledge files, never `deploy/.env`, `deploy/.setup-secrets.env` or
`deploy/backups/`) in a private repository makes the setup easy to replay; it
is a suggestion, never a requirement, and nothing here depends on it.

## Where to host it

Suggestions only, if the owner asks or has no host yet. Any machine that runs
Docker with 4 GB of memory will do. Prices are as of 2026-10 and change; check
the provider's page.

- **Free:** an always-on machine the owner already has (a mini PC, an old
  laptop, an office server) with 4 GB or more, reached through a Cloudflare
  Tunnel, which needs no open port on the router.
- **EU:** Hetzner CX23 (2 vCPU, 4 GB, about 5.49 EUR a month) or OVHcloud
  VPS-1 (4 GB, about 4.49 EUR a month).
- **US:** OVHcloud VPS-1 US (about 4.54 USD a month).

A team of about six people uses about 1.8 GB in practice. On a 4 GB host, add
a 2 GB swap file so a burst (a large import, a search rebuild) does not get a
service killed:

```sh
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```
