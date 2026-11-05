# The desktop overlay's IPC contract

The one place the shell's and the sidecar's real names are written down. Every module under
`apps/desktop/src/` cites this file instead of re-reading the Rust and the sidecar: a name that
changes is changed here once, and the modules that broke are the ones that named it.

Two hops, not one. The overlay talks to the SHELL over Tauri `invoke` / `listen`
(`apps/desktop/src/tauri.ts` is the only module allowed to import `@tauri-apps/api`), and the shell
talks to the SIDECAR over its stdin and stdout, one JSON object per line. So a "command" below is
a Tauri command, and a "line" is one protocol 2 JSON line the shell relays verbatim.

Protocol version: `2` (`apps/desktop/sidecar/index.ts:118`), announced on the `boot` line.

## Source layout this slice owns

- `apps/desktop/src/session/` : everything about a running local session (the sidecar client, the
  copy module, the model picker, the folder picker, the permission mode switch, the activity
  surfaces).
- `apps/desktop/src/onboarding/` : everything before a session exists (first launch, the deep link
  handler, runtime branding, the device grant login).

No component imports `@tauri-apps/api`. Components call `session/sidecar-client.ts`, which is the
only module that imports `src/tauri.ts`.

## Tauri commands (shell)

Registered in `apps/desktop/src-tauri/src/main.rs:19-28`.

| capability | command | signature | defined at |
|---|---|---|---|
| start a session | `start_session` | `{ agentId, cwd, permissionMode, model, resumeSessionId?, agentDefinition, agentKind }` -> `{ ok: true }`, or a rejected promise carrying a START REFUSAL or a reconnect reason | `sidecar.rs` `start_session` |
| end a session | `stop_session` | `()` -> `void` (sends the shutdown line first, then kills) | `sidecar.rs:92-93` |
| start a turn | `send_turn` | `{ prompt: string, turnCredential?: string }` -> `void`, the shell composes the `turn` line; `turnCredential` (S59) is the server's credential for the message the turn answers, kept only when it is 43 base64url characters and otherwise dropped | `sidecar.rs` `send_turn` |
| stop the running turn | `interrupt_turn` | `()` -> `void`, the shell composes the `interrupt` line | `sidecar.rs` `interrupt_turn` |
| answer a permission prompt | `respond_permission` | `{ requestId, behavior: "allow" \| "deny", message? }` -> `"allow" \| "deny"` (the decision the shell WROTE), or a rejected promise carrying `UnknownPermissionRequest` or `UnknownPermissionBehavior`. For a shell command, a write outside the folder or into a file that runs code later, or a tool of another MCP server (`permission_gate.rs`), an allow is written only after the shell's own native dialog says yes; a no there is written, and answered, as `"deny"` (D11) | `sidecar.rs` `respond_permission` |
| change the permission mode | `set_permission_mode` | `{ mode }` -> `void`, or a rejected promise carrying `UnknownPermissionMode`, `BypassDeclined` or `ModeDeclined`. Asks the shell's own native confirmation for `auto`, `edit` and `bypass` (D11) against the RUNNING session's folder; answers `Ok` with nothing running, because that is a preference for the next session. Resolving means the control line was WRITTEN, never that the SDK took it: the window waits for the `permission_mode` line before it remembers anything (P6d-FX2, SK-4) | `sidecar.rs` `set_permission_mode` |
| call a Liaison MCP tool | `call_mcp_tool` | `{ requestId, tool, args }` -> `void`, or a rejected promise carrying `McpToolNotAllowed` | `sidecar.rs` `call_mcp_tool` |
| read a file from the session folder | `read_local_file` | `{ path: string }` -> `{ base64, mime, sizeBytes }`, or a rejected promise carrying `NoSession`, `OutsideSessionFolder` or `TooLarge` | `sidecar.rs` `read_local_file` |
| native folder dialog | `pick_folder` | `{ agentId: string \| null }` -> `string \| null` (the chosen path, null on cancel). It is ALSO the only way a folder becomes startable: what the user walked to is recorded in `PickedFolders` and in that agent's recent list, and `start_session` refuses a `cwd` that is in neither (P6d-FX2, SK-1) | `sidecar.rs` `pick_folder` |
| the folders an agent has run in | `recent_folders` | `{ agentId: string }` -> `string[]`, newest first, capped at five. The SHELL's own file, owner-only, written by the picker and by nothing else: it used to be the webview's `localStorage`, which every script in apps/web can write, and it is half the set a session may be rooted in | `sidecar.rs` `recent_folders` |
| platform | `platform_info` | `()` -> `{ os, arch, ... }` | `sidecar.rs:134-135` |
| read the server address | `get_server_address` | `()` -> `string \| null`, the CURRENT entry of the saved server list (`servers.rs`) | `sidecar.rs` `get_server_address` |
| add a server and switch to it | `set_server_address` | `{ url: string, outgoing: { owner, storage } \| null }` -> `{ address, storage }`. Rejects on a non http(s) URL, and with `NotALiaisonServer` or `ServerUnreachable` when the address does not answer `/api/settings/branding` as a Liaison. On success the server joins the saved list and becomes current, the sidecar is stopped, the folders this window picked are forgotten, the MCP config is deleted, the page storage handed over is parked for its owner and the new server's parked storage comes back. No native confirmation (Avery, first Windows walk): the connect card is the question | `account.rs` `set_server_address` |
| switch to a saved server | `switch_server` | `{ address, outgoing }` -> `{ address, storage }`, the same switch for a server already in the list, `UnknownServer` otherwise | `account.rs` `switch_server` |
| forget a saved server | `remove_server` | `{ address }` -> `{ address: string \| null, storage }`. Refused with `RemovalNotConfirmed` unless the user confirmed that exact server in the shell's own native dialog (a ticket good once). Revokes its session on the server, forgets its refresh token, its agent tokens, its recent folders and its parked storage; the next saved server (or none) becomes current | `account.rs` `remove_server` |
| the saved list, for the page's servers UI | `list_servers` | `()` -> `{ current: string \| null, servers: [{ address, label? }] }`, the list as `servers.rs` keeps it. The page draws the servers group in Settings and the Servers switcher in the sidebar from it (`desktop-servers.ts`); the shell draws no Account menu on any OS, so that UI is the only switcher | `account.rs` `list_servers` |
| ask to remove a saved server | `ask_remove_server` | `{ address }` -> `void`: opens the shell's own native removal dialog for a server in the list (`UnknownServer` otherwise). On a yes the shell files the one-time confirmation and emits the `remove` action on `liaison-account-menu`, and the window then calls `remove_server` | `account.rs` `ask_remove_server` |
| sign out of the current server | `sign_out` | `()` -> `void`: revokes and forgets the current server's refresh token and agent tokens, and nothing of any other server | `account.rs` `sign_out` |
| the native questions' words | `set_account_dialog_copy` | `{ copy: { removeTitle, removeMessage, removeConfirm, cancel }, claude?: { signedIn, signOutTitle, signOutMessage, signOutConfirm } }` -> `void`; empty or over-long copy is refused and the shell keeps the words it had. `copy` is the removal question (`{server}` is filled by the shell), `claude` the Claude sign-out question (`{email}` is filled by the shell) | `account.rs` `set_account_dialog_copy` |
| the Claude account local turns run on | `claude_auth_status` | `{ fresh?: boolean }` -> `{ loggedIn, email }`, read with the bundled CLI's `auth status --json` (the sidecar in `--claude-auth status` mode). Without `fresh`, a signed in account the shell already read (at launch) is answered without running the CLI; a signed out one is always read again. Rejects with `ClaudeAuthUnreadable` or `ClaudeAuthTimedOut` | `claude_auth.rs` `claude_auth_status` |
| a local turn failed to authenticate | `claude_auth_note_failure` | `()` -> `void`: the shell's cached sign-in is dropped (signed out, email kept) and Settings > Profile offers Sign in again. It can only make the app ask for a sign-in, never skip one | `claude_auth.rs` `claude_auth_note_failure` |
| sign in to Claude | `claude_auth_login` | `()` -> `void`: starts the CLI's `auth login --claudeai` (the sidecar in `--claude-auth login` mode, a running one given up first), opens Claude's page with the shell's opener, and reports on `liaison-claude-auth`. The URL never reaches the window | `claude_auth.rs` `claude_auth_login` |
| hand the sign-in the code Claude shows | `claude_auth_submit_code` | `{ code }` -> `void`, written to the CLI as one control line and nowhere else (no log, no event); `ClaudeCodeRefused` for an empty, multi line or over-long code, `ClaudeSignInNotRunning` with no sign-in | `claude_auth.rs` `claude_auth_submit_code` |
| give up on the sign-in | `claude_auth_cancel` | `()` -> `void`: the cancel line, then the kill | `claude_auth.rs` `claude_auth_cancel` |
| open the sign-in page again | `claude_auth_reopen` | `()` -> `void`, the page that shows a code; only ever a Claude https page | `claude_auth.rs` `claude_auth_reopen` |
| ask to sign out of Claude | `confirm_claude_sign_out` | `()` -> `void`: opens the shell's own native question and nothing more. Signing out signs the whole computer out of Claude, the person's own Claude Code included, so the sign out itself is NOT a command: it runs in the shell only on a yes (`account.rs` `ask_claude_sign_out`, which calls `claude_auth.rs` `sign_out`), and the window hears `signedOut` on `liaison-claude-auth`. Settings > Profile asks it on every desktop OS, and it is the only place | `account.rs` `confirm_claude_sign_out` |
| store the wrapped session's refresh token | `store_refresh_token` | `{ token: string, server: string }` -> `void`, an empty string clears it, written 0600, ONE PER SERVER; refused with `NotCurrentServer` unless `server` is the current server | `sidecar.rs` `store_refresh_token` |
| read the wrapped session's refresh token | `load_refresh_token` | `{ server: string }` -> `string \| null`, the current server's token, and null for any server that is not the current one | `sidecar.rs` `load_refresh_token` |
| open a sign-in in the SYSTEM browser (RFC 8252) | `open_oauth_url` | `{ url: string }` -> `void`; refused unless the URL is the bound server's `/api/auth/oauth/<provider>/authorize` with `client=desktop`, an S256 `code_challenge` and a `state` | `sidecar.rs` `open_oauth_url` |
| open the device approval page in the SYSTEM browser | `open_device_approval_url` | `{ url: string }` -> `void`; refused unless the URL is the bound server's `/auth/device?code=<code>` and nothing else. The shell also opens it itself when a grant starts | `sidecar.rs` `open_device_approval_url` |
| open a clicked external link in the SYSTEM browser or mail client | `open_external_url` | `{ url: string }` -> `void`; refused unless the URL is `http`/`https` (with a host) or `mailto`, with no credentials in it | `sidecar.rs` `open_external_url` |
| save a file the window fetched (label, invoice PDF) and open it in its default application | `open_downloaded_file` | raw body = the file bytes, header `x-liaison-file-name` = the percent encoded name -> `"opened"`; refused (`DownloadRefused`) for an empty or oversized body or a name that is not an allowlisted document type; the name is sanitized and written to a new folder under the system temp dir | `downloaded_file.rs` `open_downloaded_file` |
| verify a first-party app's UI before it runs in the page (S13) | `verify_first_party_app` | `{ name, version }` -> `{ url, sha256, manifest }`; the SHELL fetches `ui.js`, `statement.json`, `statement.sig` and `manifest.json` from the bound server (no redirect), checks them against the keys compiled from `packages/shared/src/app-signing/keys.json`, the revocation floor and the latest signed revocation list, keeps the verified bytes and serves them at `url` (`liaison-app://localhost/<sha256>.js`, 404 for any other path); any refusal is an error code string | `verified_apps.rs` `verify_first_party_app` |
| open a local path a message named | `open_local_path` | `{ path: string }` -> `"opened" \| "revealed"`, or a rejected promise carrying `NotFound` (not on this computer) or `PathRefused` (not an absolute path, `~/...` or `file://` URL). A folder opens in the file manager and a document in its default application; anything executable or script like (by extension on every OS, by executable bit or bundle on unix, judged on the name written and the file it resolves to) is REVEALED in its folder and never run, because the agent's text chose the path | `local_path.rs` `open_local_path` |
| this install's folder hashing salt | `get_install_salt` | `()` -> `string`, 32 random bytes as hex, created once and kept 0600 | `sidecar.rs` `get_install_salt` |
| the conversation lease to release on quit | `note_local_claim` | `{ releaseUrl?, token? }` -> `void`. The page records the release URL of the claim it holds and the access token of the moment (on registration and every heartbeat); both absent forgets it. Refused unless the URL is the bound server's `/api/agents/<id>/local-claims/<thread>?holderKey=...`. On `ExitRequested`/`Exit` the shell sends that one DELETE, bounded to 1.5 s, before stopping the sidecar: a quit runs no page script, and the lease used to outlive the app (2026-09-23) | `claim_release.rs` `note_local_claim` |

There is NO command that writes a control line the window composed. Every line the shell writes to
the sidecar's stdin is composed in `sidecar.rs` from a typed command, and the two that carry
authority are checked there first. See "The threat model" below.

## Debug only hooks (never compiled into a release build)

Two things exist for a DRIVEN WALK of the debug app and for nothing else. Both are behind
`cfg(debug_assertions)` in the Rust shell, both are pinned by a test that reads the release arm, and
neither is reachable in a shipped app whatever the environment or the page says.

| hook | what it is | why a walk needs it | release behaviour |
|---|---|---|---|
| the diagnostic sink and the DOM probe | the `report_webview_diagnostic` command (`diagnostics.rs`, registered in the debug handler arm alone) plus `dom-probe.ts`, which samples the page at 3 s and 10 s and prints one line naming the root, the login card, the error count and the last error | the webview serves apps/web unmodified with no devtools window: a CSP refusal and a page error are otherwise invisible, and a blank window cannot say by itself whether the page never mounted or mounted and painted nothing | the module is not compiled at all, so every forward is a rejected invoke and is swallowed |
| the DOM driver | `LIAISON_DEBUG_DRIVER`, a directory read ONCE at startup (`driver.rs`, armed from `main.rs`'s setup). The shell watches it and evaluates every `<id>.js` dropped in it in the webview through Tauri's own `eval`, wrapping the source as an async function body; whatever the script returns, or throws, comes back as `<id>.json` beside it through the page's `__LIAISON_DRIVER_REPORT__` and the debug only `report_driver_result` command (`driver-bridge.ts`). The shell writes `<id>.req` BEFORE it evaluates anything and a `<id>.json` counts as an answer only when it is newer than that marker, so a result the page planted for a script nobody ran neither skips the operator's script nor reads back as the app's own answer (P6d-FX7, SK-10) | a walk has to reach the app's own controls, and synthetic input (CGEvent clicks, System Events keystrokes) steals the pointer and the keyboard from whoever is at the machine and cannot reach a window that does not have focus. Driving the DOM dispatches real events on real elements with no focus steal | the module is not compiled at all, so the command does not exist and the variable is never read |

| the background window | `LIAISON_DEBUG_BACKGROUND=1`, read ONCE at startup (`driver.rs`). The app takes the accessory activation policy on macOS (no dock icon, never the active application) and the window is built `focused(false)` and `always_on_bottom(true)` | a walk runs on a machine somebody is working at, and a window that takes the foreground takes their keyboard. Nothing in this shell calls `set_focus`, `show` or `activate` on a background window (the reconnect path included; the `oauth-complete` deep link raises the window only outside background mode), so this plus the two builder flags is the whole of it | the module is not compiled, the flag is a `false` literal and the accessory policy is not compiled either, so a shipped app builds the window it always built |

| the recent folder seed | `LIAISON_DEBUG_SEED_RECENT_FOLDER`, read ONCE at startup (`arm_debug_seed` in `main.rs`'s setup). When it names a directory that exists, the first `recent_folders` call for an agent puts that folder in the agent's list through `adopt_chosen_folder`, which is `pick_folder`'s own recording half: the folder joins `PickedFolders` and the shell owned recent file | the native Open panel takes no synthetic input on macOS and a fresh install's recent list is empty, so a walk had no way at all to reach a live local session. Hand writing the recent file was refused: that file IS the check (P6d-FX2, SK-1) | `debug_seed_folder`'s release arm answers `None` and never names the variable, so the recent list is written by the picker and by nothing else |

ONE CAVEAT A WALK HAS TO KNOW: an occluded webview is not repainted on every
DOM change, so `screencapture -l` of a covered window can be one frame behind
what the DOM says. The driver is the reliable reader; the capture is the
picture, and a judgment that depends on pixels needs a window nothing is
covering.

The driver is not a door the PAGE can open. It reads a directory only the
operator can name, on a process only the operator can start; the page cannot
ask for a script, cannot learn what is in the directory, and the result command
writes one file named by a checked id (no separator, no dot, 64 characters) in
that directory and nowhere else. What it does not reach are the NATIVE dialogs:
the folder picker and the Bypass confirmation are drawn by the OS, no DOM
touches them, and that is exactly the property they exist for. A walk records
them as a bound rather than driving them.

The seed issues no new authority. It goes in through the picker's door, so what the window is offered
is a SHELL issued handle for a SHELL chosen folder and `start_session`'s refusal of anything it did
not issue is unchanged. A value that names a file, a folder that is not there, or nothing at all is
ignored rather than guessed at.

## Tauri events (shell -> overlay)

| capability | event | payload | defined at |
|---|---|---|---|
| the turn event stream | `sidecar-line` | one raw protocol 2 JSON line (a string) | `sidecar.rs:25-26` |
| sidecar stderr | `sidecar-stderr` | one raw stderr line, secrets redacted (also written to `sidecar.log` in the app's log directory, README "When the local assistant stops") | `sidecar.rs:27-28` |
| the running session's sidecar exited on its own | `sidecar-exited` | `{ code, signal, booted, reason, stderrTail }`: `reason` is one line (what it last said, usage lines and stack frames skipped, or how it ended), `stderrTail` its last 20 stderr lines, redacted. Emitted only for a child that was STILL the running session: one the shell stopped or replaced is never reported, and one that dies before `boot` refuses `start_session` instead. The shell has already taken it out of the session slot. `sidecar-client.ts` dispatches it to every turn listener as `{ type: "sidecar_exited", ... }` | `sidecar_watch.rs` `SIDECAR_EXITED_EVENT`, `sidecar.rs` `spawn_sidecar` |
| the session is gone | `liaison-reconnect-required` | `NotApproved` \| `GrantFailed` \| `Unreachable` \| `DeviceClientNotAllowed` (the server refuses the desktop client id: an administrator has to act, no Reconnect is offered) \| `ConfigUnwritable` \| `SidecarSpawnFailed` \| `TokenRefreshFailed` (a RUNNING session's token renewal was refused by the server: the stored token is forgotten, and the Reconnect runs a new device approval) | `sidecar.rs:29-30`, reasons at `sidecar.rs:408-409` |
| a Claude sign-in's progress | `liaison-claude-auth` | `{ phase: "starting" \| "waiting" \| "checking" \| "codeRejected" \| "signedIn" \| "failed" \| "signedOut", account?, reason?, detail? }`. Never a URL, never a code; `detail` is one redacted line from the CLI | `claude_auth.rs` `CLAUDE_AUTH_EVENT` |
| a removal the user confirmed | `liaison-account-menu` (the wire name predates the in-app UI) | `{ action: "remove", address }`, the only action the shell emits, and only after the user confirmed that server in the shell's own dialog (`ask_remove_server`). The window releases the local session's claim, swaps its storage and starts again (`session/server-switch.ts`, `session/account-menu.ts`). There is no Account menu on any OS: macOS keeps only its standard menu bar (`menu_bar.rs`), whose Edit menu is what makes Cmd+C, Cmd+V and Cmd+Z work in the webview | `account.rs` `ask_removal` |
| a `liaison://` URL the OS handed the app: a `connect` link, or the `oauth-complete` link that ends a system-browser sign-in or app connection (which also brings the window forward) | `liaison-deep-link` | the URL as a string | `sidecar.rs` `route_deep_link`, emitted from `main.rs` `on_open_url` |

There is no separate event per protocol message: EVERY sidecar event arrives on `sidecar-line` and
is dispatched by its `type` field in TypeScript.

## Several servers, and what keeps them apart

The shell keeps a LIST of servers and a current one (`src-tauri/src/servers.rs`), shown in the
page's own servers UI (Servers in the sidebar, Settings > Profile; `account.rs`). Every piece of state that belongs to a server is filed under it:
the refresh token (`liaison-refresh-token.json`, one per server, released only for the current one
and only to a caller naming that same server), the agent tokens (`liaison-mcp-token.json`, keyed
`<server>#<agent>`), the recent folders (`liaison-folders.json`, same key; `start_session` accepts a
folder remembered for the current server only), and the page's own storage while another server is
current (`liaison-webview-storage.json`). The MCP config is deleted on every switch, and a start that
was waiting for a device grant spawns nothing once its server is no longer current
(`ServerChanged`). The page's half of a switch is `session/server-switch.ts`: the shell's command
first, then the claim released on the server being left, then the storage swapped and the page
started again. An install from before the list is migrated on first read: its one address becomes
the first saved server, with its refresh token and its folders.

## The session's MCP token, for the whole session

The per session MCP config (`liaison-mcp-config.json`, 0600) carries the agent scoped token AND
what renews it: `tokenExpiresAtMs`, `refreshToken` (this server's and this agent's, from the token
store) and `tokenUrl` (`<server>/mcp/oauth/token`, `auth.rs` `token_url`). The CLI is given no
static `Authorization` header: its Liaison server carries a `headersHelper`, the sidecar binary in
`--print-mcp-headers --mcp-config <path>` mode, which renews the token (forced) and prints
`{"Authorization":"Bearer ..."}`. The CLI bundled with the pinned SDK runs it on connect and again
after a 401 on a tool call, retrying the call once. The relay (`mcp_call`) reads the token from
the file on every call and renews and retries once on a 401 the same way. Renewals are written
back to the file atomically; a refused one is marked there (`tokenRefusedAtMs`) and reported ONCE
as `mcp_token_refused`. No token is written to stdout (other than the helper's one headers line to
the CLI), stderr, an event or a log.

## The threat model, and why the control commands are typed

The webview is FIRST PARTY: the shell serves the bundled apps/web build and injects this overlay
into it, so nothing hostile is expected to be loaded there. The attacker this section is written
against is therefore an XSS in apps/web, which already owns the user's session. The point of the
typed commands is not to stop that attacker reaching the user's Liaison data (it already has the
session); it is to stop the sidecar from being a SECOND prize on top of it.

A generic "write this line to the sidecar's stdin" command handed that attacker two things the web
session does not carry. First, the permission path: every `permission_request` reaches the page on
a broadcast `sidecar-line` event, so its `requestId` is public to any script, and a forged
`{"type":"permission_response","behavior":"allow"}` would run a tool on the user's own machine that
the user never approved (a Bash command, a file write, anything the agent asked for). Second, the
relay: an `mcp_call` line is spent on the session's AGENT SCOPED bearer, which the webview never
holds and which carries the agent's whole tool catalog.

So the shell keeps both decisions:

- it PARSES every sidecar stdout line before broadcasting it, and records the `requestId` of each
  `permission_request` in the managed session state (`PendingPermissions`);
- a prompt for a call that acts on this computer outside Liaison (a shell command, a write outside
  the folder or into a file that runs code later, another MCP server's tool) is recorded in the
  shell's own book (`ShellPermissions`), never in `PendingPermissions`: the page hears its id and
  can only DENY with it; an allow is written after the shell's native dialog, drawn from the
  sidecar's own words, says yes (D11). Liaison tools, reads and writes inside the folder keep the
  in-page card. `answer_node_job_permission` applies the same split to My node chat;
- `respond_permission` is accepted only for an id that is outstanding, and only ONCE. The id is
  retired when it is answered, when the turn ends (`turn_done`), when the process finishes
  (`done`), when a session is stopped and when a new one starts. Anything else is
  `UnknownPermissionRequest`;
- `call_mcp_tool` is accepted only for a tool in the shell's own allowlist (`MCP_TOOL_ALLOWLIST` in
  `sidecar.rs`, one entry today: `liaison_approval_status`, each entry carrying the reason it is
  there). Anything else is `McpToolNotAllowed`;
- `updatedInput` is not accepted at all: the sheet has no editor for a tool's arbitrary input
  shape, so a forwarded one would only ever be an attacker's.

`apps/desktop/src/tests/e2e/local-session-full-loop.scenario.test.ts` writes control lines to the
sidecar's stdin itself. That is the HARNESS standing in for the shell (it spawns the compiled
sidecar directly, with no Tauri window anywhere), not a second window path: nothing in the shipped
overlay can write a line the shell did not compose.

## Control lines (overlay -> sidecar, composed by the shell)

`ControlLine`, `apps/desktop/sidecar/index.ts:332-343`.

These are the lines the SHELL writes. The overlay never composes one.

| capability | line | read at |
|---|---|---|
| start a turn | `{"type":"turn","prompt":"...","turnCredential"?:"..."}`: with a credential the sidecar writes it to `<mcp config>.turn` (0600) and reconnects the `liaison` server (bounded 3 s) before the prompt, so the headers helper presents it as `x-liaison-turn`; without one the file is deleted (and the server reconnected when there was one). The file is deleted at exit | `index.ts` `applyTurnCredential` |
| interrupt the running turn | `{"type":"interrupt"}` | `index.ts:415-417` |
| answer a permission prompt | `{"type":"permission_response","requestId":"...","behavior":"allow"\|"deny","message"?}` (composed by `respond_permission`; `updatedInput` is never sent) | `index.ts:418-424` |
| call a Liaison MCP tool | `{"type":"mcp_call","requestId":"...","tool":"...","args":{...}}` | `index.ts:425-434` |
| change the permission mode | `{"type":"set_permission_mode","mode":"auto"\|"manual"\|"edit"\|"plan"\|"bypass"}` (composed by `set_permission_mode`; the mode is validated and the bypass question asked before it is composed) | `index.ts` control loop, onto the SDK's `Query.setPermissionMode` |
| end the session | `{"type":"shutdown"}` | `index.ts:435-437`, composed by the shell at `sidecar.rs:49` |

## Events (sidecar -> shell -> overlay, on `sidecar-line`)

| capability | line | emitted at |
|---|---|---|
| handshake | `{"type":"boot","protocolVersion":2,"cwd","cliPath"}` | `index.ts:378-383` |
| COLD START READY | `{"type":"ready","sidecarReadyMs","systemPromptChecksum"}` | `index.ts:457-461` |
| the resumable session id | `{"type":"session","sessionId"}` | `index.ts:467` |
| one SDK message | `{"type":"message","event":<class>,"payload":<SDK message>}` | `index.ts:470`, classes at `index.ts:152-166` |
| CANUSETOOL PROMPT | `{"type":"permission_request","requestId","toolName","input","suggestions"?}` | `index.ts:250-256` |
| an MCP relay answer | `{"type":"mcp_result","requestId","result"?,"error"?}` | `index.ts:433`, outcome shape at `sidecar/mcp-relay.ts:22-30` |
| the interrupt landed | `{"type":"interrupted"}` | `index.ts:417` |
| one turn ended | `{"type":"turn_done"}` | `index.ts:472` |
| the session failed | `{"type":"error","message"}` | the SDK loop's own catch. It is the SESSION failing, and a `done` line always follows it, so it is NOT a turn boundary: neither the shell nor the turn loop treats it as one (P6d-FX2, SK-3) |
| the process is finished | `{"type":"done"}` | `index.ts:484`. NOT the end of the window's session: a line carries no pid, and the child a new start replaces answers its shutdown line with `done` while the new session is already listening (2026-09-23: that `done` released the new session's claim and its answer was refused). The window ends a session only on the shell's `sidecar-exited`, which the shell sends for the child that is still the running session and no other |
| the server refused to renew the session's MCP token | `{"type":"mcp_token_refused"}` | the token keeper (`sidecar/mcp-token.ts` `startTokenKeeper`), once per session. Carries no token. The shell answers it with `liaison-reconnect-required` `TokenRefreshFailed` after forgetting that server's and agent's stored token (`sidecar.rs` `on_token_refused`) |
| the models the session's SDK offers | `{"type":"local_models","models":[{"id","label"}]}` | `index.ts` `announceLocalModels`, once per session, from `Query.supportedModels()` (part of the CLI's initialization answer: no turn, no second process). Nothing is said when the SDK cannot answer within 20 s; the window then keeps offering what it offered (the launch discovery's list, `liaison-sidecar --local-models` through `claude_local_models`, else its stored copy of the last list, else `DESKTOP_FALLBACK_LOCAL_MODELS`). The window re-validates the list (`parseLocalModels`) and refuses a start on any id not in it |
| the running session changed mode | `{"type":"permission_mode","mode":"..."}` | the control loop, after the SDK accepted it |
| the running session did NOT change mode | `{"type":"permission_mode_refused","mode":"...","reason":"..."}` | the control loop, when the query has no `setPermissionMode` (reason `SessionCannotChangeMode`) or refused the one it was given. A line of its own rather than an `error`, because `error` means the turn is over and this says nothing about the turn (P6d-FX2, SK-3, SK-4). The window remembers a mode only after the `permission_mode` line for it |

## The capabilities this slice needs, named against the real surface

- **Start a turn**: `send_turn`.
- **Turn event stream**: the Tauri event `sidecar-line`, one protocol 2 JSON line per emission,
  dispatched on `type`.
- **`canUseTool` prompt**: the `permission_request` line, answered through `respond_permission`
  with the SAME `requestId`, which the shell checks is still outstanding. The sidecar's broker fails CLOSED
  (`index.ts:220-276`): a host that never answers denies the tool, so an unanswered prompt is a
  denial and never a hang.
- **Cold start readiness**: the `ready` line. It is emitted once, on the first SDK message, and
  carries the measured `sidecarReadyMs`.
- **MCP relay**: `call_mcp_tool` (allowlisted) answered by `mcp_result`. The sidecar does NOT serialize these (it
  fires the relay without awaiting, `index.ts:425-434`), so the correlation by `requestId` is the
  TypeScript client's job, and so is a timeout.
- **Native folder dialog**: `pick_folder`.
- **Platform**: `platform_info`.
- **Deep link**: the Tauri event `liaison-deep-link`.

## Permission modes

`auto` (the default) | `manual` | `edit` | `plan` | `bypass` (`apps/desktop/sidecar/index.ts`
`PERMISSION_MODES`), passed to
`start_session` as `permissionMode`, and changed on a RUNNING session through `set_permission_mode`
(P6d-FX1: it used to be read once, at start, so a mid session change moved a pill and nothing else). In `bypass` the SDK never calls `canUseTool`, so NO
`permission_request` line is ever emitted: the mode switch has to say so, because a user who
expects prompts and gets none would read silence as a broken prompt path.

`auto` is NOT the SDK's own `auto` (the CLI refuses that on Claude Haiku 4.5 and
on plans without it). The SDK runs in `acceptEdits`, and the sidecar's broker
answers yes itself, emitting no `permission_request`, for every Liaison MCP tool
and every shell command that is not clearly destructive (`sidecar/auto-policy.ts`).
Everything else still asks. Liaison's server-side approvals for gated tools are
untouched: allowing the call creates the pending approval as before.

Every session is launched with `allowDangerouslySkipPermissions`, so a RUNNING
session can be switched to `bypass`: without it the SDK refused the switch
("the session was not launched with --dangerously-skip-permissions") and the
window reported "That permission mode was not applied". The shell's native
confirmation is still what gates entering Bypass.

## What `start_session` validates, and what it refuses with

The window is not a boundary: apps/web's own scripts reach `__TAURI_INTERNALS__`,
so every value `start_session` takes is checked in the shell before anything is
spawned (`sidecar.rs` `validate_start_request`). The refusals are VARIANTS, not
sentences: `sidecar-client.ts` maps each one onto copy from `desktop-copy.ts`
and throws it as a typed `StartSessionError` or `LocalFileError` carrying the
raw variant, so a variant this build has no words for still reaches the window
as a readable sentence rather than as a Rust identifier.

| variant | when |
|---|---|
| `UnknownPermissionMode` | `permissionMode` is not one of `auto` \| `manual` \| `edit` \| `plan` \| `bypass` |
| `CwdNotADirectory` | `cwd` is not a directory on this machine |
| `BypassDeclined` | the mode is `bypass` and the native confirmation was cancelled |
| `ModeDeclined` | the mode is `auto` or `edit` and the native confirmation was cancelled (D11: both run calls without asking each time, so a page script must not be able to start one) |
| `NoSession` | `read_local_file` with no session running |
| `OutsideSessionFolder` | the path does not canonicalize inside the running session's folder |
| `TooLarge` | the file is over 50 MB |
| `UnknownPermissionRequest` | `respond_permission` named an id that is not outstanding, or one already answered |
| `UnknownPermissionBehavior` | `respond_permission` named a behavior that is not `allow` or `deny` |
| `McpToolNotAllowed` | `call_mcp_tool` named a tool outside the shell's allowlist |
| `SidecarExited: <reason>` | the sidecar exited before its `boot` line (it refused its arguments, or crashed on start). `start_session` waits up to 30 s for that line; the text after `": "` is what the sidecar said, and `sidecar-client.ts` reads it as the refusal's `detail` |

The order is fixed: the mode is checked first, so an unknown one never reaches
the dialog, and the folder is checked before the user is asked about it, so the
bypass question is never asked about a path that does not exist. The bypass
confirmation is the shell's own native dialog, titled "Bypass permissions", and
it names the folder being handed over.

The reconnect reasons (`TokenRefreshFailed`, `ConfigUnwritable`,
`SidecarSpawnFailed`) also arrive as a rejected `start_session` promise, on top
of the `liaison-reconnect-required` event.

## The definition, the kind, and the isolated config

`agentDefinition` is the COMPOSED definition the window fetched from
`GET /api/agents/:id/definition` (`agent-definition-client.ts` composes the
route's four parts into one text). The shell writes it into the per session MCP
config, the sidecar appends it to Claude Code's own system prompt, and the
`ready` line's `systemPromptChecksum` is the sha256 of that exact text. There is
no second source: the shell reads no definition from its environment.

The four parts are `systemPrompt`, `skillIndex`, `scopedMemory` and
`mcpToolList`, and every one of them is an INDEX rather than content. The part
now called `skillIndex` used to be `skillBodies` and carried each skill's whole
body; `mcpToolList` used to carry the entire catalog with full descriptions,
which was about 60,000 tokens on a personal agent holding `*` and rode on every
local turn. `skillIndex` is a name and one line per skill, read with
`skill_read`; `mcpToolList` is the hot set only, with everything else reached by
searching tools, the same split the in-app turn makes. The composed text renders
them in that order, each under its heading and its preamble
(`SKILLS_PREAMBLE`, `TOOLS_PREAMBLE`), which is the same text the API measures
its budget over (`renderAgentDefinitionText`).

`agentKind` is `personal` \| `role` \| `system`, from the agents listing route
(the definition route carries no kind, so the window pays one extra round trip).
It decides one thing (A29): every kind except `personal` starts the sidecar with
`--isolate-config`, which runs the session on a private Claude Code config
directory under the app's data dir, carrying the operator's LOGIN across but
none of their own claude.ai connectors. A personal agent keeps them on purpose.
An unrecognised kind isolates: the only unsafe answer is the one that keeps the
connectors.

## The folder digest, and why it is salted

The audit trail names a folder by a digest and never by its path (A20). An
UNSALTED sha256 of a path is a dictionary lookup: a few hundred common paths
hash to known values, so the bare digest names the folder to anyone holding the
rows. `get_install_salt` gives this install 32 random bytes the shell creates
once and the server never sees, and `folder-hash.ts` hashes the salt together
with the normalized path. The same digest keys the resume store, so the salt is
stable for the life of the install: one that rolled would silently forget every
resumable session.

The same salt also names the INSTALL to the claim route, as a domain-separated
digest (`installClaimId` in `local-claim.ts`, 32 hex characters) and never the
salt itself: a window's holder key reads `d.<install>.<window>`, and a
registration from the same user on the same install supersedes that install's
previous live lease at once (`installOf` in `local-session-routes.ts`). That is
what a relaunch after a quit is; another install or another user still gets the
409, now carrying `sameUser`, `holderName` and `canTakeOver`.

## Reading a file the session produced

`read_local_file` is the only way the window gets bytes off this machine, and
its authority is the RUNNING session's folder and nothing else. The folder and
the requested path's DIRECTORY are canonicalized before they are compared, so a
`..` walk, a symlinked parent and a sibling directory whose name starts with the
folder's are all `OutsideSessionFolder`.

The checks are then made against an OPEN HANDLE rather than against the name. A
path that is checked and then opened is looked up twice, and the agent is
running commands in that same folder: anything that can write there can swap the
name between the two lookups. So the file is opened first, with no symlink
followed at the final component (`O_NOFOLLOW` on unix), and "is this a file" and
"how big is it" are asked of the handle. A symlink at the requested path is
refused whichever way it points, inside the folder included: a name the window
may read is a file, not a second lookup. Windows has no equivalent flag, so
there the link is caught by asking the name, which is the weaker check and is
recorded as such.

The bytes come back base64 framed with a content type guess, because the window
posts them whole to the upload route; anything over 50 MB is `TooLarge`.
