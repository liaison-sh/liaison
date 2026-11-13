<!-- SPDX-License-Identifier: FSL-1.1-ALv2 -->

# Liaison release notes

Most recent first.

## Two kinds of app, a sandbox on every server, and dashboards people write

This release changes how apps run. Liaison now has exactly two kinds of app. The core
apps (tickets, mail, contacts, calendar, knowledge, projects and the MCP manager) are part
of the server and run as its own code. Every other app, whoever wrote it, runs sandboxed:
it wakes up for one bounded run, holds no secret, and talks to the server only through
the calls its manifest declares. On a self-hosted server that sandbox is now a separate
service, `workerd` under gVisor, started with the stack. Read the notes for operators
before you upgrade: the host needs gVisor.

### Apps run in their own sandbox service

- A new `sandbox` service in the compose file runs every sandboxed app on a supervised
  pool of `workerd` processes (the runtime behind Cloudflare Workers), in its own
  container under gVisor, on a network that reaches nothing but one port of the app.
- One process serves one organization's app at one version, runs as its own user, and
  is never reused for another organization. A run past its time, its CPU time or its
  memory is killed alone; other organizations' runs go on.
- A run carries a token for that run only. Every `ctx.*` call comes back to the server,
  which checks the token, so an app never sees a key, a password or an OAuth token:
  the server adds credentials to the app's outbound calls itself.
- The service checks its own network at start and every hour, and refuses every run
  while it can reach more than the app's bridge port.
- In the managed cloud, apps run on Cloudflare Workers, and a run the loader cannot take
  runs on the server's own sandbox service.

How it works, how to size it and the risks it does not remove:
[The app sandbox service](self-hosting/sandbox.md).

### Apps wake up, do their work and stop

- Every way an app runs (tools, webhooks, jobs, timers, events, exports, approval
  summaries, import transforms, PDF templates, previews) is one bounded run through one
  door, with one table of limits.
- Apps get typed job queues, timers and resumable steps: a long sync works in pages and
  picks up where it stopped, instead of holding a run open.
- Webhook deliveries are stored before the app's handler runs and replayed if it fails.
- Approval summaries and app attention items are written when they change, so opening a
  card or the Home feed runs no app code.

### Google Drive, GitLab, the database connector and the API connector are catalog apps

They install, upgrade and run like any other app. An existing install keeps its
connections, credentials, synced folders, adapters and cursors: the server moves them
over at its first start on this release.

### Dashboards people and agents write

- Dashboard tables that people and agents fill in, shared like knowledge documents, with
  history, undo and routine triggers.
- Charts over time, stacked and blended layers, filters people add, drill-down, targets
  and comparison deltas, and a dashboard sidebar of its own.

### Mail and search

- Sending a message waits for the mail provider and happens once per draft: a send that
  was slow is never sent twice. If the outcome is unknown, the next Send asks before it
  sends again.
- Knowledge search narrows to knowledge documents in the search engine itself, so a
  frequent word no longer crowds every document out.

### Notes for operators

- **Install gVisor before you upgrade.** The `sandbox` service declares `runtime: runsc`;
  on a host without it `docker compose up -d` stops at that service and the app is not
  recreated. [Install gVisor](self-hosting/sandbox.md#install-gvisor), upgrade, then install
  the firewall step (`sudo deploy/sandbox-firewall.sh install`, then `check`): until it is
  in place the service refuses runs with `sandbox_network_open`. The full list:
  [Upgrading to the release that turns it on](self-hosting/sandbox.md#upgrading-to-the-release-that-turns-it-on).
- **Size it.** The service takes up to 2 GiB and 2 CPUs by default (6 processes, 2 kept for
  nested runs, plus 2 overflow); lower the app's own memory limit by as much on a host
  that sets one. A larger pool: [Size it](self-hosting/sandbox.md#size-it).
- **Check `/healthz`.** `dependencies.sandbox` must say `ok`, and `appsWithoutWorkerModule`
  must be `0`: an app version still counted there was installed from a package with no
  Worker module and must be reinstalled, or republished from a package built by this
  release; its runs are refused with `app_worker_module_missing` until then.
- **The way back, this release only.** `LIAISON_APP_RUNTIME=quickjs` runs every app on the
  former built-in QuickJS sandbox again. The next release removes QuickJS and this switch:
  run your apps on the sandbox service before you take it.
- `COMPOSE_PROFILES=sandbox` and `LIAISON_SANDBOX_URL` are no longer needed; existing values
  keep working. The service always runs the app's own image (`LIAISON_IMAGE`) and is
  recreated with the app, by `docker compose up -d` and by `deploy/rolling-deploy.sh`.
- **Config files.** The top-level `apiConnectors` section moved to the `api-connector`
  app's `provision.connectors` (credentials in the app entry's `connections`); Google
  Drive's `connection.sharedDrives` moved to `provision.sharedDrives`; the database app's
  `domainAccess` moved to its `provision` block. `config apply` refuses the old shapes
  with where each moved. See [the provisioning CLI](provisioning-cli.md).
- **App SDK.** `readConnectionCredentials` is removed: an app no longer reads a secret.
  Use `fetch` auth (bearer, basic, a named header or query parameter, an OAuth account
  refreshed by the server, or the connection's client credentials) instead; see
  [The app sandbox](app-sandbox.md). Sandboxed tools, events and jobs no longer hold a
  database transaction: write with `ctx.db.batch`.
- Migrations 0287 to 0301 run when the container starts.

## Apps your agent builds, dashboards for everyone, and approvals that answer to you

This release lets an organization grow Liaison itself. Your agent can now write an app for
you, store its data, and put it on a dashboard every member can open. Approvals go to the
person they concern, and an agent can fix or take back what it asked for. Underneath, the
same server can now run a managed cloud, and that edition is strictly opt-in.

### Apps your agent builds

Ask your agent for an app and it writes one in the conversation: it checks it, shows you a
preview, and publishes it as your organization's own custom app once a person approves.
`Publish version {n} as {app}? It installs for the whole workspace.` An apps admin
publishes directly; anyone else gets `Publishing needs an apps admin. Ask your agent to
publish it: it will request their approval.` The approval pins the exact version that
installs, so nothing can change between the card and the install.

- Custom apps are private to the organization that built them, on every installation.
- A preview is always read only and never sees a secret.
- Each custom app keeps its last 20 versions, and a `Logs` panel in its settings shows
  what it printed.
- Apps get their own data store: documents an app keeps per organization, which other
  apps and agents can read only where the app says so, under their own permissions.
- An app that wants to reach a new outside address asks first, at install, upgrade and
  publish. What it may reach is listed under `Outbound access` in its settings.
- Daily caps on app runs, calls and processing time keep one app from eating the
  instance.

The builder is off on a self-hosted server until you turn it on (see the notes below).
How it works: [Build an app with your agent](agents/build-an-app.md).

### Dashboards for every member

A dashboard is a page of metrics, tables and bar, line or pie charts, each block fed by a
tool or an app's data store and always run as the person looking at it, so nobody sees a
number they could not have asked for. Dashboards are personal or shared with the
organization; an agent that shares one with everybody asks for approval first.

Every member can now read and build dashboards, including in organizations created before
dashboards existed. Blocks can use rolling dates (`{{today-30d}}`, `{{startOfMonth}}`), so
"the last 30 days" keeps moving instead of freezing on the day it was built; dates follow
the organization's time zone. A `Dashboards` entry sits next to your apps, and open windows
update by themselves when a dashboard is created, shared, renamed or deleted. A member's
data export now lists their dashboards and data store documents. See
[Dashboards](agents/dashboards.md).

### Approvals that go to the right person

- A person decides their own requests: a routine, a connection or a skill they asked their
  agent for no longer waits on an admin.
- An agent can edit or withdraw a request it raised, instead of stacking a duplicate, and
  a member can withdraw their own request without being an approver.
- When an approved action fails, the agent now knows it was approved, tried and failed,
  and why, and the row in the approvals list says so too.
- When you cannot decide a request yourself, the agent tells you who can, by name.
- Several routine runs waiting for the same private mailbox show as one row, with
  `Run all` and `Dismiss all`.
- A pending request closes by itself when its task is deleted or its app is switched off,
  and a social reply whose outcome was unknown is reconciled once it is known.
- The number on Home is now the rows of `Needs you`, so every count you see can be opened.

### Agents and the clients you connect

- An outside AI client connected over MCP that lacks a permission now
  says so and offers to request it, instead of building a stand-in. It looks for an
  existing named agent whose job fits before creating anything, and it sees what each
  agent is for.
- The common agent base now reaches every existing role agent automatically when the
  server starts. No configuration apply is needed after an upgrade.
- An agent asks you before it opens a new conversation with people, rather than starting
  a group thread nobody asked for.
- An agent opens any tab you could open yourself, and opens a record by its number.
- Tools can be found by describing the job, in French as well as English.
- An agent that ends a turn announcing its next step without taking it is nudged to
  actually do it.
- `Reconnect` is offered on every connected account you manage, so you can re-run a
  grant after an app asks for more access.
- The organization's AI models can be read and set from the agent's own tools. The default
  OpenRouter model is now DeepSeek V4.1 Flash 1017.

### Invoicing

- Issue dates and the year in a document number follow the issuer's time zone, not UTC.
  An invoice made just after local midnight on 1 January is dated and numbered in the new
  year.
- Credit notes are never dated before the invoice they correct, their stated date decides
  their number, and their approval card shows the amount, lines and date.
- Quotes and invoices for a B2B company name the company, use its location's billing
  address and tax number, and respect each document's own tax inclusivity.
- An order retried later reads the customer's current VAT number and company. An untaxed
  intra-EU order without a VAT number waits for review instead of issuing.
- A document's handle is its number, and the PDF tab previews inline, including in Safari.
  `Preview PDF` says when a PDF is not ready yet; the editor warns before a date would be
  refused.

### Shipping papers by configuration

Customs and certification papers are now document templates you write yourself. Blocks
can be conditional, tables repeat over an order's lines, and placeholders can compute
weights, totals and percentages. Document rules, matched on product attributes, decide
which papers an order needs; Boxtal generates them when an order reaches preparation and
again after the label is bought, and prints them with the pack. You can preview an
order's papers before the first one is printed. See
[Shipping documents](admin/shipping-documents.md).

Boxtal also got a batch of field fixes: FedEx tracking numbers are read reliably, and a
typed number unblocks a label that cannot be read; every parcel of a multi-parcel
shipment is printed; one shipping worklist replaces the separate tables; a label purchase
survives a timeout without buying twice; and the shipment's label download opens the
label.

### Mail and social

- Mail you send to a known contact is linked to that contact, from the composer and from
  a mailbox, even before they reply.
- Forwarding a sealed attachment from an encrypted mailbox sends it.
- Sending from a mailbox whose connection is gone gives a clear answer instead of an error.
- A Page's own replies are never reported as social findings.

### Security

- Role agents can no longer hold any scope that would ask a person for a second factor;
  personal agents are unchanged.
- A permission change takes effect the moment it commits: a token minted before it is no
  longer accepted for a few seconds afterwards.
- App bundles carrying import attributes are refused before they are parsed.
- Disconnecting an account, from anywhere, now stops its push notifications and revokes
  its grant at the provider.
- Database and ads reads mark the turn as having read outside text, so a later outbound
  action in that turn waits for a person.
- A device sign-in can no longer pass a tool call off as a person's click.
- Sign-in codes are rate limited per address and per network, with a countdown on
  `Send a new code`.

### The managed cloud edition

The same code can now run Liaison as a hosted service: each organization on its own
address, plans with a credit allowance metered per model call, `Plan`, `Usage` and
`Billing` screens, and moving an organization between servers. It is off unless the
server is started with `LIAISON_EDITION=managed`; a self-hosted installation behaves as
before.

### Fixes

- Signing in while a session refreshes no longer fails now and then.
- Search no longer misses something written just before an index rebuild.
- A message edited or deleted is no longer brought back by an older page of the thread.
- Deleted tasks are left out of project search unless you ask for them.
- A deactivated person's routines pause, and routines paused for a missing scope resume
  once it is back. Whoever may read a routine may read its runs.
- A merged ticket's conversation moves to the ticket it was merged into.
- Shopify draft orders refuse an order Invoicing would not invoice, and product status
  filters now match. Draft orders for a B2B company are placed for its location and
  priced by the company's catalog.
- The Discover list is in name order, and unsaved settings edits survive a refresh.
- Bug reports can be discarded and send after an update; long log lines no longer break
  the form.

### Notes for operators

- Migrations 0263 to 0286 run when the container starts. Upgrading across 0190 and 0261 in
  one go no longer fails, and scope seeds a non-superuser migration login skipped are
  re-applied.
- New, all optional: `LIAISON_CUSTOM_APPS=on` turns on custom apps and the app builder
  (off by default on a self-hosted server); `LIAISON_APP_FRAME_ORIGIN_TEMPLATE` serves app
  screens from their own origin; `LIAISON_WORKERS_*` enables the Workers executor, a beta
  that runs app code in isolated workers and falls back to the built-in sandbox; and
  `GMAIL_PUSH_AUDIENCE` and `GMAIL_PUSH_SERVICE_ACCOUNT` verify Gmail push for every
  organization. See [Docker](self-hosting/docker.md).
- `CONTROL_PLANE_URL` and `CONTROL_PLANE_API_KEY` no longer make a server managed on
  their own: only `LIAISON_EDITION=managed` does.
- App webhooks register on an organization's own host when organizations have hosts.

## Named agents, Home, and Liaison on every screen

This is the largest release Liaison has had. Until now your organization had one agent:
it answered everyone, it knew everything anyone had taught it, and it had no name. It is
now a team of named agents, each one a colleague you can address, each one with its own
job, its own tools and its own memory.

### Named agents

Your organization now has role agents (support, logistics, finance, growth), a personal
agent for every member, and one shared base agent that owns the knowledge everybody
needs. You talk to an agent the way you talk to a person: a direct message, or a mention
in a channel. Mentioning an agent in a room adds it to that room, and the room says so.

Each agent carries its own skills, its own routines and its own knowledge. Asking the
finance agent about a shipment is no longer the right move, and it will say so and point
you at the agent whose job it is.

Agents that are busy say what they are doing. You will see `Queued` while an agent is
waiting its turn, `Working` while it runs, and `Stuck` or `Failed` when something needs
you.

Retiring an agent is a deliberate act. If it still owns work, Liaison refuses and tells
you why: `This agent still owns skills or routines. Reassign them first.`

### Home: channels and direct messages

Home is now split into Channels and Direct Messages, the way you would expect. Channels
can be marked discoverable, so a new member finds the rooms that are open to them and
joins without waiting for an invitation. Agents sit in channels as participants, with
their own name and avatar, alongside the people.

### An agent only ever shows you what you are allowed to see

Permissions used to be an all or nothing affair. Now every message carries what it took
to produce it, and Liaison shows a message to a person only when that person could have
asked for it themselves.

When an agent cannot use one of its abilities because someone in the room may not see the
result, it says so plainly instead of quietly doing less:

> Some capabilities are unavailable here
>
> Not everyone in this room has access to what I would need, so I left some capabilities
> out.

You can take the conversation somewhere private (`Continue in a DM`) or, when the
information is yours to share, publish it to the room anyway (`Share anyway`). Some things
are never shareable, and those say so: `This one cannot be shared here.`

Where a room holds messages you cannot see, Liaison tells you they exist rather than
pretending the conversation is shorter than it is: `1 message hidden`, or
`{n} messages hidden`. And before you add someone to a room with history they will not be
able to read, Liaison asks first: `This room has earlier messages {name} will not be able
to see. Add anyway?`

### Agents that talk to each other

An agent that needs something outside its own job can now ask the agent whose job it is,
and invite that agent into the conversation. Exchanges between agents are grouped together
so a thread stays readable: you see the outcome, and you can open the exchange when you
want the detail. An agent can never obtain, by asking a colleague, anything you could not
have asked for yourself.

### Memory

Agents keep a real memory: notes organized per conversation, episodes, and checkpoints
they write as work progresses. Before each turn an agent recalls what is relevant instead
of being told everything again. You can search an agent's memory, read it, and make it
forget a conversation.

### Liaison on a phone or a tablet

The whole app now fits three sizes. On a phone (narrower than 640 pixels) navigation moves
to a bottom bar and details open in place instead of in a second column. On a tablet
(roughly 640 to 1023 pixels) the sidebar becomes a drawer beside the content rather than a
block stacked on top of it. On a desktop nothing changes. Touch targets are at least 44
pixels everywhere.

### Liaison on the desktop, with a model on your own machine

There is a Liaison desktop app. It runs the same interface you already know, and it adds
one thing the browser cannot do: a session that runs on your own computer, with your own
model, against your own files. The macOS build is signed and notarized; the Windows build
is not signed yet, so Windows warns on first run ("More info", then "Run anyway"). All
three are downloadable from the web app: the icon under Settings in the left rail lists
the installers, with the one for your computer first.

Pick where a conversation runs from the model picker, which now has two groups:
`Local models` and `Liaison models`. A local session reads the conversation it was started
from, does its work on your machine, and posts its reply back into that same conversation,
as the agent. It has the agent's full definition, its skills and its memory, and it is held
to exactly the permissions the agent has in the cloud.

On first launch the app asks where your Liaison lives:
`Enter your Liaison server address`, with `You can also open a connect link from the web
app.` underneath. Approving the app is a one time step in your browser.

### Liaison on iOS and Android

There is a mobile app, built from the same interface, and it carries the path that
notifies you when an agent messages you. No push notification has been sent in production
yet: sending needs your own Apple and Firebase credentials (see the notes below), and what
we have proven so far is what leaves the server, which is covered by tests. Those rules
hold on the server side whatever the credentials are: a notification is only ever prepared
for a message you are allowed to see, and its contents are reduced before they leave the
server, so nothing sensitive can sit in a notification tray or a delivery log.

### Notes for operators

- Upgrading an existing installation runs a one time per organization migration that gives
  every existing skill, routine and memory an owning agent, and moves existing agent
  conversations onto the right personal agent. Nothing is deleted and nothing is renamed.
  The procedure comes with a verification query and a way back at every step.
- Push notifications need your own Apple and Firebase credentials configured before the
  mobile app can deliver them.
- Signed desktop releases and in app updates need the desktop signing credentials
  configured in your build pipeline. The macOS build is signed and notarized today and
  Windows ships unsigned. Installers and the update manifest are served from
  `downloads.liaison.sh` (see `apps/desktop/ci/downloads-hosting.md`).
- The desktop interface has been validated in a browser and by walking the rendered
  document, which is how every behaviour described above was checked. A side by side
  comparison of the finished pixels against the design is still to come, so small visual
  differences from the web app are possible in this first build.
