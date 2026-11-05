# `.liaisonapp` Package Format

A `.liaisonapp` is the distributable artifact for a Liaison app — a gzipped tar
archive with a fixed file layout. It is consumed by the admin UI's install
dialog and `liaison config apply`'s apps provisioning, both of which call the same
`/api/apps` HTTP routes.
`bun run app:freeze` produces it from an in-tree app directory.

The format is **versioned** (`packageFormat: 1`). A breaking change to the layout
bumps the major version; the install service rejects any version it does not
recognize.

The canonical schema lives in code at
`packages/app-sdk/src/package-format.ts` (`packageManifestSchema`,
`REQUIRED_FILES`, `LIAISON_APP_VERSION`). This document is the human-readable
companion — keep the two in sync.

## Archive layout

```
my-app-1.0.0.liaisonapp                 (gzipped tar — the package)
├── app.manifest.json          REQUIRED — app metadata + schema + tools
├── bundle.js                  REQUIRED — built backend handler bundle
├── ui.js                      optional — built frontend panel bundle
├── templates/<name>.js        optional — one file per declared pdf_templates[] entry,
│                              transpiled from its TS source at freeze time
├── README.md                  optional
├── CHANGELOG.md               optional
└── LICENSE                    optional

my-app-1.0.0.liaisonapp.cosign.bundle   (detached cosign signature — sibling file)
```

- **Required files** (`app.manifest.json`, `bundle.js`) — verification fails if
  either is absent.
- **`ui.js`** — present only if the app ships a frontend panel.
- **Signature** — `bun run app:sign` produces a **detached** `<package>.cosign.bundle`
  *next to* the tarball; the tarball itself is never modified. Embedding the
  signature would require re-taring after signing, changing the bytes the
  signature was computed over. Distribute both files together: a package
  published at `<url>` is signed by `<url>.cosign.bundle`, and the install
  service fetches both.

## Manifest schema

`app.manifest.json` in a `.liaisonapp` is validated against
`packageManifestSchema`. It is **stricter** than the runtime
`app.manifest.json` schema used for in-tree apps:

| Field | Required | Notes |
|---|---|---|
| `name` | yes | kebab-case, starts with a letter |
| `version` | yes | semver |
| `packageFormat` | yes | must equal `1` |
| `license` | yes | SPDX identifier — installed apps run on someone's server |
| `scopes` | yes | array of `app:resource[:action]` strings the app requests |
| `displayName` | no | human-friendly name shown in the admin UI |
| `description` | no | one-line summary |
| `author` | no | publisher name |
| `homepage` | no | URL |
| `iconSvg` | no | the app's icon as SVG markup, at most 8 KB of plain drawing elements; see "App icon" below |
| `iconName` | no | the app's icon as the name of an icon in Liaison's icon set; see "App icon" below |
| `host` | no | semver range of the host API the app needs, e.g. `"^1"` (the default when absent) — see "Host API version" below |
| `noRollback` | no | `true` marks a first-party security release: once it runs, a rollback never goes below it (ignored on other packages) — see "Versions on the server" below |
| `updateUrl` | no | release-channel URL — see below |
| `connections` | no | OAuth2 / credential connections the app declares |
| `trusted` | no | **must be `false` or omitted** — see "Trust" below |
| `capabilities` | no | array of opaque capability strings gating privileged runtime calls (e.g. `pdf.render`) |
| `pdf_templates` | no | array of `{ kind, source }` declaring PDF templates the app ships; `source` is a relative `.ts` path transpiled into the package's `templates/` bundle at freeze time. Requires `pdf.render` in `capabilities` |
| `cross_app_calls` | no | array of `{ target, reason }` declaring cross-app tool invocations (`target` is `appname:tool.name`); must agree with `dependencies.tools` when both are present |
| `slots` | no | UI slot contributions (e.g. `contact_detail.panels[]`, `<app>.document_detail.tabs[]`) mounted into other apps' pages |
| `dependencies` | no | `{ tools: string[] }`, the canonical form of declared cross-app tool dependencies; synthesized from `cross_app_calls` when only that is declared |
| `listing` | no (yes for a catalog or registry entry) | the App store listing, see "Store listing" below; when present, `license` must be an SPDX expression |

### Example

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "packageFormat": 1,
  "displayName": "My App",
  "description": "Does a useful thing",
  "author": "Acme Corp",
  "license": "MIT",
  "homepage": "https://example.com/my-app",
  "host": "^1",
  "updateUrl": "https://apps.example.com/my-app/latest.liaisonapp",
  "scopes": ["my-app:items:read", "my-app:items:write"]
}
```

## Host API version (`host`)

The host API is everything an app relies on from the server it runs in: the
manifest shape, the sandbox bridge, the frame protocol and the host services.
It has one semver version (`HOST_API_VERSION` in `@liaison/host`); a change an
app could notice as a break bumps the major, an addition bumps the minor.

An app declares the range it needs as `host` (`"^1"` when absent). The server
refuses to install or upgrade an app whose range its host API version does not
satisfy, and an installed app whose range it does not satisfy is not loaded and
shows as errored in the App store, with the reason:

```
my-app 2.0.0 needs host API ^2; this server provides host API 1.1.0. Update Liaison first.
```

Host API 1.1 added `currentPath()` (the page's path and query, which an app
whose UI runs framed cannot read from its own `location`), the frame's `path`
message, and in-app links and `history.pushState` in a frame moving the page.

`GET /api/apps/host-api` (public, no credential) answers the host API majors a
server supports: `{ "data": { "majors": [1] } }`.

`sdkVersion` and `minLiaisonVersion` are ignored. Older packages that carry them
still parse.

## Versions on the server

The server keeps two versions of an installed app: the one that runs and the one
that ran before it. Older versions are deleted.

A new version goes live without a restart. Before it counts as running, the
server checks it: its handler and interface bundles load, it registers in every
workspace where the app is on, and its tools are there, within 30 seconds. A
version that fails the check is replaced by the previous version, and the
reason is recorded. A first install that fails the check is not installed.

A first-party app (one shipped in Liaison's own app catalog) sets
`"noRollback": true` on a release that fixes a security problem: once it runs,
the server never goes back below it on request. The flag is ignored on any
other package. A security release that fails its check is still replaced by the
previous version, and the failure is recorded.

`GET /api/apps` lists, for an installed app, the `previousVersion` a rollback
returns to (while its files are still on the server) and `noRollback: true` when
the running version refuses one. `POST /api/apps/:name/rollback` and
`liaison app rollback <name>` make the previous version the active one again.

### The additive data rule

A new version may add tables, columns and enum values. It may not take anything
away from the data the running version keeps, so the previous version can
always run again on it. The install and the upgrade check every package that
differs from the running one (a newer version, the same version rebuilt, or a
deliberate downgrade) and refuse one that:

- drops or renames a table or a column;
- changes a column's type;
- removes a value from an enum, or turns a free column into an enum;
- makes an existing optional column required;
- drops or changes a unique constraint (a partial one's condition included);
- adds a unique constraint on existing columns, or on a new column that every
  existing row fills with the same default.

When the running version's manifest cannot be read, the check cannot run and
the package is refused.

The refusal lists what would be lost:

```
Cannot move 'my-app' from 1.0.0 to 2.0.0: the new version would lose data the running version keeps. A new version may only add tables, columns and enum values. Would be lost: column notes.body is dropped.
```

## Where an app's interface runs

An app from outside Liaison (anything but the image's own catalog artifact)
always runs framed: in the browser, the desktop app and the phone, its `ui.js`
renders in a sandboxed iframe with an opaque origin (no session cookie, no
storage, no network of its own), never in Liaison's page. The frame protocol is
the whole API: `@liaison/host` (`fetch` on the app's own and kernel paths,
`invokeTool` for its own tools, connection flows, `navigate` to its own routes
and settings, entity changes, toasts) answered by the page for that app only.
Anything else a page could offer (drawing into the page, another app's slot,
entity previews, app hooks, the user's token) is out of reach, and a call to a
method the host does not have is answered `unsupported` at once. Liaison's own
apps run in the page in a browser, and in the desktop app once it verified their
signed release (below).

## App icon (`iconSvg`, `iconName`)

An app's icon is data, never code. A framed app (an installed app whose
interface runs in the sandboxed frame) cannot draw into the page, so the host
draws its icon in the activity bar, the tab strip and the settings nav from one
of these fields:

- `iconSvg`: SVG markup, at most 8 KB. Only plain drawing markup is accepted:
  the elements `svg`, `g`, `path`, `circle`, `rect`, `line`, `polyline`,
  `polygon`, `ellipse`, `defs`, `linearGradient`, `radialGradient`, `stop`,
  `title`; geometry, `fill`/`stroke` and their opacity, width, linecap,
  linejoin, dashes and rules, `opacity`, `viewBox`, `xmlns` (required on the root, `http://www.w3.org/2000/svg`),
  `transform`, `id`, `offset` and `stop-color`. A paint may reference a gradient
  of the icon's own (`url(#id)`). No `style`, no `<style>`, no `href`, no `on*`
  handler, no `foreignObject`, `script`, `image` or `use`, no comments or
  declarations other than a leading `<?xml ...?>`. Nothing is stripped: an icon
  that breaks a rule is refused at install, upgrade and registration, and the
  error names what was found. The client checks it again and never puts it in
  the page as markup: an icon drawn in `currentColor` takes the colour of the
  place it sits in (the activity bar tints each app), any other is shown as an
  `<img>`.
- `iconName`: the name of an icon in Liaison's icon set (`APP_ICON_NAMES` in
  `@liaison/shared`, for example `gauge`, `bar-chart`, `truck`, `wallet`).

`iconSvg` wins when both are set. With neither, the host draws a tile with the
first letter of the app's name. `views.activityBar.icon` stays the export name of
an icon component, used when the app's interface runs in the page.

## Store listing (`listing`)

An app shown in the App store, from the image's catalog or from a registry,
carries a listing. An app installed from a URL may omit it and shows as
"Unlisted". The listing reuses the manifest's `displayName`, `description`,
`author` and `license`, and adds:

| Field | Required | Notes |
|---|---|---|
| `category` | yes | one of `Support`, `Communication`, `Commerce`, `Finance`, `Marketing`, `Operations`, `Knowledge`, `Productivity`, `Developer` |
| `icon` | yes | a [lucide](https://lucide.dev/icons) icon name in kebab-case, e.g. `ticket` |
| `summary` | yes | one line for the store row (160 characters at most) |
| `sourceRepository` | yes | https URL of the app's public source |
| `publisher` | no | who publishes the app, when it differs from `author` |
| `screenshots` | no | up to 8 https image URLs, shown as plain images |

Every listed app is source-available: a listing without `sourceRepository`, or
on a manifest whose `license` is not an SPDX expression (`UNLICENSED`,
`NOASSERTION` and `NONE` are refused), is invalid. Listings carry no price: a
`price`, `pricing` or `plan` key anywhere under `listing` is refused.

```json
"listing": {
  "publisher": "Acme Corp",
  "category": "Productivity",
  "icon": "list-checks",
  "summary": "Track the useful things your team does.",
  "sourceRepository": "https://github.com/acme/my-app"
}
```

## App registry (`LIAISON_APP_REGISTRY_URL`)

The App store lists the apps baked into the image and, when
`LIAISON_APP_REGISTRY_URL` is set, those of a registry: an `index.json` served over
https. Liaison ships no registry server; any static host works. The index is:

```json
{
  "apps": [
    {
      "name": "my-app",
      "version": "1.0.0",
      "displayName": "My App",
      "description": "Does a useful thing",
      "kind": "app",
      "license": "MIT",
      "author": "Acme Corp",
      "listing": { "category": "Productivity", "icon": "list-checks", "summary": "Track the useful things your team does.", "sourceRepository": "https://github.com/acme/my-app" },
      "packageUrl": "https://apps.example.com/my-app/my-app-1.0.0.liaisonapp",
      "scopes": ["my-app:items:read"]
    }
  ]
}
```

- Each entry needs a valid listing and SPDX `license` (see "Store listing"), and an
  https `packageUrl`; an entry that fails is left out of the store and logged.
- A name the image also bakes shows the baked (first-party) app.
- A registry app installs like a URL install: the package (and its
  `<packageUrl>.cosign.bundle`) is downloaded through the SSRF-safe fetch, verified by
  the signature policy below, and installed only after the consent screen grants its
  scopes. The one-click catalog install refuses it.
- If the registry cannot be read, the store still lists the baked apps and
  `GET /api/apps/catalog` returns `notice: "registry_unreachable"`.

`GET /api/apps/catalog` (scope `kernel:apps:admin`) returns
`{ apps: [{ name, displayName?, description?, version, kind?, license?, author?, listing?,
scopes, source: "baked" | "registry", packageUrl?, installed, installedVersion? }], notice? }`.

## Trust

Installed apps are **always sandboxed** (process-isolated worker). The `trusted`
flag — which lets in-tree apps run in the faster in-process sandbox — is reserved
for the platform maintainers. A `.liaisonapp` manifest that declares
`trusted: true` is rejected by the schema, by the freeze tool, and the install
service force-coerces it to `false` regardless. There is no way for a
third-party app to escalate out of the sandbox.

## Reserved names and labels

An installed app cannot present itself as a first-party app or as one of
Liaison's own pages. The install and upgrade refuse a package, other than the
image's own catalog release of that app, whose `name`, `displayName` or
`views.activityBar.label` matches, ignoring case, spaces, hyphens and
underscores:

- the name, display name or rail label of a first-party app (an app built into
  the server or shipped in the image's app catalog);
- a system label: Settings, Security, Users, Roles, App store, Connectors, Home,
  Chats.

The error names the field and the value, for example
`Cannot install 'my-app': its activity-bar label 'Settings' is reserved for a Liaison system page.`

The App store page of every app names its publisher: the listing's `publisher`,
or, for an app installed without a listing, the manifest's `author`.

## Tab routes (`views.tabTypes.*.urlPattern`)

A tab type's `urlPattern` decides which page URL opens the tab, and a framed app
may navigate to, and is told the path of, the pages that open its own tabs. So
the first segment of every pattern must belong to the app. The install, the
upgrade and the server's start-up registration refuse an app whose tab pattern:

- starts with a parameter (`/:a/:b`) or is `/`;
- sits under one of Liaison's own pages (`/settings/...`, `/detail/...`,
  `/threads/...`, `/login/...` and the rest of the reserved routes);
- sits under another app: its name (`/mail/:id`) or the first segment of a tab
  pattern another app already declares.

Use `/<your app name>/...`, the default when `urlPattern` is left out
(`/<app>/<tab type>/:entityId`). A second prefix of your own, such as
`/my-app-catalogue/:entityId+`, is allowed while no other app owns it. The
error names the pattern, for example
`Cannot install 'my-app': its tab urlPattern '/mail/:entityId' is under '/mail', which belongs to the app 'mail'.`
The web shell skips such a tab of an installed app as well.

## Regular expressions in a manifest

Patterns your manifest declares run on the server: a tool parameter's JSON
Schema `pattern` or `patternProperties`, a settings field's
`validation.pattern`, and a connection's `templateVars.*.pattern` and
`authorizeConfigParams.*.pattern`. The install refuses a pattern longer than 512
characters or one whose matching time is not linear in the input, such as
`^(a|a)+$`, `(\d+)*` or `\d*\d*\d*!`: a repeated part must not be able to match
the same text in two ways. The error names the pattern and where it sits.

## Update channel (`updateUrl`)

`updateUrl` must be a **stable** URL that always serves the most recent
`.liaisonapp` build of your app — e.g.
`https://apps.example.com/my-app/latest.liaisonapp`, or a GitHub Releases
"latest asset" URL. It is what the upgrade action re-fetches, whether triggered
from the admin UI or from `POST /api/apps/:name/upgrade/preview` and
`.../upgrade/apply`.

Do **not** point it at a version-pinned artifact
(`my-app-1.0.0.liaisonapp`) — that would make every upgrade a no-op. A
version-pinned URL is fine for the *first* install; the install service reads
`updateUrl` out of the manifest and stores it separately (in
`kernel.apps_installed.update_url`) as the upgrade source.

If you omit `updateUrl`, your app is **install-only**: operators must re-run
the install with a new URL by hand to update it, and the upgrade preview
reports "no update channel".

## Signing & verification

`bun run app:sign my-app-1.0.0.liaisonapp` signs a package with cosign keyless
signing — the same trust model as the platform container image. The signature
is written to a **detached sibling file**, `my-app-1.0.0.liaisonapp.cosign.bundle`;
the tarball is not modified. Publish both files together — the install service
fetches `<url>` and `<url>.cosign.bundle` side by side.

At install time, the server can require a valid signature
(`LIAISON_REQUIRE_APP_SIGNATURE=true`, the production default) and constrain the
accepted publisher via `LIAISON_TRUSTED_APP_PUBLISHERS` (a regex matched against
the cosign certificate identity). An unsigned package, or one signed by an
untrusted publisher, is rejected.

## Signed first-party artifacts

Liaison's own apps (the `bundled-apps/` of a release) are also published as
**signed artifacts**, so a desktop or phone shell can check that the interface
it is about to run is exactly what Liaison released. This is separate from the
cosign signature above: it uses Liaison's own Ed25519 app-signing key, and only
its public half is in the source (`packages/shared/src/app-signing/keys.json`, read
by `keys.ts` and compiled into the desktop app; a list so the key can be
rotated). Until a key is listed there, nothing verifies and every app runs as an
unsigned app.

Each `<name>@<version>` is published under `apps/<name>/<version>/` on
`downloads.liaison.sh` as five files:

| File | What it is |
|---|---|
| `<name>-<version>.liaisonapp` | the package, as described above |
| `ui.js` | the package's `ui.js`, byte for byte |
| `manifest.json` | the package's `app.manifest.json`, byte for byte |
| `statement.json` | the signed statement below |
| `statement.sig` | base64 Ed25519 signature over the exact bytes of `statement.json` |

`statement.json` is canonical JSON (UTF-8, keys sorted at every depth, no
whitespace, no trailing newline):

```json
{"hostApi":"^1","issuedAt":"2026-10-26T12:00:00.000Z","keyId":"app-0123456789abcdef","name":"boxtal","sha256":{"manifest":"<hex>","package":"<hex>","ui":"<hex>"},"sourceDigest":"<hex>","v":1,"version":"0.15.3"}
```

- `keyId` names the signing key: `app-` and the first 16 hex characters of the
  sha256 of its raw 32-byte public key.
- `hostApi` is the manifest's `host` range; `name` and `version` are the
  manifest's.
- `sha256` holds the hex sha256 of `ui.js`, `manifest.json` and the package.
- `sourceDigest` is the sha256 of the app's source directory: for each file,
  sorted by its `/`-separated path relative to `bundled-apps/<name>/`, the line
  `<path>\0F<hex sha256 of the file>\n` (a symlink: `<path>\0L<target>\n`),
  leaving out `node_modules`, `dist`, `bun.lock`, `.git`, `.gitignore`,
  `.dockerignore`, `.DS_Store`, `coverage`, `.turbo`, `.cache`, `.vite`,
  `test-results`, `logs`, `.chaos`, `*.log` and `.env*` (but not
  `.env.example`). `bun run scripts/app-signing/source-digest.ts <name>` prints it.

A verifier refuses the artifact unless all of this holds: the statement bytes
are canonical, the signature verifies with the listed key named by `keyId`, the
statement's name and version are the ones being loaded, every hash matches, the
manifest's name, version and `host` agree with the statement, and `ui.js` is a
**single-file ES module**: no `import()`, no `import.meta`, and every `import`
or `export ... from` names only `solid-js`, `solid-js/web` or `solid-js/store`
(the host's import map). The signing tool refuses to sign any other bundle.
That rule is a text scan, not a sandbox: code built at run time (a `blob:`
worker, a WebAssembly module, `new Function`) passes it. Reviewing a first-party
app before its release is signed must reject any bundle that loads or builds code
at run time.

The release signs an artifact with
`bun run scripts/app-signing/sign-artifact.ts <dir> --key <pem>` (an Ed25519
PKCS#8 key; `--public-key` prints the `keys.ts` entry for it). It reads the
package in `<dir>`, writes `ui.js` and `manifest.json` from it, and writes
`statement.json` and `statement.sig` after checking its own output.

`apps/index.json` lists what is published:
`{"v":1,"apps":[{"name","version","sourceDigest"}]}`. A Docker build looks an
app up there by name, version and source digest (see
[Run Liaison with Docker](self-hosting/docker.md#use-signed-first-party-apps)).

### Revoked versions

`apps/revocations.json` (with `apps/revocations.json.sig`, signed by the same
key) lists versions that must no longer run in a shell's page:
`{"v":1,"seq":<n>,"issuedAt":"...","entries":[{"name":"boxtal","below":"0.15.0"},{"name":"invoicing","versions":["0.19.1"]}]}`,
canonical JSON like the statement. `below` compares versions as semver does,
pre-release included (`1.0.0-rc.9` is below `1.0.0-rc.10`). `seq` only grows: a client keeps the highest
it has seen and ignores an older list. Each client release also carries a
compiled floor (`REVOCATION_FLOOR`). A revoked or below-floor version runs only
in the sandbox frame.

### How the desktop app uses them

A server whose catalog took the signed artifact lists the app with
`signed: true` in `/api/apps/manifests` and serves `statement.json`,
`statement.sig` and `manifest.json` beside `ui.js` at
`/api/apps/<name>/<version>/`. The desktop app fetches all four from the
server it is connected to (never following a redirect), runs every check above
plus the revocation floor and the latest signed revocation list it has seen
(fetched from `downloads.liaison.sh` at most once an hour), keeps the verified
bundle in its data folder (the last 3 versions per app) and runs exactly those
bytes in its page. It serves a bundle only after checking it in the same run, so
a file left from an earlier run is checked again first. It keeps the highest
revocation `seq` it ever accepted and never goes back below it; if the list it
keeps is damaged, it runs Liaison's apps framed until a newer signed list
arrives. Anything else runs the app in the sandbox frame. The phone
app does not verify: it runs every app in the frame.

`liaison app verify` checks a signed artifact directory or package
([config as code](provisioning-cli.md)).

See `docs/app-development.md` for the end-to-end developer journey and
`docs/app-sandbox.md` for the sandbox runtime internals.
