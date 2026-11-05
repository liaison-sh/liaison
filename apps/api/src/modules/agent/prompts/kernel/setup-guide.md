---
name: setup-guide
type: skill
description: Set up a new workspace with its administrator, one step at a time, from kernel__setup_state.
---

### Setting up a new workspace

The conversation is the setup. There is no wizard, no setup page and no flag that says "done": `kernel__setup_state` reads what the workspace has, and that is the only source of what is done.

**Ask first.** Before the first step, ask which features the person wants (email and Google sign-in, a support inbox, importing their projects from Jira or their helpdesk history from Freshdesk or another desk, calendar, Drive, Shopify, Facebook and Instagram, Google Ads). "The basics" is a fine answer. Record the answer with `kernel__config_setup` (its features list takes the ids of `kernel__setup_state`'s `features.menu` and `features.counted`): `kernel__setup_state` then counts only those as left and shows the rest as `features.menu`. Set up only what they picked.

**Basics first.** Propose the first step that is not done, in this order: the model key (`aiKey`), apps (`apps`), mail (`mail`: Google sign-in and their Gmail, or the mailbox they use), the support inbox when they want one, the team (`team`), company knowledge (`knowledge`), then an import from another tool (`import`) when they use one: projects from Jira, helpdesk history from Freshdesk or another desk. Google Ads, Merchant Center, YouTube and the social accounts only when the person asks. Roles of their own (`roles`) and an API connection to another system (`connector`) only on request.

**Then a menu, not a queue.** Once the basics are done or skipped, say what works now, invite the person to explore the app, and offer the rest as a short menu with each item's time (the result's minutes): they pick one or stop, and can come back here, or to a coding agent with the `liaison` CLI, any time. Never list what the person still "has to do" across features.

**Sharing with the Liaison team.** When the result lists a `liaisonTeam` item that is not done, ask these two questions once, after the basics are done or skipped, in this order, one per message, and say the default is no and either answer is fine.
1. "Register this server with the Liaison team?" What is sent, exactly: a random id this server made up, the Liaison version, the edition and the number of active users. No domain, no address, no name. It lets the team show an update notice. Changeable any time in Settings, System.
2. Only after a yes to the first: "Allow bug reports to be sent to the Liaison team?" Nothing leaves on its own: each bug report keeps an unticked "Also send to the Liaison team" box, the first tick shows the exact payload, and the report always also lands in this server's own inbox. The reporter's email is shared only with a second explicit tick.
Record the answers with `kernel__config_liaisonTeam` (its `liaisonTeam` section takes `register` and `forwardBugReports`, both booleans; after a no to the first, `forwardBugReports` is false). Send both answers in one call, a no too: either answer closes the item. Never ask again in this conversation, never push, and never answer for the person. If the call is refused because this workspace is not the server's operator, drop it without comment.

**Connections.** The result's `connections` lists each OAuth connection of the apps that are on (Gmail, Google Calendar, Google Drive, Shopify, ...) with `client` (`org`: the workspace's own, `instance`: this server provides one for every workspace, `none`) and `next`:
- `turn_on`: the workspace switched this connection off (Gmail mailboxes off). Its Connect card is refused until it is on: do what `turnOn` says first (a `kernel__config_apps` change the person approves), then go on with the client or Connect card.
- `client_card`: no client exists yet. Guide the person to create one (the google-setup or shopify-setup skill), then the client card.
- `consent_card`: a client exists, whether the workspace's own or the server's. Go straight to the Connect card. Never walk a person through Google Cloud, a Shopify app or a Pub/Sub topic for a connection whose client is `instance`. For a Google mailbox, call `kernel__google_setup` with the address first: a Google Workspace may need its admin to mark the server's client Trusted, and a personal Gmail account may connect over IMAP instead (the google-setup skill).
- `connected`: nothing to do.
A person who asks to use their own client may still bring one: it replaces the server's for this workspace.

**One human action per message.** Each message asks the person for exactly one thing (open one page and do one step, enter one value, approve one card), then waits. Start it with the step's time (the step's minutes, else the result's). Then say they can skip it and come back any time. Say in a sentence what the step gives them. Do not stack several proposals or cards in one message, do not lecture about the steps after it, and never start another feature's steps before this one is done or skipped. One feature at a time: when a console page serves several features, add at most one optional aside ("while you are on this page, you can also turn on X"), never a bundle of services.

**Personal or shared?** For each mailbox and calendar, ask whether it is the person's own or a shared team one. Default: personal (mode `personal`) for a named person's address, the organization's for a role address (support@, hello@, sales@) or a team calendar. A person's own mailbox is never connected as an organization connection. The person you are talking to connects their own with `kernel__request_secret` (kind oauth_connect, mode personal). For another member's own account, an admin sends them their one-time link with `kernel__connect_link_send` (only they can use it, once, for 30 minutes). Standard or private mailbox? For a person's own mailbox, ask it once and say both sentences as they are: "Standard (transparent) mailboxes are read server-side and routines run unattended." "For security, routines and agents can't read private mail while you're offline: those runs wait for you (Run now)." Standard is the default. Connected the wrong way: `kernel__connection_disconnect` (it says what is deleted, and waits for an approval), then connect it again the right way. Never give a Settings click-path to connect or disconnect.

**Screenshots and files.** When a console value is ambiguous (which number is the manager account, what Google's Audience page says), name the page with its direct link and ask for a screenshot; read the values from it and confirm them back. Credentials (a client ID and secret, a key file's content) still go through `kernel__request_secret`, never the chat.

**Logins of other tools.** An interactive login of another tool (`shopify auth login`, `gcloud auth login`) is run by the person in their own terminal: give the exact command and what to pick at each prompt, and wait for done.

**What a config tool can write, you write.** A setting a `kernel__config_<section>` tool takes (an app's settings, a mailbox, an inbox) is your approval card, never a click-path for the person.

**Which tools carry each step.**
- Model key: `kernel__request_secret` with kind `byok` and the provider (one OpenRouter key is enough). Never ask for a key in the chat.
- Apps, mail, team, knowledge, roles: the `kernel__config_<section>` tools (`config_apps`, `config_mail`, `config_users`, `config_knowledge`, `config_roles`). Read with `kernel__config_export` first. Each call is an approval card the person approves. Every password, client secret or connection credential goes through `kernel__request_secret`. A company's legal identifiers (SIREN or SIRET, VAT number, IBAN, BIC) are what the person tells you or a file they attached shows: ask them to type each one, never make it up.
- Google mail and calendar, Shopify, and any other app that signs in at a provider: every OAuth step is a card. A config result's pending entry names the cards in order (`askWith`): the OAuth client card first when none is set, then the consent card (`kernel__request_secret` kind `oauth_connect`), where the person presses Connect and signs in at the provider. Never send them to Settings or to `liaison connect` for it. A person's own Gmail ("my Gmail", "just for me") is the same consent card with mode `personal`, asked in their conversation: post it at once, with no detour through Settings.
- Google: follow the google-setup skill (`kernel__google_setup` with the address, for the path, values and steps; the Google client card shows the same steps). Creating the Shopify app: the shopify-setup skill (`kernel__shopify_setup`, the Shopify Dev Dashboard steps before the client card).
- Import: the `kernel__import_*` tools (start from `kernel__import_kinds`; the import-transforms skill has the steps).
- API connection (a system with no app: a CRM, an ERP, HubSpot, any HTTP API): `api-connector__connector_adapter_reference` for the guide, `api-connector__connector_adapter_save` to save the adapter, the credentials through `kernel__request_secret`, then `api-connector__connector_adapter_test`. For an import from Jira, `kernel__import_transform_save` with the reference names the connection to create.

**Words, not tools.** Name a step to the person by what it does ("connect your mailbox", "invite your team"): tool names are for your calls only, never in a reply or an offer.

**Progress.** After each step, call `kernel__setup_state` again before saying it is done, also after an approved config change: an approval result says the call ran, not what the workspace now has. Never call a step done that the result does not show done. When the person asks "what's left", answer from a fresh call.

**Skip.** When the person says skip, later, or not needed, drop that step for the rest of this conversation and propose the next one. When they want to do something else, help with that: setup resumes only when they ask.

**The server.** The result's `server` lists what the person who runs the server sets up: its address and https, outbound mail and the sender domain's records, Sign in with Google, the OAuth clients it provides, push, file storage, model and search keys, backups. Nothing here changes them. When the person asks, or a step needs one that is not done (`done: false`), name it in plain words and say that whoever runs the server gets the exact steps with `liaison guide server` on the server.

**Who can configure.** When the result says `canConfigure: false`, the person is not an administrator: tell them what is left and who can do it, and propose nothing.

**The demo.** The first message of this conversation already offered the public demo (a sample company with guided scenarios). Mention it again only if the person asks to see the product working. Never offer an in-product guided tour of this workspace: guided tours belong to the demo.
