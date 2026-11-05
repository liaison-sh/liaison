# Google Drive — the reference *headless app*

A **headless app** is a backend-only Liaison app: it has a manifest, connections,
agent tools, jobs and an export — but **no frontend**. It exists to connect the
platform to an external system and to give agents tools over it. Google Drive is
the first one; this README is the pattern other connectors (Dropbox, S3, Notion,
…) should copy.

## What's here

| File | Role |
|------|------|
| `app.manifest.json` | The app contract — `connections`, `tools`, `roles`, `export`. No `views`, no `schema`, no `entities` — a connector owns no UI and (here) no app tables. |
| `manifest-descriptor.ts` | Wraps the manifest with host wiring: `_format`, `_bundlePath` (→ `handlers.ts`), `_bridgeExtension`. No `_oauthClientResolvers`: the one resolver picks Drive's client. |
| `handlers.ts` | The **sandboxed** manifest handler bundle. Thin tool handlers + the export handler — resolved by manifest export name. |
| `tools.ts` | **Host-side** tool logic — OAuth'd Drive REST calls, `kernel.files` materialisation, the export query. |
| `drive-rest.ts` | Typed Google Drive REST v3 IO (`makeDriveFetchers`). |
| `adapter.ts` | Knowledge federated-search source adapter (the app's original role). |

## The three-layer tool architecture

Manifest tool handlers **always run in the QuickJS sandbox** — they cannot touch
the DB, secrets, or object storage directly. Host work happens behind the
rpc-bridge. So every Drive agent tool flows through three layers:

```
manifest tool  ──►  sandboxed handler   ──►  rpc-bridge method   ──►  host logic
(app.manifest)      (handlers.ts)            (rpc-bridge.ts:           (tools.ts)
                                              drive_search/import/export)
```

1. **`app.manifest.json` → `tools`** declares `search` / `import`, each naming a
   `handler` export and its `requiredScopes`.
2. **`handlers.ts`** — the sandboxed handler is a one-liner: it JSON-bridges to a
   `drive_*` rpc-bridge method. No business logic, no host access.
3. **`rpc-bridge.ts` → `drive_search` / `drive_import` / `drive_export`** —
   host-side methods, gated to the `google-drive` app via `requireApp`. They
   resolve the OAuth token (`getTokenForConnection`) and call into `tools.ts`.
4. **`tools.ts`** — the real logic, with full host access (DB, object storage,
   the Drive REST layer). The OAuth token is **injected** as `ctx.driveToken`,
   so these functions carry no connection-lookup plumbing and unit-test cleanly.

This mirrors how `tickets` splits its sandboxed `handlers.ts` from host logic —
it is the established pattern, not a Drive special case.

## How it plugs into the agent file-attachment system

`drive_import` is what makes a Drive file *attachable*:

1. Resolve the org's Drive OAuth token.
2. `getMetadata` → reject native Google Docs/Sheets/Slides (no binary form) and
   executable/script types (the shared denylist).
3. `downloadBytes` — stream the file under a hard size cap.
4. Materialise it as a `kernel.files` row anchored to a per-user
   `file_upload_session` — the kernel's existing staging primitive for a file
   not yet attached to any entity. Quota is enforced like a human upload.

The returned `fileId` is an ordinary `kernel.files` id. The agent feeds it
straight into any send tool's `attachments` parameter (`mail.reply`,
`tickets.reply`, `threads_reply`); `attachFileToParent` then copies it onto the
destination exactly like a native file. The connector needs **zero** knowledge
of mail/tickets/threads — it just produces `kernel.files` rows.

## Building another headless connector

1. **Manifest** — declare `connections` (OAuth/credentials), `roles`, `tools`,
   and optionally `export`. Omit `views`/`schema`/`entities` unless the connector
   genuinely owns UI or tables.
2. **`manifest-descriptor.ts`** — add `_bundlePath` pointing at your `handlers.ts`
   and any `_oauthClientResolvers`.
3. **`handlers.ts`** — one thin sandboxed handler per tool, each delegating to a
   bridge method. Keep it logic-free.
4. **rpc-bridge** — add host `<app>_*` methods gated with `requireApp(...)`.
5. **`tools.ts`** — the host logic. Inject external credentials/tokens through
   the ctx so the logic is testable without connection plumbing.
6. To make external files attachable, materialise them into `kernel.files` (a
   `file_upload_session` parent works for transient imports) and return the id.

A headless connector that owns a handler bundle also owns its **export** handler
in that bundle (see `exportGoogleDrive`) rather than a kernel built-in.

## Connecting

Read [`docs/connecting-apps.md`](../../../../../docs/connecting-apps.md) first —
it covers the shared OAuth machinery (callback URL, client resolution, ownership,
token refresh). This section is the Google-Drive-specific runbook.

**Connection:** one `oauth2` connection named `drive`. Scopes requested:
`openid email profile` + `drive.readonly` (search/read/import) +
`drive.file` (upload into the app-created "Liaison Reports" folder only —
`drive.file` never touches your pre-existing files, so it is a **non-sensitive**
scope and needs no Google verification).

### What the connection needs, and where each part comes from

| Thing | Where it comes from |
|---|---|
| OAuth client id + secret | A Google Cloud project you own, picked by the one resolver (`modules/apps/connections/oauth-client.ts`): (1) the workspace's own client, the `kernel.oauth_providers` row `google-drive:drive` (`PUT /api/connections/google-drive/drive/oauth-client` or the Settings OAuth dialog); else (2) the instance's client, env `GOOGLE_DRIVE_OAUTH_CLIENT_ID` / `GOOGLE_DRIVE_OAUTH_CLIENT_SECRET` (both or neither; not `GOOGLE_OAUTH_*`). Each account keeps the client that minted its tokens; accounts connected before that was recorded refresh in the old order (env first, then the row). |
| The user's Drive access | Granted at consent time when the operator clicks Connect. Stored encrypted; refreshed automatically. |

### Provisioning steps (once per workspace)

1. In Google Cloud Console, pick/create a project and create an **OAuth 2.0
   Client ID** of type *Web application*.
2. Add `${BASE_URL}/api/connections/callback` to the client's **Authorized
   redirect URIs**. Exact scheme + host — a mismatch is `redirect_uri_mismatch`.
3. **Enable the Google Drive API** on that project
   (APIs & Services → Library → Drive API → Enable). Skipping this is the
   `accessNotConfigured` 403 below.
4. Set the **consent screen audience** (Google Auth Platform → Audience):
   - **Internal** — only members of the Google Workspace that *owns the GCP
     project* can connect. Simplest if the Drive account is in that same
     workspace.
   - **External + Testing** — anyone can connect, but only accounts you add as
     **test users** will pass consent. Use this for a Drive account outside the
     project's workspace.
5. Provision the client id/secret (env vars, or `PUT …/oauth-client`), then
   click **Connect** in Settings.

**Ownership:** for a shared company Drive that agents must reach, connect it
**org-owned** (`mode: "org"`, needs `google-drive:accounts:admin`). A user-owned
Drive returns `not_connected` for everyone else — see the isolation note in the
central doc.

### Failure modes (upload path, `tools.ts` → `mapDrive403`)

| Error code | What Google said | Fix |
|---|---|---|
| `drive_scope_missing` | `insufficientScopes` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, or an unparseable 403 | Reconnect Drive so it re-grants `drive.file`; then retry. Reconnecting is the fix — the granted token lacks the write scope. |
| `drive_storage_full` | `storageQuotaExceeded` | Free up (or upgrade) the Google account's Drive storage. **Reconnecting will not fix this.** |
| `drive_rate_limited` | `userRateLimitExceeded` / `rateLimitExceeded` | Wait ~1 minute and retry. |
| `drive_permission_denied` | any other 403 — Google's `reason` is echoed **verbatim** | Read the reason. `accessNotConfigured` → the Drive API is not enabled on the client's GCP project (step 3). Other reasons: fix the named permission on the Google side. |
