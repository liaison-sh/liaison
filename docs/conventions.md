# Coding Conventions

## Naming

**Files:**
- Components: `PascalCase.tsx` (`Button.tsx`, `ThreadList.tsx`)
- Non-component modules: `kebab-case.ts` (`auth-store.ts`, `user.service.ts`)
- Test files: co-located. Frontend: `Button.test.tsx`. Backend: `users.test.ts`
- Drizzle schema: `kebab-case.ts` matching domain (`audit-log.ts`, `permissions.ts`)

**Code:**
- Functions/variables: `camelCase`
- Types/interfaces: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`
- Component props: `interface ButtonProps` (use `interface`, not `type`)
- Custom primitives: `create` prefix (`createPresence()`, `createWebSocket()`) — never React's `use`
- Signals: `[isOpen, setIsOpen]` — booleans use `is`/`has` prefix
- Stores: domain-named (`threadStore`) — actions use imperative verbs (`openTab()`, `addToast()`)
- Store resets: `resetXxxStore()` — registered via `onSessionTeardown(resetXxxStore)` for logout cleanup
- Hono routes: `export const users = new Hono<AppEnv>()`
- BullMQ queues: short lowercase nouns (`email`, `sync`). Jobs: `verb-noun` (`send-welcome`)
- Database tables: `snake_case`, plural (`audit_logs`). Columns: `snake_case` (`created_at`)

## Imports & Modules

- **Cross-package:** `import { userSchema } from "@liaison/shared"`
- **Intra-package:** `~/` alias mapped to `src/` — `import { Button } from "~/components/ui/Button"`
- Use `~/` (not `@/`) to avoid confusion with scoped `@liaison/...` packages
- **No barrel files** except `packages/shared` public API
- Kobalte: specific module paths — `import { Button } from "@kobalte/core/button"`
- Enforce `import type` for type-only imports (`verbatimModuleSyntax: true`)

## Types

- Zod schemas live in `packages/shared/src/validation/` and are consumed via the `@liaison/shared` barrel for cross-boundary validation — derive TS types with `z.infer<typeof schema>`
- Backend-only types are co-located with their module (e.g. `AppEnv` in `app.ts`, `ActorContext`/`RlsClient` in `db/`)
- Frontend-only types co-located with components/stores
- Hono `AppEnv` defines `Variables` (per-request: `userId`, `orgId`, `scopes`, `dimensionGrants`, `authVersion`, `permissionVersion`)
- Drizzle: use `typeof table.$inferInsert` and `typeof table.$inferSelect`
- Backend services accept `RlsClient` (branded type), never raw `db` — enforces RLS at compile time
- `ActorContext` is a discriminated union: `UserContext` (actorType: "user") or `SystemContext` (actorType: "system", purpose: "audit" | "timeline" | ...)
- Actor types across the system: `"user" | "agent" | "system" | "mcp"`
- `interface` for extendable shapes, `type` for unions/intersections/computed

## Error Handling

**Backend:** Throw `HTTPException` for known errors (400–409). Global `app.onError()` catches all. Never expose internals to the **external client** — but see "Error reporting" below for the agent + the log.

**Frontend:** `ErrorBoundary` for rendering errors, `createResource` `.error` for fetch failures. Never silently swallow.

**Error reporting & field observability — BINDING, applies EVERYWHERE** (host handlers, sandboxed-app RPC, `onError`, the agent tool bridge, the agent run loop — not just the chaos harness). An error is a product signal we improve from, so it is **never swallowed into a generic message**. Two obligations on every caught error:

1. **Surface actionable detail to the AGENT / tool result** — the operation/tool, HTTP status, error `code`, the upstream `body`, and the offending field/payload. NEVER a bare `"Tool execution failed"` / `"Internal error"` that discards the cause (the agent then loops or fabricates). Canonical implementation: `modules/agent/tools/tool-bridge.ts` — copy its shape (real status + code + body + message, plus an actionable next step for known classes like scope-denied).
2. **Capture it for the field** — `log.error({ err, ...context }, "…")` with enough structured context (tool/operation, org, actor, status, code, body, payload-shape) to become an actionable **bug report from real usage**. We fix the product from field failures, not only test ones.

The agent is a trusted internal operator and the log is internal, so both get the FULL detail; the **external client response** still gets only the safe message (no secrets/internals). The chaos harness's "improve the error-report system" rule merely enforces this product requirement under test — this convention is its source.

**Services:** Return discriminated results `{ success, data } | { success, error }` for expected failures. Throw only for invariant violations.

**Events:** Never publish events directly. Call `tx.queueEvent(event)` inside an RLS transaction — events commit atomically with data changes and are delivered by the outbox worker. For ephemeral events (typing, presence), use `broadcastEphemeral(event)`.

## Agent Tool Design

Design tool contracts for agents first. Token cost is part of the interface contract, not just an implementation detail.

- Default to compact outputs: return the smallest useful shape for the common path (usually IDs, titles, status, timestamps, counts, short snippets)
- Keep list results lean: 3-5 fields per item by default; expose opt-in expansion params for anything verbose
- Prefer summaries over raw payloads: do not return full provider objects, raw headers, or large HTML/text bodies unless explicitly requested
- Truncate large fields with metadata: include `isTruncated`, original size, or a `truncatedChars` hint so the agent knows more content exists
- Include precomputed aggregates: `totalCount`, unread counts, assignment state, latest activity, and status summaries should be returned directly when they eliminate follow-up reads
- Combine common read patterns into one tool when safe: if the agent almost always needs action feedback plus fresh state, return both in one response
- Use definitive empty states: return explicit zero-result structures rather than ambiguous empty payloads
- Keep mutations idempotent and structured: no interactive prompts, no human-oriented prose blobs, stable success/error shapes
- Separate summary and detail paths: prefer `search`/`list` tools for discovery and `read` tools for targeted detail instead of one tool that always returns everything
- Make expansion explicit in params: prefer flags like `includeMessages`, `includeBody`, `includeTimeline`, `messageLimit`, or `cursor` over oversized defaults
- Put next-step guidance in tool descriptions/skills: teach the agent when to use the compact tool first and when to escalate to the detailed one

## Formatting & Linting

Biome (replaces ESLint + Prettier). Config at workspace root.

- 2 spaces, 100 line width, double quotes, optional semicolons
- Import organization: enabled (auto-sorted by Biome)
- `biome check .` before committing, `biome check --write .` to auto-fix

## Monorepo

- Bun workspaces with `workspace:*` protocol
- Root `tsconfig.json` as base — `"module": "Preserve"`, `"moduleResolution": "bundler"`, `"noEmit": true`
- No TS project references — Bun + Vite handle transpilation, `tsc` for type-checking only
- Cross-workspace: `bun --filter '*' <script>`
- Dev: `bun --watch src/index.ts` (backend), `vite` (frontend)
