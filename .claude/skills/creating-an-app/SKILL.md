---
name: creating-an-app
description: Walk a developer through building, testing, packaging, and installing a sandboxed Liaison plugin app — interactive, one decision at a time, grounded in the existing example app. Use when the user wants to build a liaison plugin app, create a new app, extend liaison, or add a new app to a Liaison fork.
---

# Creating a Liaison App

You are pairing with a developer to build a sandboxed plugin app on top of
Liaison. Drive the conversation one decision at a time; recommend a default;
let the developer course-correct.

## Before you start

Open `docs/app-development.md` once. It is the authoritative guide; this skill
is a conversational pairing layer on top of it. If you and the doc disagree, the
**doc wins** — patch the doc, don't drift the skill.

Open `apps/api/test-support/apps/example/` — the working reference app. Every handler
pattern you suggest, point the developer at the relevant file in `example/`.

## Phase 1 — Understand what they want to build

Ask one question: *"What does this app do? Name it in one sentence, and tell me
what it integrates with (if anything)."* Use the answer to settle:

- **App name** — kebab-case, starts with a letter (e.g. `shopify`).
- **External API?** — does it need an OAuth2 or credential connection?
- **Frontend panel?** — most apps have one; some are headless (jobs/tools only).

## Phase 2 — Scaffold

From the repo root:

```bash
bun run app:create <name>
```

This generates the backend app (`apps/api/src/apps/<name>/`) and the frontend
module (`apps/web/src/modules/<name>/`). Confirm the scaffolded test passes:
`bun test apps/api/src/apps/<name>/`.

## Phase 3 — First tool

Walk them through replacing the placeholder `items_list` handler with their
first real tool. Patterns (each maps to a handler in
`apps/api/test-support/apps/example/handlers.ts`):

- **Read-only tool** — `async (params, ctx) => ({ data: await ctx.db.findMany(...) })`
- **Mutation tool** — `ctx.db.insert(...)` then `await ctx.emit({ entity, action: "created", entityId })`
- **External-API tool** — `const token = await ctx.connections.<name>.getToken(); const res = await ctx.fetch(...)`
- **Scheduled job** — declare it under `jobs` in `app.manifest.json` with a cron `schedule`; the handler runs on that schedule
- **Long work** (a backfill, a big import, waiting on a provider) — never sleep or loop past the run's limit. Declare an `onDemand` job, start it with `ctx.jobs.enqueue(name, payload)`, and inside it use `ctx.steps.run(name, { budgetMs }, async (cursor) => ({ done, cursor, wakeIn? }))`: it saves the cursor and continues in a later run. `ctx.timers.wakeIn(seconds, name, payload)` runs a job later. See REFERENCE.md, "Long work"
- **Contacts** — `await ctx.resolveContact({ email })`

Every tool declares `requiredScopes` in the manifest, a non-empty list of `<app>:resource:action` scopes; the caller must hold all of them. The old single `scope` key is refused.

## Phase 4 — Test it

Use `apps/api/test-support/apps/example/handlers.test.ts` as the template — one test per
handler, driven by `mockAppContext` from `~/modules/apps/test-helpers`. Run it as
`.claude/skills/run-tests/SKILL.md` describes. Test
observable behavior — returned data, emitted events, db writes — never internals.

## Phase 5 — Panel

If the app has a UI, walk them through `apps/web/src/modules/<name>/Panel.tsx` —
a SolidJS component with a small scoped store. Reference
`apps/web/src/modules/example/`. The app registry that mounts a panel into the
shell lives at `apps/web/src/framework/app-registry.ts`.

An app installed from a package always runs framed, in the browser as in the
desktop and phone apps: a sandboxed iframe with an opaque origin, no cookie and
no network of its own. Its UI reaches Liaison only through the frame protocol
(`@liaison/host`: its own API routes and tools, connections, `navigate`, entity
changes, toasts), so design the panel around those calls, and give the app an
icon as manifest data (`iconSvg` or `iconName`). See
`docs/app-package-format.md`, "Where an app's interface runs".

## Phase 6 — Package + install

```bash
bun run app:freeze <name>                       # → dist/apps/<name>-<ver>.liaisonapp
bun run app:sign  dist/apps/<name>-<ver>.liaisonapp
```

To install on a running instance:

```bash
liaison app install <url> --grant <scope> --grant <scope>
```

The package format is specified in `docs/app-package-format.md`.

## When the SDK doesn't fit

If you hit a wall — `AppContext` doesn't expose what the app needs — **STOP** and
file a row in `docs/sdk-gaps.md`. Then either propose extending the SDK
(preferred) or document a justified workaround. Do NOT bypass the sandbox or
import kernel internals. This is the rule Phases 15–17 are held to, and the app
you are building is held to it too.

## Document it (in-tree apps)

An app that ships in this repo (`bundled-apps/<name>/` or `apps/api/src/apps/<name>/`) is not done until its user page exists:

1. Write `docs/apps/<name>.md` (frontmatter `title`, `description`), with task sections, then Settings, Permissions and What agents can do. Cite every claim in `docs/.sources/apps/<name>.txt` (`path:line`).
2. Add the page to `docs/nav.ts` under Apps, and map the app's directories to it in `.claude/docs-map.ts`.
3. Run `bun run docs:gen` (its settings, scopes and tools land in the generated references) and `bun run check:docs --base origin/main`.

An app built outside this repo documents itself in its own README.

## Reference

For deeper patterns (entity declaration, event subscribers, connections, job
scheduling), open `REFERENCE.md` next to this skill.
