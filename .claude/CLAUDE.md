# Liaison

> Setting up Liaison for a company rather than changing its code? Follow `.claude/skills/setup-liaison/SKILL.md`; the rest of this file is for contributors.

Agent-native business operating system: a kernel plus plugin apps. Bun/TypeScript monorepo. SolidJS + Vite + Kobalte + Tailwind on the front, Hono + Bun on the API, PostgreSQL with RLS through Drizzle and the postgres.js driver, Redis (ioredis) + BullMQ for cache, pub/sub and jobs, MeiliSearch for search, Bun native WebSocket for real time, Zod schemas shared across both sides, Biome for format and lint.

| Doc | What is in it |
|---|---|
| `docs/conventions.md` | Naming, imports, types, error handling, formatting, monorepo |
| `docs/backend-overview.md` | RLS, outbox, events, middleware, actor context, config |
| `docs/frontend-overview.md` | Modules, stores, framework layers, tab system, session lifecycle |
| `docs/testing.md` | Test scripts, e2e infra, frontend and backend test patterns |
| `docs/app-development.md`, `docs/app-package-format.md`, `docs/app-sandbox.md` | Building a plugin app |
| `apps/api/CLAUDE.md`, `apps/web/CLAUDE.md` | Backend and frontend conventions |
| `docs/nav.ts`, `.claude/docs-map.ts` | The user docs (liaison.sh/docs): published pages, and which pages each code path feeds |

## Build and test

- Tests: read `.claude/skills/run-tests/SKILL.md` before the first test run of a session. Suites: `bun run test:unit`, `test:integration`, `test:e2e`, `test:e2e:parallel`, `test:playwright`, `test:root`, `test:full`, `test:web-unit`, always through `bun run`; `bun run test:gate [--base origin/main]` runs only what the current change affects (path to suite map: `.claude/test-map.ts`). Single files go through `scripts/test-run.ts <suite> --file <path>` or `scripts/with-test-lock.ts`.
- Runs are namespaced per checkout (worktree dir name, or `LIAISON_TEST_NS`): own database `liaison_test_<ns>` cloned from a template `liaison_tpl_<hash>` (migrations plus the in-tree apps' manifest schemas), own Redis/Meili prefixes and port block, so worktrees test concurrently. `LIAISON_TEST_SLOTS` runs (default 2) share the machine, each on its share of RAM.
- Infra containers (Postgres, Redis, MeiliSearch, SeaweedFS): `bun run infra:up`, check with `infra:check`, stop with `infra:down`.
- Dev server: `bun run dev`, which auto-seeds the QA dataset (`scripts/seed-qa.ts`). Admin `admin@test.com` / `12345678` (Elodie Vasseur); teammates Amina Cherif, Lucas Pereira, Tobias Braun, Margot Dufour (`<first name>@resonantaudiolabs.example` / `QaPass1!`), the `standard` seed tier (`liaison seed --tier standard`). Reseed with `bun run db:reset && bun run seed --yes`. Playwright seeds the same tier in an isolated schema, so these people exist in both without sharing state.
- Update Playwright visual baselines from `apps/web/`: `bunx --bun playwright test --update-snapshots=all --grep "<visual test name>"`. Baselines live in `src/tests/e2e/*-snapshots/`.
- Other gates worth running on a targeted change: `bun run typecheck`, `bun run lint`, `bun run check:fix`.
- **Targeted tests only (binding).** Prove a fix with the test files it touches (`scripts/test-run.ts <suite> --file <path>`, or `test:gate`), never by running or rerunning the full `test:unit` / `test:integration` / `test:full` suites: they take about an hour on a laptop and hold a test slot. Fix every failure you find, validate each one the same targeted way.

## Docs are part of done (binding)

The user docs live in `docs/` and publish to liaison.sh/docs. A change to what a user, admin, self-hoster or app developer can see or do updates its page in the same pull request.

- `.claude/docs-map.ts` maps code paths to page ids. Before you finish, look up every path you changed and update the pages it names: new or renamed UI labels, settings, scopes, tools, CLI flags, env vars, steps.
- A new app, module or directory gets a page in `docs/nav.ts` (or joins an existing one) and an entry in `.claude/docs-map.ts`, or a `DOCS_EXEMPT` entry with a reason.
- Reference pages under `docs/reference/` are generated from the source, never edited by hand, and a feature PR does not regenerate them: `check:docs` and the docs build render them fresh, and the committed copies are refreshed apart, by a PR that only runs `bun run docs:gen` (two PRs regenerating one page conflict).
- Write from the code: every claim on a page has a line in its sources sidecar, `docs/.sources/<page-id>.txt` or, for new claims, a file of their own in `docs/.sources/<page-id>/<feature>.txt`, so two PRs on one page add different files. Point at a symbol (`path (functionName)`) rather than `path:line` where you can: line numbers move with every edit. Plain, short sentences, task-first headings ("Connect Gmail"), real UI labels from `packages/shared/src/i18n/locales/en/`.
- `bun run check:docs --base origin/main` runs the same guard as CI: generated pages render (a stale committed copy is only reported), every page in the nav, no broken link, every app, CLI command, env var, setting and scope documented, and every mapped change paired with its page. A change with no user-visible effect (a refactor, a test-only fix) says so with a `Docs-skip: <reason>` line in the PR body.

## Layout

```
apps/web/          SolidJS frontend (modules/, framework/, ui/, lib/, primitives/)
apps/api/          Hono backend (app.ts, modules/, services/, infra/, db/, lib/, middleware/)
packages/shared/   Types, Zod schemas, utilities shared by web and api
packages/app-sdk/  Public plugin SDK consumed by bundled and third-party apps
bundled-apps/      First-party plugin apps, one directory each
app-catalog/       Built .liaisonapp tarballs plus catalog.json, baked into the runtime image
scripts/           test-run.ts orchestrator, seeds, bootstrap, lint and guard scripts
```

**Bundled apps** ship with the distribution but install through the standard `.liaisonapp` route, exactly as a third-party app would. They must not import `apps/api/` or `apps/web/` internals, only the public `@liaison/app-sdk`; `scripts/check-bundled-app-purity.ts` enforces that. Build one with `scripts/build-bundled-app.sh <name>`; rebuild the whole catalog with `scripts/build-app-catalog.ts` (first-party apps are frozen `--skip-sign` and installed with `requireSignature: false`, because the trust boundary is the image itself).

## Conventions

- **Dependencies: latest stable.** Verify with `npm view <pkg> version` or `bun outdated`, pin with `^` to the latest major.
- **API response envelope**: success `{ data: T, meta?: { page, total, ... } }`, error `{ error: { message, code? } }`.
- **Event shape**: `{ app, entity, action, entityId, data, actorId, actorType, orgId, timestamp, ephemeral?, metadata? }`. Actor types are `"user" | "agent" | "system" | "mcp"`. Events are queued with `tx.queueEvent()` inside the transaction (transactional outbox); ephemeral events (typing, presence) go through `broadcastEphemeral()` and skip persistence.
- **App scopes** are hierarchical capability strings `app:resource:action`. Granting `app:resource` implicitly grants every child action.

## Gotchas

- **Bump the bundled-app version on ANY change destined for prod.** The UI bundle is served at a version-keyed URL (`/api/apps/<name>/<version>/ui.js`) with `Cache-Control: immutable, max-age=1y` (`ui-bundle-routes.ts`), so new content at the same version leaves every browser on the stale bundle forever and no hard refresh helps. A change that alters the app's package (UI, handlers, manifest, catalog, or a shared `packages/` or worker runtime file it inlines) bumps `version` in that app's `app.manifest.json` in the same commit. `bun run check:bundled-app-version --base origin/main` decides by the package's bytes: it freezes the app as it is and with the changed files at their base contents, so a change that leaves the package byte for byte the same (a comment the bundler drops, a test helper) asks for no bump. `manifest.test.ts` asserts the version's form, not its value, and takes no per-version comment line: the manifest is the one line two PRs can collide on. `app.manifest.json` is the version source; the app's `package.json` version is vestigial. Verifying a bundled-app fix means confirming the NEW version is active in `kernel.apps_active_version` and that the browser loads the new URL, never just that the server file contains the fix.
- **An invalid manifest installs but never registers.** The install path accepts the package and the runtime then fails registration, so the app looks installed while its tools, jobs and crons are silently absent. An error that reads "missing <table>" usually means the kernel rejected the manifest. Run `apps/api/src/modules/apps/bundled-manifests-valid.test.ts` after any manifest edit, and re-run the install once the manifest is fixed.
- **Never reset a shared database by hand.** A `db:reset` or a truncating suite on `liaison_dev` / `liaison_test` disturbs any other session using them. Runs through `scripts/test-run.ts` already work in their own namespace database; for a second run of the same checkout set `LIAISON_TEST_NS`.
- Manifest apps that declare gated tool summarizers: a trusted app exports them from `handlers.ts` or a `summarizers.ts` sibling (registration fails if the export cannot be loaded, deliberately); a sandboxed app (`trusted: false`, every bundled app) defines them IN its handler bundle, since the sandbox evaluates that bundle alone. `modules/approvals/summarizer-exports.test.ts` checks both.
- **Changes reach `main` only through a pull request and the merge queue.** Branch off `origin/main`, push the branch, open a PR against `main`, and land it with `bun run pr:land <number> [--wait]`: once every PR check is green it adds the PR to `main`'s merge queue, which runs the full `ci` gate on the PR on top of `main` and squash-merges it, or removes it when that fails (`--wait` follows it to the merge or the removal). `bun install` sets `core.hooksPath` to `scripts/git-hooks`, whose pre-push hook refuses any push to `main`; never bypass it with `--no-verify`.
- **Files concurrent PRs collide on take one file or line per entry.** New French goes in `scripts/i18n-fr/<feature>.json`, not the big table; new docs claims in `docs/.sources/<page>/<feature>.txt`; a new module's strings in a locale namespace file of its own when it has many. Never commit a regenerated `docs/reference/` page in a feature PR. The raw-insert ratchet is a list (`--write` drops cleaned files). Migrations still take the next number: rebase onto `origin/main` and renumber only your own unmerged migration, never one that has landed (prod records applied migrations by their journal `when`).
- Bundled-app tests are not auto-discovered. Wire them into `scripts/test-run.ts` or they never run.
