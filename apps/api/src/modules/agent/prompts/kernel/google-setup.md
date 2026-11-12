---
name: google-setup
type: skill
description: Connect a Google account or mailbox: Workspace, personal Gmail or IMAP, by the address's path.
---

### Connecting Google and email

**Ask for the address first.** Ask which address to connect, or use the person's own when they mean theirs ("my Gmail"). Then call `kernel__google_setup` with `email`. The result gives `accountType` (`google_workspace`, `google_consumer`, `microsoft`, `other`, `unknown`), `path`, the guide steps in the person's language, the exact values, and `nextStep`. Follow `path`; quote the values exactly. Never write a redirect URI, a scope, an API name or a client ID from memory: a single wrong character fails at Google.

**Paths.**
- `consent`: a client is ready (the workspace's own, or the server's and Google has verified it). Go straight to the Connect card (`kernel__request_secret` kind `oauth_connect`).
- `consent` with an `internalTrust` step: the server's client is Internal to this address's Workspace (its audience is Internal), so nobody marks it Trusted. Mention the step's admin check ("Trust internal, domain-owned apps", with its link) only if Google answers `admin_policy_enforced` or "Access blocked".
- `trusted`: a Google Workspace address, and the server's Google client is External and has not passed Google's verification. A Workspace super admin marks it Trusted first, then the person connects. Walk the guide one step per message. Step `admin` comes first, alone in its message: ask whether the person is a super admin, with no Connect card and nothing turned on yet. If not, give them the ready-to-send message (the step's value) for their admin, copied as it is in a quote block (never retype the client IDs), and wait. If it is already done, go to the Connect card. If Google answers `admin_policy_enforced` or "Access blocked", the Trusted step is missing or not applied yet: say so and start at step `admin`.
- `consumer_imap`: a personal Gmail address, and the server's client is not verified. First say `statement`, plainly, in your own message, before any setup step: Gmail and Drive in full need a Google Workspace account; a @gmail.com mailbox connects over IMAP with an app password. Say what it keeps and what it lacks only as `statement` says it: never claim archive or read state stay in Liaison only, and never promise instant mail. Ask whether to connect over IMAP now. If yes, walk `imap.guide` one step per message, then the IMAP form card: `kernel__request_secret` kind `connection_credentials`, app `mail`, connection `imap`, mode `personal`, `identifier` the address (the mailbox is the person's own). Never post a Gmail Connect card for this address; Google Drive still connects, in picked mode (see Google Drive below). Never offer mail forwarding: Liaison has no forwarding address.
- `own_client`: no Google client exists. Walk the guide below to create one (see "Creating a Google client").
- `imap`: not a Google mailbox. Walk `imap.guide`, then the same IMAP form card (mode `org` only for a mailbox the organization shares). When the result has none, ask the person who hosts the mailbox and call again with `imapProvider`, or with `accountType` `google_workspace` only when they say it is Google Workspace: never assume it. An Outlook, Hotmail or Microsoft 365 mailbox cannot connect with a password: say what its guide says, plainly.
- `ask`: the domain did not answer, or there is no address. Ask the person who hosts the mailbox, then call again.

Shared desk mail that should become tickets goes to the Tickets app; a person's own mail goes to the Mail app. Ask which they want when it is not clear, and set up only that one: never add a ticket inbox or another mailbox nobody asked for. The address is the one the person gives you, never one made up from the company's domain.

**Each step.** One step per message. Say in one sentence why the step exists, give its pages (`links`) and its values, and wait for the person to say it is done. Check results yourself (`kernel__setup_state`), never on their word alone. A step with `who: "agent"` is yours to do (the person approves the card).

**Creating a Google client** (path `own_client` only, or when the person asks to use their own client: it then replaces the server's). Follow the guide's steps in order (project, APIs, audience, branding, data access, the Web application client, then the client card); each step's `links` are the pages to open and its body says what to choose there (for the audience: Internal or External, and what External in Testing means for the person). Say it in your own words, never more than the step says.
- Only list the APIs and scopes the result gives. When it lists no Google app, propose turning on the app they need first (`kernel__config_apps`).
- One feature at a time: pass `feature` (mail, calendar, google-drive...) so the APIs step lists only that feature's APIs; the result's optional `alsoApis` step is the "while you are on this page" aside, said as optional. Ask once for the Cloud project's ID (or read it from a screenshot of the project picker) and pass `projectId`: every API link then opens with that project selected.
- Audience first: ask what the Audience page shows (a screenshot is fine). Internal (the project belongs to the company's Google Workspace) needs no Trusted mark and no Google review; External with Testing is for personal Gmail addresses.
- The client step lists both redirect URIs: one Web client serves signing in to Liaison with Google and every Google connection (Google asks for each permission when an account connects, not per client). Signing in with Google itself is turned on by whoever runs the server, never from here.
- Gmail push is optional (the guide's `push` step): offer it only when the person asks for instant updates.

**Gmail mailboxes switch.** Gmail mailboxes are a workspace switch. When `nextStep` says they are switched off, turn them on first with the `kernel__config_apps` change it names (the person approves it); a Gmail Connect card is refused while the switch is off.

**Google Drive.** When the Drive app is on, the result has `drive`: `mode` and `nextStep`. Mode `full`: Liaison reads the whole Drive once connected; never talk about picking files. Either way, put the address as the Drive Connect card's `identifier`: it decides which mode connects. Mode `picked` (a personal Google account on the server's client): first say plainly that the person chooses which Drive files Liaison can see, and that a Google Workspace account can share the whole Drive. Then the Drive Connect card (`kernel__request_secret` kind `oauth_connect`, app `google-drive`, connection `drive`, `identifier` the address), alone in its message, after any mailbox is connected; once Drive says connected, in a later message, the picker (`google-drive__drive_picker`, an Open button). In picked mode, when a file the person names cannot be found, show the picker so they can add it. Files added to a picked folder later may need picking too.

**A person's own mailbox.** For "my Gmail" or "just for me", the Connect card takes mode `personal` (`kernel__request_secret` kind `oauth_connect`, app `mail`, connection `gmail`), once the path allows it; never point to a Settings button instead.

**Order.** One card per message: the mailbox card; once it says connected, in a later message, the Drive Connect card; once Drive says connected, the picker (`google-drive__drive_picker`). Never two cards in one message.

**Secrets.** The client ID and secret, and an app password, go through `kernel__request_secret`, never the chat. If the person pastes a secret in the chat, tell them to delete the message and create a new one.

**Done.** Call `kernel__setup_state` before saying a step is done: the workspace, not the person's word, says it is done.
