// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The reusable provisioner spine: the per-run context, the `Provisioner`
 * contract, and the report fragment shape. No provisioner LOGIC lives here —
 * concrete provisioners (org, admin, …) arrive in later tasks and plug into the
 * driver's registry (`cli/config/apply.ts`).
 *
 * Handle discipline (no `as`/`as unknown as`): the context exposes three DB
 * seams — `rls` (branded `RlsClient` via `withRlsContext`, admin actor),
 * `priv` (`withPrivilegedDb`, org-scoped) and `sys` (`withSystemDb`,
 * org-less). A provisioner picks the seam its primitive requires; the seams
 * own the role switch + branding so no callsite ever casts a transaction.
 */

import { eq } from "drizzle-orm"
import { ConfigError } from "~/cli/config/parse"
import type { VerifyProbe } from "~/cli/provisioners/verify-probes"
import type { PrivilegedDb, RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { organizations } from "~/db/schema/kernel"

/**
 * A connection/flow that could not be completed headlessly. `kind: "oauth"` is
 * an app connection awaiting interactive consent (`connection` is the manifest
 * connection name). `kind: "credentials"` is a credentials connection whose
 * secrets are all still empty env refs (`${VAR:-}`) — listed so the config can
 * enumerate every app and be applied incrementally as each secret is pasted,
 * mirroring the oauth skip convention. `kind: "source"` is a knowledge
 * synced-source that could not be registered headlessly (its app connection is
 * not active, or headless registration is not available) — `connection` is
 * omitted for that kind.
 */
export interface PendingItem {
  kind: "oauth" | "credentials" | "source"
  app: string
  connection?: string
  /** The connection's identifier (an address, a slug) when one is known. */
  identifier?: string
  action: string
  message?: string
}

/** Per-section result fragment returned by a provisioner's `apply`. */
export interface ProvisionResult {
  /** This provisioner's report section, keyed by `Provisioner.key`. */
  section?: unknown
  /** Dotted keys for things this run created/updated, e.g. `admin.created`. */
  changed?: string[]
  /** Dotted keys for things already in the desired state. */
  unchanged?: string[]
  /** Connections/flows awaiting a human/interactive step. */
  pending?: PendingItem[]
}

/** The read-only plan a provisioner computes before any write. */
export interface ProvisionPlan {
  /** Human-readable intended actions (for `--dry-run` reporting, to stderr). */
  actions: string[]
  /** How many entries the apply would create or change. Set only by a plan
   *  that diffs against the stored rows (the tool path's roles, email, apps,
   *  agents, knowledge collections and invoicing issuer profiles): 0 there
   *  means the apply is a no-op. Absent: the plan echoes its params. */
  changes?: number
}

/**
 * The person a stored connection is recorded against (its creator). The CLI
 * acts as the file's `admin`, else the org's first active admin (the `admin`
 * provisioner resolves it); with neither there is nobody accountable, so the
 * step fails before writing instead of inserting a connection with no creator.
 */
export function connectingPersonOrFail(ctx: ProvisionContext, what: string): string {
  if (ctx.actor.userId) return ctx.actor.userId
  throw new ConfigError(
    `${what} needs a person to connect it: add an \`admin\` section (email, name) to the config file, or give the org an active admin`,
  )
}

/**
 * Per-run context shared across provisioners.
 *
 * `orgId` starts empty and is set by the `org` provisioner's apply; `actor`
 * starts with an empty `userId` and is set by the `admin` provisioner. The
 * `rls`/`priv`/`sys` seams therefore read `orgId`/`actor` LAZILY at call time
 * (correction #5) so a downstream provisioner gets the org-provisioner-set
 * orgId, never the initial empty string.
 */
export interface ProvisionContext {
  /** Set by the org provisioner. Read lazily by the DB seams. */
  orgId: string
  /** `userId` is the ensured admin id (set by the admin provisioner). The CLI
   *  acts with the wildcard scope and data grant; an agent tool acts as the real
   *  person (the approver of a gated call, else the caller) with their own
   *  scopes and dimension grants. */
  actor: { userId: string; scopes: string[]; dimensionGrants: Record<string, string[]> }
  /** True when an agent tool runs the provisioners inside a live org (never the
   *  CLI): no secrets and no server files are available, `orgId` is set before
   *  any plan, and plans diff against the stored rows. */
  toolPath: boolean
  /** Structured progress logging — writes to stderr (the driver owns the split). */
  log: (msg: string) => void
  /** Whether BYOK keys should be live-validated (global `--no-validate-byok` → false). */
  validateByok: boolean
  /**
   * The directory of the config file being applied. Relative file references in
   * the config (e.g. `knowledge.documents[].contentFile`) resolve against THIS
   * dir, and absolute-escape path traversal is rejected against it (Task 12).
   * Defaults to `process.cwd()` when no config path is known (tests / piped input).
   */
  configDir: string
  /** The connection health check run after the apps section applies a
   *  credentials connection (`config apply` sets the `config verify` one).
   *  Absent: no post-apply health check (the tool path, provisioner tests). */
  connectionProbe?: VerifyProbe
  /** Run `fn` under the admin RLS context for the current org (branded RlsClient). */
  rls: <T>(fn: (tx: RlsClient) => Promise<T>) => Promise<T>
  /** Run `fn` under a privileged, org-scoped transaction. */
  priv: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>
  /** Run `fn` under a system (org-less) privileged transaction. */
  sys: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>
}

/**
 * A provisioner for one config section.
 *
 * `plan` is READ-ONLY: it computes create/update/skip and surfaces plan-time
 * validation errors by THROWING `ConfigError(exitCode: 2)` (e.g. an unknown
 * role name) — so `--dry-run` and the abort-before-write guarantee both work.
 * `apply` performs the idempotent writes and returns a result fragment.
 *
 * Both `plan` and `apply` receive the validated config so a provisioner stays
 * stateless (no closure over config); each reads only its own slice.
 *
 * `Cfg` is the slice of the validated config this provisioner consumes.
 */
export interface Provisioner<Cfg = unknown> {
  key: string
  plan(ctx: ProvisionContext, cfg: Cfg): Promise<ProvisionPlan>
  apply(ctx: ProvisionContext, plan: ProvisionPlan, cfg: Cfg): Promise<ProvisionResult>
  /**
   * Optional second pass, run once every section of the run has applied, for
   * entries that depend on a LATER section (a user whose role is an app role of
   * a catalog app the `apps` section installs). Its section merges into the
   * one `apply` returned.
   */
  applyLate?(ctx: ProvisionContext, cfg: Cfg): Promise<ProvisionResult>
}

/**
 * The DB seams the context wires up. Injectable so the driver is unit-testable
 * without a live database (the test passes fakes that record their arguments);
 * default to the real `withRlsContext`/`withPrivilegedDb`/`withSystemDb`. This
 * is a constructor seam, NOT a cast — no `as` anywhere.
 */
export interface ProvisionDbSeams {
  withRlsContext: <T>(ctx: ActorContext, fn: (tx: RlsClient) => Promise<T>) => Promise<T>
  withPrivilegedDb: <T>(
    orgId: string,
    reason: string,
    fn: (tx: PrivilegedDb) => Promise<T>,
  ) => Promise<T>
  withSystemDb: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>
}

// Getters: each seam is the handle as it is when the context uses it, never a
// copy taken at load, which would keep whatever stood in for the handle when
// this module was first imported (a wrapper put in place and later removed).
const defaultSeams: ProvisionDbSeams = {
  get withRlsContext() {
    return withRlsContext
  },
  get withPrivilegedDb() {
    return withPrivilegedDb
  },
  get withSystemDb() {
    return withSystemDb
  },
}

/**
 * Build the per-run context. The DB seams capture `ctx` by reference and read
 * `ctx.orgId`/`ctx.actor` at CALL time, so a provisioner that runs after `org`
 * (orgId set) / `admin` (userId set) automatically scopes to the right values
 * — correction #5: `ctx.orgId` must not be captured at construction (when it
 * is the empty string).
 */
export function buildProvisionContext(opts: {
  log: (msg: string) => void
  validateByok: boolean
  seams?: ProvisionDbSeams
  /** Config-file directory for relative file resolution (defaults to cwd). */
  configDir?: string
  /** Post-apply connection health check (see `ProvisionContext.connectionProbe`). */
  connectionProbe?: VerifyProbe
}): ProvisionContext {
  const seams = opts.seams ?? defaultSeams
  const ctx: ProvisionContext = {
    orgId: "",
    actor: { userId: "", scopes: [], dimensionGrants: { "*": ["*"] } },
    toolPath: false,
    log: opts.log,
    validateByok: opts.validateByok,
    configDir: opts.configDir ?? process.cwd(),
    ...(opts.connectionProbe ? { connectionProbe: opts.connectionProbe } : {}),
    rls: (fn) =>
      seams.withRlsContext(
        {
          actorType: "user",
          userId: ctx.actor.userId,
          orgId: ctx.orgId,
          scopes: ctx.actor.scopes,
          dimensionGrants: ctx.actor.dimensionGrants,
        },
        fn,
      ),
    priv: (reason, fn) => seams.withPrivilegedDb(ctx.orgId, reason, fn),
    sys: (reason, fn) => seams.withSystemDb(reason, fn),
  }
  return ctx
}

/**
 * The org a read-only plan step works on. `ctx.orgId` wins whenever it is set:
 * the config's `org.slug` is only a way for the CLI to find an org it has not
 * created yet. On the tool path `ctx.orgId` is always set before any plan, so
 * an empty one there is a wiring bug and fails loudly instead of resolving an
 * org by a slug the caller wrote. Returns "" when the org does not exist yet.
 */
export async function resolvePlanOrgId(
  ctx: ProvisionContext,
  slug: string,
  reason: string,
): Promise<string> {
  if (ctx.orgId !== "") return ctx.orgId
  if (ctx.toolPath) {
    throw new Error(`${reason}: the tool path must set the org before planning`)
  }
  const [row] = await ctx.sys(reason, (db) =>
    db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1),
  )
  return row?.id ?? ""
}
