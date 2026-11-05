# Push notification matrix runner

`matrix.ts` proves push delivery per surface (spec S7). For every case it:

1. sets the recipient's notification settings through the API, naming every grid cell the case depends on;
2. puts each surface in the case's state;
3. fires a real event as the sender;
4. reads the recipient's delivery rows and receipts for up to 30 s;
5. compares each surface with what the case expects: `shown`, `suppressed(reason)` or `none`;
6. puts the settings back.

It writes `report-<ts>-run<k>.json` and `.md`, with one row per cell: expected, observed, status and evidence ids.

```sh
bun qa/notifications/matrix.ts --dry-run                 # the plan; touches nothing
bun qa/notifications/matrix.ts --surfaces=web --only=M1  # one surface, one group
bun qa/notifications/matrix.ts --await-human --only=H,TF # the human cells
```

**Pass rule:** a run passes only when every cell matches and nothing is skipped or pending. That means all three surfaces (`ios`, `desktop`, `web`) are in the run. S7 asks for 2 consecutive passing runs (`--runs`, default 2). A failing run stops the loop: fix the defect with a red-then-green test, then start both runs over. The run reads `PASS`, `FAIL` (a mismatch or an error) or `INCOMPLETE: <why>` (nothing failed, but surfaces are missing or cells were skipped or left pending, as in a run of the human cells).

**Human trigger:** in a human cell that fires nothing itself (TF-test-button: the owner taps Send me a test), the log opens when the cell is announced (at most 5 min before the signal), so a tap before the signal counts, and the window waits for the first delivery row (up to `--human-timeout`) before it runs. A test send is one notification per device; each surface is judged only on the copy addressed to it (its pinned device when it has one).

## Target requirements

- The target serves the QA routes, so it runs with `LIAISON_QA_ROUTES=1` (the demo deploy, never production):
  - `POST /api/qa/notifications/inject` raises a real item of a kind, for example `new_email`, `task_overdue` or `system_alert`. `urgent` is optional.
  - `GET /api/qa/notifications/log?since=` returns the caller's own delivery rows and receipts. The runner reads every verdict from it.
- The target has VAPID keys set, so Web Push works.

## Environment

Credentials only ever come from the environment.

| variable | what it is |
|-|-|
| `MATRIX_SENDER_EMAIL`, `MATRIX_SENDER_PASSWORD` | Sends the DMs, @mentions and thread messages. Needs `kernel:threads:write`. |
| `MATRIX_RECIPIENT_EMAIL`, `MATRIX_RECIPIENT_PASSWORD` | Owns the devices. Every verdict is read as this user. Must not have TOTP turned on. |
| `MATRIX_NODEVICE_EMAIL`, `MATRIX_NODEVICE_PASSWORD` | A third user in the same org with no device, for M3 no-device. Without it, that case is skipped. |
| `MATRIX_BASE_URL` / `--base-url` | API origin. Default `https://demo.liaison.sh`. |
| `MATRIX_WEB_URL` / `--web-url` | Where Chrome opens the app. Default: the base URL. |
| `MATRIX_REPORT_DIR` / `--report-dir` | Where reports land. Default `qa/notifications/reports/`. For the pipeline, point it at `validation/push/`. |
| `MATRIX_RECIPIENT_MCP_REFRESH_TOKEN` (or a static `MATRIX_RECIPIENT_MCP_TOKEN`) | The recipient's MCP connection. An access token lives 15 minutes and a run lasts longer, so give the connection's refresh token: the runner mints access tokens from it (`/mcp/oauth/token`, `refresh_token` grant), again before they expire and on a 401. The `agent` group then calls `kernel__notify_user` as them. Without it, the group falls back to a QA inject of `agent_notification`, and the report says so. |
| `MATRIX_SENDER_MCP_REFRESH_TOKEN` (or `MATRIX_SENDER_MCP_TOKEN`), `MATRIX_APPROVAL_TOOL`, `MATRIX_APPROVAL_ARGS` (JSON) | A gated tool call by the sender's agent, for the `approvals` group. The recipient must be an approver of it. Without these, the group falls back to a QA inject of `approval_pending`, and the report says so. |
| `MATRIX_TESTFLIGHT_DEVICE_ID` | Pins the TestFlight cells to the owner's phone (its `deviceId` in Settings > Notifications). Without it, the iOS simulator's receipts would also count. |

## Surfaces

The runner drives only the surfaces you pass with `--surfaces`. Any surface you leave out must be off on the machine:

- the desktop app quit;
- the simulator app terminated;
- no Chrome tab signed in as the recipient.

The server's computer-channel precedence would otherwise send notifications to it.

### iOS (simulator, `ios`)

Uses `xcrun simctl`. The app is a Debug build of `apps/mobile` with the notification service extension.

| variable | default |
|-|-|
| `MATRIX_IOS_SIM` | `booted` |
| `MATRIX_IOS_BUNDLE` | `sh.liaison.mobile` |
| `MATRIX_IOS_APP` | none. Path to `Debug-iphonesimulator/App.app`. Needed for M5 fresh install, or when the app is not installed. |
| `MATRIX_IOS_BACKGROUND_APP` | `com.apple.Preferences`. Launched to send our app to the background. |
| `MATRIX_IOS_ALLOW_CMD` | none: the built-in CoreGraphics tap (`lib/surfaces/sim-tap.swift`, `grantNotificationsOnSimulator`) taps "Allow" at iPhone 17 coordinates. Set a shell command to override it on another device. |
| `MATRIX_IOS_OPEN_ROUTE=1` | Set only when the build honours the `LIAISON_DEBUG_OPEN_ROUTE` launch hook. |

**One-time setup:** sign the app in as the recipient and allow notifications once.

- To sign in without typing, the runner's fresh-install path seeds the app's Preferences with an app-origin refresh token and the server address. This is the same approach as `validation/push/T5-local.md`.
- `simctl privacy` cannot grant notifications, and an uninstall resets the grant: the runner taps "Allow" itself after every fresh install (`swift lib/surfaces/sim-tap.swift 0.69 0.592` by hand; `swift lib/surfaces/sim-tap.swift type <text>` types unshifted characters into a focused field).
- A fresh install first deletes the simulator's defaults for the bundle (`simctl uninstall` keeps the seeded keys, so the next install started with the last run's rotated token).
- The app restarts its page once after a seeded launch (no address mirror yet). Before P1-ios-login that restart kept the `/login` route the unbound page had bounced to, so the app showed the sign-in card over a live session until the next launch; the restart now goes back to the start route.

**How the runner sets each state:**

| state | how |
|-|-|
| foreground, another screen | Cold start: terminate, then launch. |
| background | Launch the background app. |
| killed | Terminate, then launch the background app. |

In the background and killed states, a `received` receipt from the extension counts as shown (A3).

**How the runner handles M5:**

| case | what the runner does | what it checks |
|-|-|-|
| fresh install | Uninstall, install, seed the session, launch, tap Allow. | An iOS device appears in `GET /api/notifications/devices` within 2 min. |
| forced register failure | Deletes the token server-side, then relaunches with `LIAISON_DEBUG_FAIL_NEXT_REGISTER=1`. | Same. |
| token invalidated server-side | Deletes the token (`DELETE /api/push/tokens`), then backgrounds and foregrounds the app. | Same. |

The runner reads the APNs token from the debug launch log (`LIAISON_DEBUG_PUSH token=`, via `log show`). Don't use `simctl launch --stdout` to a file on an external volume: it fails the launch.

**Gap:** the "foreground on the same thread" cell needs a way to open a thread from the runner. The app has no thread deep link. Without `MATRIX_IOS_OPEN_ROUTE=1`, the cell is reported as skipped.

### Desktop (`desktop`)

A debug, development-signed build of `apps/desktop`. Set `MATRIX_DESKTOP_APP` to the `.app`. `MATRIX_DESKTOP_BUNDLE` defaults to `sh.liaison.desktop`.

**Launch:** the runner starts it with:

- `LIAISON_DEBUG_DRIVER=<dir>`: the DOM driver from `driver.rs`. The directory is `MATRIX_DESKTOP_DRIVER_DIR`, default `~/.liaison-matrix/driver`.
- `LIAISON_DEBUG_BACKGROUND=1`, so it never takes focus.

**One-time setup:** sign the app in as the recipient.

**How the runner drives it:**

- **Route:** the runner moves the route with `history.pushState` in a driver script. "On the thread" means the route is `/threads/<dm>` (A2).
- **Tray and permission:** a driver script calls the debug-only shell commands through `window.__TAURI_INTERNALS__.invoke`:
  - `hide_to_tray`
  - `show_window`
  - `set_reported_notification_permission { permission }`
- **Quit and kill:** quit is `osascript ... to quit`. Kill is `pkill -KILL`.

### Browser (`web`)

The installed Google Chrome, on a persistent profile, through Playwright with the `chrome` channel.

| variable | default |
|-|-|
| `MATRIX_CHROME_PROFILE` | `~/.liaison-matrix/chrome-profile` |
| `MATRIX_CHROME_MODE` | `auto`. Tries Playwright first, then CDP: Chrome started by hand with `--remote-debugging-port=$MATRIX_CHROME_CDP_PORT`, Playwright attached. |

**Setup:** the runner grants notifications, signs in with the recipient's password if needed, and turns on browser notifications in Settings > Notifications. It then checks that the service worker holds a push subscription.

**Push channel:** Playwright's `--disable-background-networking` is dropped, because it cuts Chrome's push channel.

**How the runner sets each state:**

| state | how |
|-|-|
| focused elsewhere | Tab on Home. |
| on the thread | Tab on `/threads/<dm>`. |
| background tab | A tab opened from the page covers it. |
| no tab | Every Liaison tab is closed; Chrome keeps running. |
| unregistered | No tab, and the browser device is deleted server-side. |

**Seen on the Minimac:** Chrome reports every tab as `visible`, even behind another tab or minimized, in Playwright and in plain Chrome over CDP. The runner records this in the report notes. None of the background-tab cells depends on it, because their route is Home.

## Cases

The catalogue is `lib/cases.ts`; `--dry-run` prints it.

| group | cases | what they cover |
|-|-|-|
| M1 | 28 | 7 groups x {push, computer} x {on, off}, with the surfaces in the background. The other channel is set the opposite way, so an "off" case still proves the pipeline is alive. |
| M2 | 11 | States, with a DM. |
| M3 | 6 | Rules. |
| M4 | 4 | Precedence, including replay of 3. |
| M5 | 3 | Registration. |
| A6 | 2 | Desktop killed goes to the browser within 15 s; a tab on the thread plus a subscription gives in-tab suppressed and no Web Push. |
| A13 | 1 | Tray for 3 min, then a DM is shown on the desktop. |
| H | 1 | H-1: the macOS System Settings toggle. |
| TF | 6 | The TestFlight pass on the owner's phone (D16). |

**Producers that are not the spec's own,** each said in the report:

| group | stand-in |
|-|-|
| `mail` | A `new_email` item injected through the mail producer (A11). |
| `work` | A `task_overdue` item injected; the nudge job has no HTTP trigger. |
| `system` | A `system_alert` item injected. |
| quiet + urgent | An urgent `system_alert` item injected. |

**Human cells** (H-1 and TF) are `human-pending` unless you pass `--await-human`. With it, the runner:

1. sets what it controls;
2. prints the instructions and waits for Enter, or for `touch <report-dir>/human-ready-<case>` (`--human-timeout`, default 600 s);
3. fires the trigger and polls the receipts as usual.

## Tests

```sh
bun test qa/notifications   # engine (precedence, window, timeouts, router rows), report, catalogue
```
