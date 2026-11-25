// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Why an app install failed, in words an operator can act on.
 *
 * The deploy's setup step (db/reconcile-catalog-boot.ts) stops a deploy when a
 * catalog app does not install, and prints what to do. Only one cause is fixed by
 * raising the app's version: a version directory that already holds other files
 * for that version (version-dir.ts). Every other cause, a database error above
 * all (a missing grant, a role that may not create a schema), is passed on as it
 * is, with its SQLSTATE and the database's own message: drizzle's error message
 * is only the failed query, the reason sits in its `cause`.
 */
import { pgErrorFacts } from "~/lib/transient-db-error"
import { VersionDirConflictError } from "~/modules/apps/version-dir"

export type InstallFailureKind = "version_conflict" | "database" | "other"

export interface InstallFailure {
  name: string
  version: string
  kind: InstallFailureKind
  error: string
}

const STATEMENT_MAX = 200

function isVersionConflict(err: unknown): boolean {
  let cur: unknown = err
  for (let depth = 0; cur != null && depth < 6; depth++) {
    if (cur instanceof VersionDirConflictError) return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

/** The failed statement's first line, without its bound parameters. */
function failedStatement(err: unknown): string | null {
  const raw = err instanceof Error ? err.message : ""
  const m = /^Failed query: ([^\n]*)/.exec(raw)
  if (!m?.[1]) return null
  const statement = m[1].trim()
  return statement.length > STATEMENT_MAX ? `${statement.slice(0, STATEMENT_MAX)}…` : statement
}

/** Classify an install error and describe it, the database's reason included. */
export function describeInstallError(err: unknown): { kind: InstallFailureKind; error: string } {
  const message = err instanceof Error ? err.message : String(err)
  if (isVersionConflict(err)) return { kind: "version_conflict", error: message }
  const facts = pgErrorFacts(err)
  if (facts && (facts.code || facts.message)) {
    const code = facts.code ? ` ${facts.code}` : ""
    const statement = failedStatement(err)
    return {
      kind: "database",
      error: `database error${code}: ${facts.message ?? "no message"}${statement ? ` (while running: ${statement})` : ""}`,
    }
  }
  return { kind: "other", error: message }
}

/**
 * The lines the setup step prints when it fails in `--strict` mode: every
 * failure with its cause, then the advice that fits each cause. The version
 * advice appears only for a version conflict.
 */
export function reconcileFailureReport(opts: {
  failed: readonly InstallFailure[]
  derivationsOk: boolean
  threw?: { kind: InstallFailureKind; error: string } | null
}): string[] {
  const prefix = "[reconcile-catalog-boot]"
  const lines: string[] = []
  if (opts.threw) lines.push(`${prefix} the catalog reconcile stopped: ${opts.threw.error}`)
  if (opts.failed.length > 0) {
    lines.push(`${prefix} ${opts.failed.length} catalog app(s) did not install:`)
    for (const f of opts.failed) {
      lines.push(`  - ${f.name}${f.version ? ` ${f.version}` : ""}: ${f.error}`)
    }
  }
  if (!opts.derivationsOk && !opts.threw) {
    lines.push(
      `${prefix} the catalog's instance-wide derivations (the files SELECT policy) were not applied (log above).`,
    )
  }
  const kinds = new Set([
    ...opts.failed.map((f) => f.kind),
    ...(opts.threw ? [opts.threw.kind] : []),
  ])
  const conflicts = opts.failed.filter((f) => f.kind === "version_conflict").map((f) => f.name)
  if (conflicts.length > 0) {
    lines.push(
      `${prefix} ${conflicts.join(", ")}: the image carries changed files under a version already installed. Raise that app's version and rebuild the image.`,
    )
  }
  if (kinds.has("database")) {
    lines.push(
      `${prefix} the database refused a statement (SQLSTATE and message above). Fix that cause, for example the grants of the role the deploy connects as, then run the deploy again; raising an app's version does not change it.`,
    )
  }
  if (lines.length === 0) lines.push(`${prefix} the setup step failed (log above).`)
  return lines
}
