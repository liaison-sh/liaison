---
title: The liaison command line
description: "Sign in to your Liaison organization from a terminal, build and publish your organization's own apps, and apply roles, agents, skills and routines from a file: over HTTPS, with no server access."
---

The `liaison` command line works from your own computer against your organization's Liaison address, as you. It needs no server access, no database and no copy of Liaison's code, so it works on a hosted organization. Claude Code, Codex or any other assistant with a shell can run it for you.

It is not the server's own `liaison` command: that one runs on the server, next to the database, for imports, provisioning and operator tasks (see [Configure Liaison from a file](../provisioning-cli.md)). A server-only command such as `liaison tickets import` answers that it runs on the server.

## Install it

The command line needs Node.js 20 or later, or Bun.

From a copy of the Liaison repository:

```
cd packages/cli
bun install
bun run build
npm pack            # writes liaison-cli-<version>.tgz
npm install -g ./liaison-cli-<version>.tgz
```

The tarball holds one file, `dist/liaison.js`, with no other dependency: copy it to another computer and install it there the same way. Without installing, run `node dist/liaison.js <command>`.

## Sign in

```
liaison login --host https://acme.liaison.example
```

The address is https; plain http is accepted only for this machine (`localhost`, `127.0.0.1`, or a `*.localhost` name, as a local server giving each organization its own address uses). The command prints a link and a code and opens your browser (`--no-browser` only prints them). Check that the page shows the same code, read what it asks for, and press **Approve**. You must be signed in to that organization in the browser.

What the sign-in may do is decided by the server, not by the command line:

- By default it can build apps (`kernel:apps:build`) and read their logs (`kernel:apps:logs`), and never more than you can do yourself.
- `--admin` adds `kernel:apps:admin`, needed to approve an app's interface from the terminal (below). It does not let the command line install anything.
- `--config` adds what `config apply` needs: `kernel:roles:admin`, `kernel:agents:admin`, `kernel:apps:admin`, and reading and writing skills and routines.
- `--scope <scope>` adds a read scope (one ending in `:read`). Anything else is refused.

The approval page lists every scope it asks for. The sign-in never carries more than you hold: `liaison login` names any scope it asked for and did not get (building an app needs `kernel:apps:build`, which admins hold; anyone else asks an admin for it). The sign-in is kept in your system's keychain (the macOS Keychain, or the Secret Service on Linux), or else in `~/.config/liaison/credentials.json`, readable by you only. Set `LIAISON_CREDENTIAL_STORE=file` to always use the file, and `LIAISON_CONFIG_DIR` to keep everything in another folder. The token lasts 15 minutes and renews itself for 30 days.

| Command | What it does |
|---|---|
| `liaison whoami` | Your email, the address and the scopes the sign-in carries |
| `liaison logout` | Ends the sign-in on the server and forgets it here |
| `liaison login --host <address> --profile <name>` | Signs in to another organization under its own name |
| `liaison profiles` | The sign-ins you have; `*` marks the one in use |
| `liaison use <profile>` | Switches to another sign-in; `--profile <name>` does it for one command |

## Build your organization's own app

Your organization needs custom apps on: they are on in the managed edition, off on a self-hosted server until its operator sets `LIAISON_CUSTOM_APPS=on`. The server builds, checks, tries and installs the app; the command line only sends its files.

```
liaison apps init visit-log --title "Visit log"
cd visit-log
# edit app.manifest.json, handlers.ts, and ui.tsx for a page
liaison apps push
liaison apps test
liaison apps publish --wait
```

| Command | What it does |
|---|---|
| `liaison apps init <name>` | Starts a draft from a working template (`--template store-crud` or `read-only`) and writes its files to a new folder `<name>`. The app is named `<name>-o<your organization's key>`. |
| `liaison apps push` | Saves the folder's files as the draft's next version, then builds and type-checks it. Errors are printed as `file:line: message`. |
| `liaison apps test` | Runs each case in `tests/*.json` in the server's preview: as you, read-only, writes to a scratch space of the draft. Pushes first when the files changed. `--tool <name> --params '<json>'` runs one tool; `--fresh` empties the scratch space first; `--verbose` prints results and log lines. |
| `liaison apps publish` | Asks to install the latest version: it creates an approval card in Liaison and installs nothing. `--wait` waits until a person decides it and the install has run. |
| `liaison apps status` | The draft, the version installed, the past publishes and any publish waiting for approval |
| `liaison apps logs` | The installed app's log lines, newest last. `--follow` keeps reading; `--level warn` and `--since <time>` narrow them. A line shows only to a sign-in that holds what its run read (a run whose agent turn read contacts needs `kernel:contacts:read` too). The command says how many lines it hides and which scopes show them, to add with `liaison login --scope <scope>`. |
| `liaison apps rollback` | Puts the previously published version's files back as the newest version and asks to publish it (a new approval). `--to <version>` picks the draft version. |
| `liaison apps pull` | Writes the draft's latest files (or `--n <version>`) to the folder |
| `liaison apps list` / `liaison apps link <draft id>` | The organization's drafts; a folder for an existing draft |
| `liaison approvals wait <id>` | Waits for an approval card to be decided |

A test case is a JSON file in `tests/`, one case or a list of them:

```json
{ "tool": "add_visit", "params": { "customer": "Ada", "note": "Demo" }, "expect": { "ok": true } }
```

`expect` passes when every key it names has that value in the result, nested objects and lists included. `"expectError": true` expects any refusal; `"expectError": "<code>"` expects that refusal only (`--verbose` prints each one's code), so a case cannot pass on the wrong refusal. A case may name a `job` or a `webhook` instead of a `tool`.

The files run in name order (`01-`, `02-`... keeps `10-` after `09-`), one after the other, on the same scratch space: a case sees what the ones before it stored. `--fresh` empties it before the first.

The folder holds at most the four files the builder keeps (`app.manifest.json`, `handlers.ts`, `ui.tsx`, `README.md`, 512 KiB together); `.liaison/app.json` says which draft and address the folder belongs to. The rules an organization's app follows are in [Build an app for your organization](org-app-with-an-assistant.md#what-an-organizations-app-may-not-do).

Who can use the app once it is published is set by the roles its manifest declares: see [who gets it](org-app-with-an-assistant.md#approve-and-publish).

## Publishing always waits for a person

A sign-in from the command line never installs code by itself, even with `kernel:apps:admin`. `liaison apps publish` and `liaison apps rollback` create the same approval card as an assistant connected over MCP: a person holding `kernel:apps:admin` approves it in Liaison, after reading the version, its package fingerprint, its type check and what access changes. The command line cannot approve it: deciding an approval is done in your own browser session. Installing a package by its address is refused to the command line too.

## A rollback brings back code, not data

`liaison apps rollback` changes the code only. What the newer version stored stays as it wrote it, and nothing is deleted. The older code may not know what the newer one wrote: a status it never had (say `repair`), a field it never read. Records like that can then be missing from its lists or read wrongly until you publish a version that knows them again.

To keep a rollback safe:

- Make each change additive: add fields and values, keep the old ones meaning what they meant, and make new fields optional.
- Have list code show records it does not recognise (as "other", say) rather than skip them.
- Once a version has written data in a new shape, fix forward: publish a corrected version instead of rolling back past that change.

## Let the app's page run with your session

An installed app's page (`ui.tsx`) shows to no one until an admin approves it: then it runs with the session of the person using it. Approve it from the terminal:

```
liaison login --host https://acme.liaison.example --admin
liaison apps ui-consent
```

The command says what the page will be able to do (read what that person reads, call their tools, act as them) and asks you to type the app's name. Anything else cancels. Without a terminal it refuses, unless you pass `--yes` yourself after reading the text. The approval holds for the installed version only. `liaison apps ui-consent --withdraw` takes it back. On a server without an address per organization (`LIAISON_ORG_HOST_TEMPLATE`), an organization's own app has no page at all, only its tools.

## Apply roles, agents, skills and routines from a file

```
liaison login --host https://acme.liaison.example --config
liaison config apply team.yaml
```

The file uses the format of the server's `liaison config apply` ([reference](../reference/config.md)). From the command line it may hold only:

- `roles`, `agents` and `apps` (each app's config and settings): each section becomes an approval card in Liaison that shows what will change;
- `skills` and `routines`: each entry is created, or updated when one of that name exists, and each one is an approval card too. A skill takes `name`, `description` and `body` (the guidance the agent follows), and optionally `visibility` (`org` by default from a file) and `requiredScopes`:

  ```yaml
  skills:
    - name: equipment-loans
      description: How we lend test devices and chase late returns.
      body: |
        Use the Equipment loans app. Lend for at most 3 weeks. On a return, ask the condition.
  ```

Mail, the email sender, people and seats, invoicing, ticket inboxes, knowledge documents, API connections, model keys and every secret stay on the server: a file with any of them is refused whole, with where to set each one instead, and nothing is sent. `--dry-run` lists what would be sent.
