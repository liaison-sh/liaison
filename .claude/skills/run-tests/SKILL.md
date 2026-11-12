---
name: run-tests
description: How to run Liaison's test suites — the suites, test:gate, running one file or one test, run namespaces, test slots and the memory budget, the substrate reset, and per-directory quirks. Use at the start of any task that touches code, before the first test run.
---

# run-tests

Tests run through the repo's own scripts. Read this before your first test run
in a session.

## The suites

Always through `bun run` from the repo root: the `pretest` hook runs
`scripts/bootstrap-test-env.ts`, which checks the services and roles and
rebuilds any bundled-app tarball whose source is newer than the artifact. The
database is the runner's job (see Run namespaces).

| Command | What |
|---|---|
| `bun run test:unit` | api unit tests |
| `bun run test:integration` | api integration tests |
| `bun run test:e2e` / `test:e2e:parallel` | api end-to-end tests |
| `bun run test:playwright` | browser tests |
| `bun run test:root` | repo-root `scripts/` tests |
| `bun run test:web-unit` | web unit tests (vitest) |
| `bun run test:full` | everything, as CI runs it |
| `bun run test:gate` | only what the current change affects (below) |

`.claude/test-map.ts` maps paths to the suites they affect. Its sibling
`.claude/docs-map.ts` maps paths to the docs pages they affect: run
`bun run check:docs --base origin/main` (seconds, no services) before you call
a change done.

## test:gate: the tests a change needs

`bun run test:gate [--base origin/main] [--dry-run]` diffs against the merge
base (plus the working tree), maps each path through `.claude/test-map.ts`,
and runs only the affected suites: a changed test file alone in its suite, a
unit source file's co-located tests, a changed scenario alone in e2e-parallel,
everything else as the whole suite; an unmapped path runs the broad set
(fail-safe). It prints what ran, what was skipped and why, and each suite's
wall clock. Run `--dry-run` first: if the plan says "whole suite" for a big
suite, prefer the targeted files instead (see Granularity).

## One file or one test

Preferred: `bun run scripts/test-run.ts <suite> --file <path>` (`--file` may
repeat; takes the namespace and a test slot, prepares the namespace database,
loads the env, runs the suite's setup). For a quick direct run:

Wrap direct runs in `with-test-lock.ts` (below): it takes a slot and runs the
command in this checkout's namespace (its own database, prefixes and ports):

```
L="bun run scripts/with-test-lock.ts --"
# api: run from apps/api so the ~/ path alias resolves
(cd apps/api && bun run ../../scripts/with-test-lock.ts -- bun test src/modules/foo/foo.test.ts)
(cd apps/api && bun run ../../scripts/with-test-lock.ts -- bun test src/modules/foo/foo.test.ts -t "rejects bad password")
# packages: from the package dir
(cd packages/db-core && bun run ../../scripts/with-test-lock.ts -- bun test src/sql-guard.test.ts)
# web unit: from apps/web
(cd apps/web && bun run ../../scripts/with-test-lock.ts -- bunx vitest run src/modules/foo/Foo.test.tsx)
# repo-root scripts
$L bun test scripts/lint-copy-dashes.test.ts
# no database needed (a pure test): the slot alone
bun run scripts/with-test-lock.ts --slot-only -- bun test scripts/lib/foo.test.ts
# types: tsgo on the packages your change touches (light lane), never a full tsc locally
bun run typecheck:changed
```

- **api e2e scenarios share a server per slot.** `test-run.ts e2e-parallel`
  boots one API server per parallel slot (a lane) and resets its data to a
  post-boot snapshot before each file, instead of cloning schemas and booting a
  server per file (`docs/testing.md`, Multi-Worker Architecture). A scenario
  that needs a pristine process carries the comment marker `e2e-own-server`;
  `LIAISON_E2E_SHARED_SERVER=0` runs every file the old way when you suspect
  the sharing. The run log folder holds each file's output (`<file>.log`) and
  the lane servers' (`lane-<n>-std{out,err}.log`).
- **Live-model scenarios** (a real model provider, paid) skip unless the run
  opts in: api e2e with `LIAISON_E2E_LIVE_LLM=1` (only then do `e2e` /
  `e2e-parallel` get the real provider keys; `describeLive` / `itLive` in
  `apps/api/src/tests/e2e/helpers/live-llm.ts`), Playwright journeys with
  `PLAYWRIGHT_LIVE_LLM=1`. A direct `playwright test` sizes its workers from the
  memory budget like the runner does; `PLAYWRIGHT_WORKERS=1` forces one.
- **Soak tests** (`apps/api/src/**/*.soak.test.ts`: GB-scale imports, minutes
  each, GBs of `$TMPDIR`) skip unless `LIAISON_SOAK=1`. No lane or gate runs
  them (the unit shards and `test:gate` leave them out). Run one by hand, with
  `df -h /` showing room for its fixture, under the lock:
  `(cd apps/api && LIAISON_SOAK=1 timeout 1500 bun run ../../scripts/with-test-lock.ts -- bun test --timeout 1800000 src/modules/imports/uploads/uploads.soak.test.ts)`.
- A checkout (or worktree) without `.env.test`: `cp .env.test.example .env.test` and fill in `JWT_SECRET` / `ENCRYPTION_KEY` (`openssl rand -hex 32` each). A run's namespace pins the database and the Meilisearch key to the local substrate, so the checkout's own `.env` cannot leak into tests.
- `bun test` auto-loads `.env.test` only from its cwd when `NODE_ENV=test`.
  From `apps/api` or a package, export it first:
  `set -a; source ../../.env.test; set +a` (most `apps/api/src/**` files import
  `~/lib/env` and fail on `JWT_SECRET` / `ENCRYPTION_KEY` without it).
- **Bundled-app `.tsx` tests** (`bundled-apps/*/src/ui/*.test.tsx`) run from the
  app's own directory (e.g. `bundled-apps/meta-ads`): bun picks the JSX
  transform from the nearest `tsconfig.json`, and from the repo root every
  solid-js test fails with `Cannot find module 'react/jsx-dev-runtime'`.
- A direct `bun test` skips the `pretest` bootstrap: after touching a bundled
  app's source, run `bun run scripts/bootstrap-test-env.ts` once (or go through
  a `bun run test:*` suite). A migration or app manifest change needs nothing: the next run
  builds a new template and re-clones.
- A bare `bun test` with no wrapper uses the shared `liaison_test`, which other
  sessions may be using. Go through `test-run.ts` or `with-test-lock.ts`.

## Granularity — climb only as far as needed

Go from a failure to green in the fewest, smallest runs. Every rung up costs
minutes and holds one of the machine's test slots.

1. **One test by name** (`-t "<name>"`): the first thing you run after a fix.
   Use this most of the time.
2. **One test file**: when the name isn't unique or you just wrote the test.
3. **The files a change touches**: when a shared module changed, the test files
   that cover it (`.claude/test-map.ts` maps paths to suites).
4. **A full suite** (`test:unit`, `test:integration`, `test:full`): never on
   your own initiative. It takes about an hour and holds a slot other sessions are waiting for.
   Only when the owner asks, or CI does it.

The fix loop: read the failure, fix it, rerun only that test, then the next
failure. Never rerun a suite "to see what else fails" and never rerun an
unchanged test hoping for a different result.

No gate stacking: a change is proven by its targeted tests plus `tsc` on the
package it touches. Don't add extra gates (full typecheck, full lint, full
suites, repeated re-verification) between steps.

## Run namespaces and the substrate

Every run works in a namespace: the checkout's directory name, or
`LIAISON_TEST_NS`. It owns database `liaison_test_<ns>` (worker schemas inside
it), Redis keys `<ns>:*`, Meili indexes `<ns>-*` and a leased 1000-port block,
so worktrees test concurrently on the one docker stack without clashing
(`packages/test-helpers/src/test-namespace.ts` is the one resolver).

The database is a copy of `liaison_tpl_<hash>`, the template: the migrations
plus the in-tree apps' manifest schemas (the tables and columns an app's
registration adds, applied by the registration itself,
`apps/api/src/db/apply-app-schemas.ts`), so a test reading an app table never
depends on another file having registered the apps first. It is built once per
set of migrations, app manifests and registration code (about 3 s).
`LIAISON_TEST_TEMPLATE_APP_SCHEMAS=0` uses a migrations-only template instead,
for a run that must watch registration start from the migrated shape.
`e2e`, `e2e-parallel` and `playwright`
get a fresh copy every run (about 0.2 s) and their reset drops only this
namespace's Redis keys and Meili indexes; other suites reuse the namespace
database while it matches the current migrations. Running those files
directly, `with-test-lock.ts` prepares the database (reused while current); for
a forced fresh copy go through `test-run.ts e2e --file <path>`.

Never `FLUSHDB`, `db:reset:test` or wipe `w*_` indexes by hand: those belong to
every checkout's runs (and the shared `liaison_test` to bare runs).

## Test slots and the memory budget

A full suite run once used about 33 GB on a 16 GB Mac and the OOM killer ended
it. Two things prevent that now, and both are automatic.

**A few heavy jobs at a time.** Every heavy job on the machine holds one of
`LIAISON_TEST_SLOTS` machine-wide slots (default 2, files in
`${TMPDIR}/liaison-test-slots`, code in `scripts/lib/machine-slots.ts`):
`scripts/test-run.ts`, `scripts/strobe-runner.ts` (CI), `scripts/with-test-lock.ts`,
`test:gate`, and the package scripts `typecheck`, `typecheck:scripts`,
`check:docs`, `test`, `test:web`, `desktop:build`, `build:mobile`, apps/web
`test:e2e` (Playwright), plus `scripts/build-bundled-app.sh` and
`scripts/build-app-catalog.ts`. The rules:

- **FIFO.** A waiter takes a ticket and is served in arrival order (polling
  every 2 s, logging every 60 s with who holds each slot, up to
  `TEST_LOCK_WAIT_SEC`, default 3600).
- **Load gate at start only.** A new job also waits while the 1-minute load
  average is at or above `LIAISON_SLOT_MAX_LOAD` (default 1.5 times the core count on macOS, and a load over it still lets a job start while the CPUs are at least `LIAISON_SLOT_MIN_IDLE` percent idle, default 25; unset
  means no gate elsewhere, where CI and container hosts report a load the run
  neither causes nor can wait out; `0` or `off` disables it). A job that holds
  its slot is never paused or revoked.
- **Anti-starvation.** Most of a shared Mac's load is other work (another
  project's compiler, a VM, indexing). A waiter whose turn has come and that has
  waited `LIAISON_SLOT_STARVE_SEC` (default 600, `off` for never) takes a FREE
  slot over the load gate, and says so. Memory still holds it: the memory gate
  is never overridden.
- **A light lane** of `LIAISON_LIGHT_SLOTS` (default 2) with its own FIFO
  queue, the memory gate and no load gate: `with-test-lock.ts --slot-only` puts
  a `tsgo` or Biome command there by itself, `--light` puts any other job of
  about a minute with no database there. A full `tsc`, a build or a test file
  stays in the heavy lane.
- **Memory gate at start only.** A new job also waits while macOS reports warn
  or critical memory pressure (`kern.memorystatus_vm_pressure_level`, the live
  signal), while available memory
  is below `LIAISON_SLOT_MIN_FREE_MB` (default 1024 on macOS, a backstop) or swap in use is
  above `LIAISON_SLOT_MAX_SWAP_MB` (default 4096 on macOS); no memory gate
  elsewhere unless set, `0` or `off` disables either. macOS available memory is
  free + speculative + file-backed + purgeable pages (one `sysctl` read per
  poll), Linux reads `MemAvailable`. The wait line names both numbers, and
  `bun run slots` shows them. The load average does not see memory: a CI step
  was SIGKILLed (exit 137) under memory pressure with the load fine. macOS swap
  stays used long after a spike, so on macOS swap counts only under warn or
  critical pressure, and `bun run slots` shows the pressure level. A targeted
  run (`--file`, one or more) keeps the 2 GiB reserve, and its memory guard on
  macOS counts low available memory only under that same pressure.
- **Dead holders free themselves.** Each record carries the pid and that
  process's start time: a dead pid, or a pid the system reused for another
  process (after a reboot, say), reads as free.
- **A run that cannot start gives its slot back at once**: a failed substrate
  preflight or database preparation releases it before exiting.
- **A slot held by an ancestor covers its descendants**, so a CI job whose
  runner leased a slot for the whole job (`bun scripts/slots.ts lease --pid
  <pid>`, released with `release --pid <pid>`) does not take a second one.
- A live holder of the old exclusive lock (`${TMPDIR}/liaison-test.lock`,
  from a checkout that predates slots) counts as one slot. Two runs of the
  same namespace serialize on a namespace lock instead of sharing a database.

`bun run slots` shows the holders (pid, age, cwd, command), the waiters in
order, the load, available memory and swap with their gates; `--json` for a machine-readable copy.

**Anything else heavy goes through the wrapper**:
`bun run scripts/with-test-lock.ts -- <cmd>` for a test that needs the
namespace database, `bun run scripts/with-test-lock.ts --slot-only -- <cmd>`
for one that needs only the slot (a `tsc`, a build, a test with no database).
Put any `timeout` inside the wrapper so it bounds the job, not the wait.

**Never start a run outside the slots.** Unslotted runs size their
parallelism without knowing about each other; that is exactly how the 33 GB
happened. Kill a superseded run by its exact PID before starting the next.

**The budget is computed, not configured.** `scripts/lib/mem-budget.ts`
reserves memory for the OS and everything else open (8 GiB for a whole-suite
run, 2 GiB for a run of exactly one `--file`, whose tree is one lane), divides
what is left by the slot count, and spends one share:

| Knob | Derived as | Env var injected |
|---|---|---|
| Playwright workers | budget / 1.5 GiB, clamped 1..4 (a lane: API server + Chromium; 6 measured slower, CPU bound) | `PLAYWRIGHT_WORKERS` |
| vitest max workers | budget / 0.4 GiB, clamped 1..cpus-1 | `VITEST_MAX_WORKERS` |
| e2e-parallel children | budget / 1 GiB, clamped 1..4 | `TEST_E2E_WORKERS` |
| sandbox worker pool max | budget / 1 GiB, clamped 1..4 | `APP_WORKER_POOL_MAX` |
| sandbox warm size | always 1 | `SANDBOX_POOL_WARM_SIZE` |
| sandbox worker max RSS | 256 MB in low memory mode, else 512 MB | `APP_WORKER_MAX_RSS_MB` |
| QuickJS pool max size | budget / 0.5 GiB, clamped 2..8 | `SANDBOX_POOL_MAX_SIZE` |
| unit shards | budget / 1.5 GiB, clamped 1..min(8, cpus) | `TEST_UNIT_SHARDS` |

Each unit shard runs its files in batches of `TEST_UNIT_BATCH` (default 8) per bun
process, about 1 GB RSS per process; `docs/testing.md` (Unit runner) has the
details.

Below 6 GiB of budget the run enters low memory mode and children also get
`BUN_OPTIONS=--smol`. The table prints once at the start of every run.

**Overrides.** Anything you set yourself wins, and is never raised back up:
export `PLAYWRIGHT_WORKERS=1` and it stays 1 whatever the budget says.
`TEST_MEM_RESERVE_MB` changes the reserve, overriding both defaults (raise it when you have a browser and
a simulator open). `TEST_SLOT_DIR` moves the slot files. `TEST_LOCK_SKIP=1`
bypasses the slots entirely: it is the documented escape hatch, it logs loudly,
and it is only correct when you know for certain nothing else is running.

**The guard enforces the plan at runtime.** `scripts/lib/mem-guard.ts` starts a
sampler as soon as the run's slot is taken (`test-run.ts`, `strobe-runner.ts`
and `test:gate` arm it; a child that inherited the slot does not, it is already
inside the parent's tree). Every 2 s it reads two numbers:

1. system available memory (`MemAvailable` on Linux; on macOS the `vm_stat`
   free, inactive, speculative and purgeable pages, all reclaimable on demand),
2. the RSS sum of the runner's whole process tree (`ps` plus a ppid walk).

It stops the run when available memory stays under the reserve minus 512 MB of
hysteresis (7680 MB with the 8192 MB whole-suite reserve, 1536 MB with the
2048 MB single-file one) for two samples in a row,
or when the tree's own RSS passes the computed budget. Two samples, because a
single dip is usually one compile finishing; immediately on tree RSS, because
that is the run's own accounting being wrong.

Tripping prints one loud line with every number and the five largest processes
in the tree, writes `memory-guard-tripped.json` next to the suite's
`output.log`, SIGTERMs the tree leaves first, SIGKILLs whatever survives 5 s,
and exits **99** with what to do about it. The budget made the plan fit; this is
what stops a run whose memory never appeared in the plan (orphaned e2e servers,
a second run, a browser and a simulator).

If a run dies with exit 99, read the JSON: `reason` is `available` or
`tree-rss`, and `top` names what was holding the memory. `available` means the
machine was busy, so close things or raise `TEST_MEM_RESERVE_MB`; `tree-rss`
means the suite itself outgrew its budget, which is a bug to fix, not a knob to
raise.

| Knob | Effect |
|---|---|
| `TEST_MEM_GUARD=0` | disables the guard, logging one loud line saying nothing will stop the run from taking the machine |
| `TEST_MEM_GUARD_POLL_MS` | poll interval, default 2000, values under 100 ignored |
| `TEST_MEM_RESERVE_MB` | the reserve the guard enforces, same var the budget reads |

**Docker substrate** is capped in `docker-compose.yml` (`mem_limit`: postgres
1.5g, meilisearch 768m, redis 256m, objectstore 256m), so the containers cannot take
the headroom the budget just handed to the suite.

## Test data: the seed engine

Data comes from `apps/api/src/seed/` (`docs/testing.md`, Test data), never a
raw `INSERT INTO` in a test (`bun run check:raw-insert` ratchets the count;
`--write` lowers the baseline after a removal).

- Unit and integration: `createTestOrg`, then `import * as minimal from
  "~/seed/tiers/minimal"` (`person`, `session`, `thread`, `contact`,
  `grantScope`, `assignRole`, `secondOrg`, ...) or a factory from
  `seed/factories/<domain>/`.
- Playwright and api e2e: rows mid-test through `seedFactory` (web
  `helpers/seed.ts`, api `tests/e2e/helpers/seed-factory.ts`), which calls
  `POST /api/_test/seed {factory, orgId?, args}` on the server under test
  (registry `apps/api/test-support/seed/factories.ts`; test builds only).
- Playwright lanes start from the `standard` tier (`liaison seed --tier
  standard --admin admin@test.com`): admin Elodie Vasseur `admin@test.com` /
  `12345678`; Amina Cherif, Lucas Pereira, Tobias Braun, Margot Dufour at
  `<first>@resonantaudiolabs.example` / `QaPass1!`. Helpers (`TestWorld`,
  `SeededRng`, `seedStandardWorld`) are in `@liaison/test-helpers`.
- Other tiers: `demo`, `lively` (private boxes), `load`; flags in
  `docs/reference/cli.md`.

## Playwright lanes

`playwright` runs on shared lanes (`docs/testing.md`, Playwright lanes): the
web app is built once, one API server per worker slot serves it with a seeded
QA world, and each spec file starts from that world's snapshot. A failing test
no longer costs a stack boot. `LIAISON_PW_SHARED_STACK=0` boots a stack per
worker the old way. Any browser CSP violation fails the test. Provider keys are
placeholders unless `PLAYWRIGHT_LIVE_LLM=1`.

## Visual baselines

Baselines are per platform (`<name>-<platform>.png`) and the committed ones are
darwin only: on another platform a screenshot assertion SKIPS its test with
the reason. After a deliberate UI change, from `apps/web/`:
`bunx --bun playwright test --update-snapshots=all --grep "<visual test name>"`.
To add the baselines of a new platform: `PW_UPDATE_SNAPSHOTS=missing` on one
visual spec at a time, reviewing every image. Baselines live in
`src/tests/e2e/*-snapshots/`. Refresh one scenario at a time and only for an
intended change, never to silence an unexpected diff.

## ads-dashboard e2e: chunk it locally

The 16-test `ads-dashboard` Playwright set run as ONE invocation accumulates
8-10GB of transient memory (browser surfaces + screenshot/diff buffers + the
e2e server) and OOM-kills a 16GB machine that is doing anything else
(observed 3x, 2026-07-07; every test passes individually). Locally, run it as
three invocations with a port sweep between them:

```
L="bun run ../../scripts/with-test-lock.ts --"
$L bunx --bun playwright test ads-dashboard.scenario.test.ts --workers=1
pkill -f "index.e2e|vite|headless_shell"; sleep 3
$L bunx --bun playwright test ads-dashboard.visual.scenario.test.ts \
  --grep "campaigns-|campaign-detail|ads-grid|audiences|performance|settings|sidebar-badges" --workers=1
pkill -f "index.e2e|vite|headless_shell"; sleep 3
$L bunx --bun playwright test ads-dashboard.visual.scenario.test.ts --grep "dashboard-" --workers=1
```

CI (dedicated runner) may run the whole set in one go.
