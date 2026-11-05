// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison app status [name]` and `liaison app rollback <name>` (S8, S9): the
 * instance's installed apps and their state, and a rollback to the previous
 * version. The same service calls as the App store's API (activation.ts); the
 * CLI runs on the server, so it acts as the instance operator.
 *
 * A rollback in this process first registers the app's current version in every
 * org that has it On, so the health gate judges the previous version against
 * them, exactly as in a server process. The other server processes then follow
 * the new active version (the activation announces it; this command announces it
 * once more before exiting, so the message is not lost to process.exit).
 *
 * STDOUT carries the JSON report; a failure's message goes to STDERR.
 * Exit codes: 0 success, 1 runtime failure (not installed, refused, switched
 * back), 2 usage.
 */
import type { AppVersionState } from "~/modules/apps/activation"

export const APP_STATUS_USAGE = "usage: liaison app status [name]"
export const APP_ROLLBACK_USAGE = "usage: liaison app rollback <name>"

export interface AppCliResult {
  exitCode: number
  report: unknown
  message?: string
}

/** A persisted load failure in one org (kernel.apps problem columns). */
export interface OrgLoadProblem {
  app: string
  org: string
  code: string
  message: string | null
}

/** What the commands call; the defaults are the real services, a test passes fakes. */
export interface AppManageDeps {
  listStates(names?: string[]): Promise<AppVersionState[]>
  loadProblems(names?: string[]): Promise<OrgLoadProblem[]>
  rollback(name: string): Promise<{ version: string; previousVersion: string | null }>
}

export type AppRunState = "running" | "failed_to_load" | "upgrade_failed"

/** One app's line of the status report. */
export interface AppStatusLine {
  name: string
  state: AppRunState
  version: string | null
  previousVersion: string | null
  canRollBack: boolean
  noRollback: boolean
  upgradeFailed: { version: string; reasonCode: string | null; reasonMessage: string | null } | null
  failedIn: { org: string; code: string; message: string | null }[]
}

/** The state the App store shows: a load failure first, then a failed upgrade, else running. */
export function statusLines(
  states: readonly AppVersionState[],
  problems: readonly OrgLoadProblem[],
): AppStatusLine[] {
  const names = [...new Set([...states.map((s) => s.name), ...problems.map((p) => p.app)])].sort()
  return names.map((name) => {
    const s = states.find((x) => x.name === name)
    const failedIn = problems
      .filter((p) => p.app === name)
      .map((p) => ({ org: p.org, code: p.code, message: p.message }))
    const upgradeFailed = s?.upgradeFailed
      ? {
          version: s.upgradeFailed.version,
          reasonCode: s.upgradeFailed.reasonCode,
          reasonMessage: s.upgradeFailed.reasonMessage,
        }
      : null
    return {
      name,
      state: failedIn.length > 0 ? "failed_to_load" : upgradeFailed ? "upgrade_failed" : "running",
      version: s?.version ?? null,
      previousVersion: s?.previousOnDisk ? s.previousVersion : null,
      canRollBack: !!s?.previousOnDisk && !s.noRollback,
      noRollback: s?.noRollback ?? false,
      upgradeFailed,
      failedIn,
    }
  })
}

function positional(args: readonly string[]): string | undefined {
  const a = args[0]
  return a && !a.startsWith("--") ? a : undefined
}

/** `app status [name]`. `args` follows the subcommand. */
export async function runAppStatus(
  args: readonly string[],
  deps: AppManageDeps,
): Promise<AppCliResult> {
  const name = positional(args)
  const names = name ? [name] : undefined
  const [states, problems] = await Promise.all([deps.listStates(names), deps.loadProblems(names)])
  const apps = statusLines(states, problems)
  if (name && apps.length === 0) {
    return {
      exitCode: 1,
      report: { ok: false, apps: [] },
      message: `${name} is not an installed app on this server (built-in apps have one version and no rollback).`,
    }
  }
  return { exitCode: 0, report: { ok: true, apps } }
}

/** `app rollback <name>`. */
export async function runAppRollback(
  args: readonly string[],
  deps: AppManageDeps,
): Promise<AppCliResult> {
  const name = positional(args)
  if (!name) return { exitCode: 2, report: null, message: APP_ROLLBACK_USAGE }
  try {
    const result = await deps.rollback(name)
    return {
      exitCode: 0,
      report: {
        ok: true,
        name,
        version: result.version,
        rolledBackFrom: result.previousVersion,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = typeof err === "object" && err && "code" in err ? String(err.code) : "failed"
    const running =
      typeof err === "object" && err && "runningVersion" in err ? err.runningVersion : undefined
    return {
      exitCode: 1,
      report: {
        ok: false,
        name,
        code,
        ...(running !== undefined ? { runningVersion: running } : {}),
      },
      message,
    }
  }
}

/**
 * Operator CLI sweep: every org whose `kernel.apps` row has the app On. The org
 * ids come from the database, never from the command line.
 */
async function listOrgsWithAppOn(name: string): Promise<string[]> {
  const { and, eq } = await import("drizzle-orm")
  const { withSystemDb } = await import("~/db/privileged")
  const { apps } = await import("~/db/schema/kernel")
  const rows = await withSystemDb("cli-app-rollback-orgs", (db) =>
    db
      .select({ orgId: apps.orgId })
      .from(apps)
      .where(and(eq(apps.name, name), eq(apps.status, "active"))),
  )
  return rows.map((r) => r.orgId)
}

/** The real services. Imported lazily: they read the validated environment. */
export async function defaultAppManageDeps(): Promise<AppManageDeps> {
  const { and, eq, inArray, isNotNull } = await import("drizzle-orm")
  const { withSystemDb } = await import("~/db/privileged")
  const { apps, organizations } = await import("~/db/schema/kernel")
  const activation = await import("~/modules/apps/activation")
  const { publishRedis } = await import("~/lib/redis")
  const { ensureAppsForOrg } = await import("~/modules/apps/init")

  return {
    listStates: (names) => activation.listAppVersionStates(names),
    loadProblems: async (names) => {
      const rows = await withSystemDb("cli-app-problems", (db) =>
        db
          .select({
            app: apps.name,
            org: organizations.slug,
            code: apps.problemCode,
            message: apps.problemMessage,
          })
          .from(apps)
          .innerJoin(organizations, eq(organizations.id, apps.orgId))
          .where(and(isNotNull(apps.problemCode), names ? inArray(apps.name, names) : undefined)),
      )
      return rows.flatMap((r) => (r.code ? [{ ...r, code: r.code }] : []))
    },
    rollback: async (name) => {
      // Register the app in every org that has it On, so the gate judges there.
      const orgIds = await listOrgsWithAppOn(name)
      for (const orgId of orgIds) await ensureAppsForOrg(orgId)
      const result = await activation.rollbackApp(name, { id: null, kind: "operator" })
      await publishRedis(activation.ACTIVE_VERSIONS_CHANNEL, "{}")
      return result
    },
  }
}
