// SPDX-License-Identifier: FSL-1.1-ALv2
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { defineConfig, devices } from "@playwright/test"
import { computeMemBudget } from "../../scripts/lib/mem-budget"

// Auto-load `liaison/.env.test` into the Playwright process env so tests
// don't need to be invoked with `set -a; source .env.test; set +a`. The
// API server (spawned by worker-env) reads from this process's env so
// anything set here flows through. Existing vars take precedence —
// shell-set values still win for ad-hoc overrides.
const ENV_FILE = resolve(__dirname, "..", "..", ".env.test")
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    if (line.trimStart().startsWith("#")) continue
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    const [, key, rawValue] = m
    if (process.env[key] !== undefined) continue
    const value = rawValue.replace(/^["'](.*)["']$/, "$1")
    process.env[key] = value
  }
}

// Provider keys: the fixed placeholders every other suite runs with
// (apps/api/src/tests/test-env-defaults.ts), overwriting whatever real key
// `.env.test` or the shell carries. The stack the suite boots inherits this
// env, so with a real key in `.env.test` any agent turn a scenario did not
// script reached a real, paid provider, and with no key at all a SCRIPTED turn
// failed before the script ran ("No API key available for provider"): the
// key gate comes first. A placeholder passes the gate and is useless past it.
// PLAYWRIGHT_LIVE_LLM=1 (helpers/live-llm.ts) keeps the real keys for the
// journeys that drive a real model on purpose.
if (process.env.PLAYWRIGHT_LIVE_LLM !== "1") {
  for (const name of [
    "LIAISON_ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "MISTRAL_API_KEY",
    "EXA_API_KEY",
  ]) {
    process.env[name] = `test-placeholder-${name.toLowerCase().replaceAll("_", "-")}`
  }
  // No deployment OpenRouter key at all: the journeys are written against an
  // org that adds its own (the AI models page, the providers list), and a
  // placeholder would also offer dictation, whose speech to text the stub
  // does not serve.
  delete process.env.OPENROUTER_API_KEY
  // With placeholder keys the servers' own side calls (chat titles,
  // message-search embeddings) would still reach the real providers and be
  // rejected there: stand them down so a run makes no outbound model call.
  process.env.LIAISON_OFFLINE_SIDE_CALLS = "1"
}

// Strobe writes its progress reporter to this well-known path.
// When present, we add it as a secondary reporter for live per-test tracking.
const STROBE_REPORTER_PATH = "/tmp/.strobe-playwright-reporter.mjs"
const hasStrobeReporter = existsSync(STROBE_REPORTER_PATH)

// Phone-tier scenarios are a SEPARATE project: the shell renders a different
// surface below 640px (one column, a five seat bottom bar, sheets in place of
// the sidebar column), and driving it from a 1440px desktop context proves
// nothing about it. They are matched by name so the desktop project can
// exclude them wholesale rather than each file opting out.
const PHONE_SCENARIOS = "**/*.phone.scenario.test.ts"

// The desktop app (Tauri, macOS WKWebView) runs the same build under its own
// CSP. Its scenarios only mean something in WebKit, so they are a separate,
// opt-in project (PLAYWRIGHT_PROJECT=desktop-webkit) and the Chromium project
// leaves them out.
const DESKTOP_WEBVIEW_SCENARIOS = "**/*.desktop-webview.scenario.test.ts"

// Projects that run only when named by PLAYWRIGHT_PROJECT: a default run must
// not require a WebKit download on every host.
const OPT_IN_PROJECTS = new Set(["iphone-webkit", "desktop-webkit"])

const allProjects = [
  {
    name: "chromium",
    testIgnore: [PHONE_SCENARIOS, DESKTOP_WEBVIEW_SCENARIOS],
    use: {
      ...devices["Desktop Chrome"],
      // Lock viewport + scale factor so visual snapshots are identical across machines.
      // Visual tests should NOT call setViewportSize — this is the single source of truth.
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    },
  },
  {
    name: "iphone",
    testMatch: PHONE_SCENARIOS,
    use: {
      ...devices["Desktop Chrome"],
      // A 390x844 phone at 3x, with touch and the mobile flag the shell's
      // media queries and the app's pointer affordances read.
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
  },
  {
    // The same phone, in WebKit: the engine the iOS app actually runs. A
    // mobile WebKit widens its LAYOUT viewport to fit content wider than
    // `width=device-width`, then shows the screen's width of it, so an
    // overflow Chromium clips quietly is, on the phone, a shell cut on the
    // right AND the bottom. Only the width matrix runs here, and only when
    // asked for by name (PLAYWRIGHT_PROJECT=iphone-webkit): a default run
    // must not require a WebKit download on every host.
    name: "iphone-webkit",
    testMatch: "**/layout-widths.phone.scenario.test.ts",
    use: {
      ...devices["iPhone 15"],
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
  },
  {
    // The desktop shell's webview: WebKit at the Tauri window's size, with the
    // shell's CSP applied by the scenario itself (read from tauri.conf.json).
    name: "desktop-webkit",
    testMatch: DESKTOP_WEBVIEW_SCENARIOS,
    use: {
      ...devices["Desktop Safari"],
      viewport: { width: 1280, height: 860 },
      deviceScaleFactor: 1,
    },
  },
]

// `test-run.ts` passes no extra CLI args through to Playwright, so the project
// is selected by env var. Unset runs both, exactly as before.
const PROJECT_FILTER = process.env.PLAYWRIGHT_PROJECT?.trim()

export default defineConfig({
  testDir: "./src/tests/e2e",
  testMatch: "*.scenario.test.ts",
  fullyParallel: false,
  // Zero retries — by design. A retry budget silently absorbs flakes: a test
  // that fails on attempt 1 and passes on attempt 2 still reports "passed",
  // so the suite's green is a lie. With retries:0 every flake fails loud and
  // gets root-caused (a flake is a real bug — determinism gap or product
  // defect — never a timeout to bump). Genuine non-determinism (real LLM
  // tool-calling) is contained INSIDE the test with a bounded re-prompt loop,
  // which keeps the test itself deterministic. Do not raise this above 0.
  retries: 0,
  // Each worker is a lane (an API server serving the web build, src/tests/e2e/
  // pw-lanes.ts) plus Chromium, about 1.5GiB at peak, so the worker count is
  // this run's share of the machine's RAM: scripts/lib/mem-budget.ts divides
  // what is left after the OS reserve by the test slots (LIAISON_TEST_SLOTS,
  // default 2) and allows one worker per 1.5GiB of the share, clamped 1..4. scripts/test-run.ts injects the
  // same number as PLAYWRIGHT_WORKERS; a direct `playwright test` computes it
  // here instead of falling back to a single worker. An explicit
  // PLAYWRIGHT_WORKERS (or --workers) wins: set 1 on a contended machine.
  workers:
    Number(process.env.PLAYWRIGHT_WORKERS) ||
    computeMemBudget(undefined, undefined, process.env, Number(process.env.LIAISON_TEST_SLOTS) || 2)
      .playwrightWorkers,
  globalSetup: "./src/tests/e2e/global-setup.ts",
  globalTeardown: "./src/tests/e2e/global-teardown.ts",
  timeout: 90_000,
  // Env-gated baseline refresh so the Strobe MCP runner (which passes env, not
  // a CLI flag) can regenerate visual goldens after a deliberate UI change.
  // PW_UPDATE_SNAPSHOTS=all|missing|none → Playwright's updateSnapshots option.
  // On CI a missing baseline is a failure, never a fresh image written beside
  // the run: "none" there (the gate workflow's update_snapshots input sets
  // PW_UPDATE_SNAPSHOTS=missing to create a platform's baselines on purpose).
  updateSnapshots:
    (process.env.PW_UPDATE_SNAPSHOTS as "all" | "missing" | "none" | undefined) ||
    (process.env.CI ? "none" : "missing"),
  // Snapshot path is deterministic: <test-file>-snapshots/<name>-<platform>.png.
  // Project name is intentionally NOT in the template — we run a single project
  // (`chromium`), so embedding it adds noise and causes inconsistent filenames
  // when Playwright's default template falls back across versions.
  snapshotPathTemplate:
    "{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}-{platform}{ext}",
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
    // Force the dark OS color scheme for the whole E2E suite. The app's default
    // theme preference is "system", which resolves via prefers-color-scheme;
    // without this Playwright defaults to light and every dark-mode visual
    // baseline diffs. Dark is the QA baseline — keep it the single source.
    colorScheme: "dark",
  },
  projects: allProjects.filter((project) =>
    PROJECT_FILTER ? project.name === PROJECT_FILTER : !OPT_IN_PROJECTS.has(project.name),
  ),
  // No webServer entries — each worker provisions its own via fixture
  // JUnit for Strobe result parsing, plus `line` so a run driven from a shell
  // (the dev box, CI) prints per-test progress and the failing test names into
  // its log instead of going silent for the whole lane and leaving only an XML
  // file behind. Strobe progress reporter added when present on disk.
  reporter: hasStrobeReporter
    ? ([["line"], ["junit"], [STROBE_REPORTER_PATH]] as any)
    : [["line"], ["junit"]],
})
