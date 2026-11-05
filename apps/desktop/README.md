# Liaison desktop

The Tauri shell (`src-tauri/`), the Bun compiled Agent SDK sidecar (`sidecar/`),
and the webview overlay (`src/`).

## What the app is made of

- **The shell** is Rust. It owns the session: it refreshes the Liaison token,
  writes the per-session MCP config 0600, spawns the sidecar and forwards its
  stdout lines to the webview as Tauri events.
- **The sidecar** is one compiled binary per target triple, hosting the Claude
  Agent SDK. It is a session process: control lines in, JSON event lines out
  (protocol 2).
- **The Liaison MCP token outlives nothing on its own.** It lives 15 minutes and
  a session can run for hours, so the CLI is never handed a static header: it
  gets a `headersHelper`, which is the sidecar binary again in
  `--print-mcp-headers` mode (`sidecar/mcp-token.ts`). The CLI runs it when it
  connects and again when a Liaison call comes back 401, and it renews the token
  through `/mcp/oauth/token` with the refresh token the shell stored for this
  server and agent. The sidecar also renews ahead of expiry, and when the server
  REFUSES a renewal (the connection was revoked) it says `mcp_token_refused`: the
  shell forgets that stored token and raises `TokenRefreshFailed`, whose
  Reconnect runs a new device approval.
- **The webview** serves `apps/web`'s Vite build unmodified. apps/web is frozen
  for this slice. Everything the desktop adds is in `src/`, built into ONE
  self contained script and injected into that page as a Tauri
  `initialization_script`.

## Build order (both generated inputs come before any Rust build)

Tauri refuses to build (even `cargo check`) when an `externalBin` is missing,
and `main.rs` compiles the overlay in with `include_str!`, so two JavaScript
builds run first:

```
bun run build:overlay            # src/overlay.tsx  -> dist/overlay.js
bun prepare-sidecar.ts           # sidecar          -> src-tauri/binaries/
bunx tauri build                 # or `cargo check`, `cargo test`
```

Both outputs are generated and neither is committed. `src-tauri/build.rs`
writes a placeholder `dist/overlay.js` when the first step was skipped, and
says so as a `cargo:warning` and in the running app's console, rather than
failing with a bare `include_str!` path.

### The sidecar is never reused stale

`bun prepare-sidecar.ts` rebuilds the sidecar whenever what it is built from
changed, and only then. It hashes every file under `sidecar/` (tests, `dist/`,
`.entries/` and `node_modules/` excluded), the repository's `bun.lock`, the
installed SDK and platform CLI versions, the Bun version and the target, and
keeps that hash as a stamp beside each binary it produces or installs:
`sidecar/dist/.stamps/` and `src-tauri/binaries/.stamps/`, outside the
`liaison-sidecar-*` names the release signs. A binary whose stamp is not the
current hash, or that has no stamp, is compiled and installed again; one whose
stamp matches is left byte for byte, so a sidecar signed in place stays
signed. `--force` recompiles regardless (the release uses it).

`src-tauri/build.rs` refuses to build the shell when any of those inputs is
newer than the installed stamp, with a message naming the file and saying to
run `bun prepare-sidecar.ts`. Cargo runs it for `tauri build`, `cargo build`,
`cargo check` and `cargo test` alike, so none of them can bundle a sidecar
compiled before the change it was meant to carry. This happened: a long lived
checkout kept shipping a sidecar compiled hours earlier, which refused the new
`--permission-mode auto` and died on every start.

## Tests

| command | what it runs |
| --- | --- |
| `bun run ../../scripts/test-run.ts desktop` | the bun half: the shell's own TypeScript, the capability and config pins, and the sidecar's pure modules |
| `bun run test:ui` | the overlay's Solid components, under vitest + jsdom |
| `cargo test` (in `src-tauri`) | the shell's Rust units |

A bare `bun test` in `apps/desktop` FAILS, and it is not the code: bun has no
Solid JSX transform, so it chokes on everything under `src/`. The two halves
are separate on purpose. Run `src/` through `bun run test:ui` (a single file
with `bun run test:ui src/onboarding/FirstLaunch.test.tsx`) and everything else
through the `desktop` suite above, which globs the root, `sidecar/` and
`ci/` test files. A single bun file still works on its own, for
instance `bun test capabilities.test.ts`.

From the repo root both halves are suites: `bun run test:desktop` and
`bun run test:desktop:ui`, and a full run executes them in that order.

`bun scripts/check-desktop-no-node.ts` is the no-Node gate: nothing that ships
inside the app may need a Node runtime. The overlay's build and test tooling is
recorded in that script's `BUILD_ONLY_TOOLS` with a reason; `solid-js` itself
ships inside the bundle and declares no `engines.node` at all.

## When an update does not arrive

Every step of an update goes to `updater.log`, beside `sidecar.log` in the
same directory (table below): the check and its answer, the user's yes or no,
the download, the Smart App Control and signature check on Windows, the
installer's path and pid, and any failure. On Windows the installer appends
its own lines to the same file (`[installer <version>]`, local time): its
command line, the processes it stopped in the install directory, and the
install. A failure is also shown to the user in a dialog; the app keeps
running on the version it has. See the header of `src-tauri/src/updater.rs`
for the 2026-09-28 incident this came from.

## When the local assistant stops

The sidecar's stderr is written to a log file in the app's log directory, in
release and debug builds alike, one line per stderr line, stamped with the UTC
time and the sidecar's pid, plus a line when it starts (its arguments) and
when it exits (code or signal, before or after its boot line, expected or
not). The file rotates to `sidecar.log.1` past 2 MB. Bearer tokens are struck
out before anything is written.

| OS | file |
| --- | --- |
| macOS | `~/Library/Logs/sh.liaison.desktop/sidecar.log` |
| Windows | `%LOCALAPPDATA%\sh.liaison.desktop\logs\sidecar.log` |
| Linux | `~/.local/share/sh.liaison.desktop/logs/sidecar.log` |

Builds up to 0.1.19 shipped under a legacy bundle identifier
(`LEGACY_IDENTIFIER` in `src-tauri/src/identifier_migration.rs`) and kept their
logs, settings and webview storage under that name. The first launch of a
later build copies those directories across once and leaves the originals in
place (steps in `updater.log`), so older logs are still in the directory named
after the legacy identifier.

What the user sees when it stops:

- **It dies before its first line** (it refused its arguments, or crashed on
  start): `start_session` waits for the sidecar's `boot` line and refuses with
  `SidecarExited: <what it said>` instead of answering `ok`. The claim is
  released, the message goes back to the composer, and a toast names the
  reason and this log file.
- **It dies while a session runs**: the shell takes it out of the session slot
  and emits `sidecar-exited` with its stderr tail. The window ends the session,
  releases the claim so the server can answer the conversation again, and
  draws "The assistant on this computer stopped: <reason>" on the
  conversation with a Retry that starts the session again and reruns the same
  message.

## Driven walk

A walk of the desktop app is DRIVEN: the app runs over the real `apps/web`
build and the operator reads what the window reports. Debug builds forward
the webview's diagnostics to the shell's stderr, so a refusal or a page error
is a line in a log rather than a devtools window nobody has open.

Build and run the debug app:

```
cd apps/web && bun run build          # the page the window serves
cd ../desktop
bun run build:overlay                 # src/ -> dist/overlay.js
bun prepare-sidecar.ts                # sidecar -> src-tauri/binaries/
bunx tauri build --debug              # the bundle, in target/debug/
```

`bunx tauri dev` is the same shell against Vite on `http://localhost:5173`
(`bun run dev` in `apps/web`), and it prints the same stderr.

Point it at a local API by launching it and typing the address at first
launch: the window asks once and stores it. There is no `LIAISON_BASE_URL` to
set. The same address can be handed to a running app as a deep link:

```
open "liaison://connect?server=http://localhost:3000"
```

Run the built bundle from a terminal so its stderr is yours to read:

```
./src-tauri/target/debug/liaison-desktop 2>&1 | tee /tmp/walk.log
# on macOS the bundled app is src-tauri/target/debug/bundle/macos/Liaison.app,
# and its own binary is Liaison.app/Contents/MacOS/Liaison
```

Every forwarded report is one line, `liaison-webview <kind>: <message>`, with
`(<file>:<line>)` when the browser named a source. The kinds are `csp` (a
content security policy refusal, with the directive and the blocked URL),
`error`, `unhandledrejection` and `console` (the page's own `console.error`,
which still reaches the console as well). Messages are cut at 2000 characters.

```
grep liaison-webview /tmp/walk.log
```

None of this exists in a release build: the shell registers the command under
`cfg(debug_assertions)` only, and the overlay's listeners go quiet when the
command is not there (`src/diagnostics.ts`, `src-tauri/src/diagnostics.rs`).

## Packaging and signing (macOS)

The release pipeline is `apps/desktop/ci/desktop-release.workflow.yml`, one job per OS
on its own native runner, and it fires only on a `desktop-v*` tag. It does not
run in this repository: the operator's private repository runs a copy of it,
with this one as a submodule, and holds the secrets and the runners. Every
credential in it is a `${{ secrets.NAME }}` reference.

The macOS order is the whole point, and three of the four steps below exist to
make a mistake in it loud:

```
ci/sign-sidecar-macos.sh <binary>     # 6a's, the sidecar signs FIRST
ci/tauri-build.ts --bundles app       # tauri build, with the build machine's
                                      # own paths remapped out of the binary
ci/check-bundle-no-absolute-paths.ts <Liaison.app>   # last check before signing
ci/sign-app-macos.sh <Liaison.app>    # seals the bundle, notarizes, staples
ci/make-dmg.sh <Liaison.app> [outdir] # hdiutil, then notarize and staple again
```

- The sidecar signs before the bundle is built, with its OWN entitlements
  (`ci/entitlements-sidecar.plist`: JIT, unsigned executable memory, network).
  The app's are smaller (`ci/entitlements-app.plist`): the shell JITs nothing.
- **`tauri build` re-signs the externalBin while it bundles it**, and the copy
  that lands in `Contents/MacOS` has a valid Developer ID signature, the
  hardened runtime, and NO entitlements. `codesign --verify` is happy with
  that, the app notarizes, and the first agent turn dies on a JIT that is no
  longer allowed. So `sign-app-macos.sh` signs the embedded sidecar AGAIN,
  through 6a's script, before it seals the bundle, and stops if the entitlement
  is still missing afterwards.
- `tauri build --bundles app` only. Tauri's own disk image step failed here
  after the `.app` was already written (the 6a signing spike recorded it), so
  the image is assembled by `make-dmg.sh` with `hdiutil`, after signing.
- `check-bundle-no-absolute-paths.ts` fails the build on a path that identifies
  the machine that built the artifact (the checkout, the home directory, the
  runner workspace). It reports, without failing, absolute paths baked into a
  vendored third party binary, which this pipeline cannot rebuild. It also
  refuses to pass over an empty bundle.
- `make-dmg.sh` refuses an app that is unsigned or carries no notarization
  ticket. `--no-notarize` is how a local image says out loud that Gatekeeper
  will refuse it.

Apple credentials use the names the monorepo's own `ci/sign-macos.sh`
documents: `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID`, or
`NOTARY_KEYCHAIN_PROFILE` on a Mac where they are already stored. Signing
material: `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PWD`,
`MACOS_KEYCHAIN_PWD`, or the Developer ID identity already in the login
keychain on a developer Mac.

`APPLE_TEAM_ID` is also REQUIRED for signing, on CI and on a developer Mac: a
keychain can hold several Apple teams' Developer ID certificates, so the
scripts sign with the one Developer ID Application identity of that team (by
its SHA-1 hash, `ci/macos-signing-identity.sh`), refuse none or two, re-sign a
nested binary another team signed, and assert the team on the sidecar, the
bundle, the disk image's app and, in the publish gate, the app inside the
updater archive.

## Minimum supported version

The server publishes the oldest desktop, iOS and Android version it supports at
`GET /api/client-policy`, from `LIAISON_MIN_CLIENT_DESKTOP`,
`LIAISON_MIN_CLIENT_IOS` and `LIAISON_MIN_CLIENT_ANDROID` (code defaults in
`apps/api/src/lib/env.ts`). A shell below its minimum shows an update notice.
When a release raises the desktop default, the minimum still covers at least the
last three desktop releases and the last 90 days, whichever reaches further
back, so a copy that updates rarely is not told to update the week after a
release.

## Where a release is downloaded from

The GitHub repository is PRIVATE, so its release assets answer 404 to every
anonymous client: an installed copy asking for its next version and a customer
clicking a download link both get nothing. The public surface is a Cloudflare
R2 bucket served at `https://downloads.liaison.sh`, which is where the updater
endpoint in `src-tauri/tauri.conf.json` points and where the release workflow
mirrors every verified artifact. The GitHub release stays as the private record
of what was built.

### The test channel

A signed build for testing on real machines, which production copies never
see: dispatch the release workflow with `channel=test`, `dry_run=false` and a
version like `0.1.10-test.1` (optionally `platforms=windows`). It signs like a
release, points the app's updater at `desktop/test/latest.json` through a
build time config merge, and publishes under `desktop/test/` only;
`ci/channel.ts` explains the rules and `test-channel.test.ts` holds them. A
test build is offered the next test build (semver: `-test.1 < -test.2 <` the
release) and nothing else; going back to production is a reinstall.

`ci/downloads-hosting.md` has the layout, the transport (R2's S3 endpoint, not
the 100 MB REST object api), the one time Cloudflare setup, the three
repository secrets by name (`LIAISON_DOWNLOADS_CF_ACCOUNT_ID`,
`LIAISON_DOWNLOADS_R2_ACCESS_KEY_ID` and
`LIAISON_DOWNLOADS_R2_SECRET_ACCESS_KEY`), how to re-run the mirror by hand
from a downloaded release, and how a rollback reaches the same host.
