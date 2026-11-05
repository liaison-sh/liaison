// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison setup state [--org <slug>] [--json]`: what is set up and what is
 * left, read the way the in-product agent reads it (`kernel__setup_state`):
 *
 *  - the workspace checklist and each OAuth connection's next step
 *    (provisioning/setup-state.ts), plus every credentials connection of an
 *    app that is on and whether it is connected;
 *  - the server surfaces (connection-guides/server-setup.ts) with their state
 *    from this server's env.
 *
 * Left counts only what the person chose (`setup.features`, the basics until
 * they answer); every other feature is a menu with its time. Each open item
 * names the command that prints its steps. Read only; nothing
 * secret is read or printed. A setup run calls it after every human
 * checkpoint, and its last call is the report's "what is left".
 */
import { and, eq } from "drizzle-orm"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { appConnectionSetup, orgConnections } from "~/modules/connection-guides/plan"
import { type ServerSurface, serverSetup } from "~/modules/connection-guides/server-setup"
import { SERVER_ESTIMATES } from "~/modules/connection-guides/setup-timings"
import { computeSetupState, type SetupState } from "~/modules/provisioning/setup-state"

export const SETUP_STATE_USAGE = "usage: liaison setup state [--org <slug>] [--json]"

export interface SetupStateReport {
  workspace: SetupState
  /** Every connection of the apps that are on, with the command for its steps. */
  connections: Array<{
    app: string
    connection: string
    type: "oauth2" | "credentials"
    optional: boolean
    connected: boolean
    /** oauth2 only: the in-app next step (setup-state.ts). */
    next?: string
    guide: string
    connect?: string
  }>
  server: ServerSurface[]
  /** What is left: the required checklist and server items, and the open steps
   *  of the features the person chose (setup.features; the basics until they
   *  answer), one line each. */
  left: string[]
  /** Estimated minutes of the person's own time the left items take (setup-timings.ts). */
  leftMinutes: [number, number]
  /** Everything else that works here and is not done, with its time: offered, never owed. */
  /** `done`/`open`: a partly done feature's connected and still open connections. */
  menu: Array<{
    id: string
    label: string
    minutes?: [number, number]
    done?: string[]
    open?: string[]
  }>
}

async function activeConnections(orgId: string): Promise<Set<string>> {
  const rows = await withPrivilegedDb(orgId, "cli-setup-state-connections", (tx) =>
    tx
      .select({ app: connectedAccounts.appName, connection: connectedAccounts.connectionName })
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.orgId, orgId), eq(connectedAccounts.status, "active"))),
  )
  return new Set(rows.map((r) => `${r.app}/${r.connection}`))
}

export async function buildSetupState(orgId: string): Promise<SetupStateReport> {
  await ensureAppsForOrg(orgId)
  const workspace = await computeSetupState(orgId)
  const active = await activeConnections(orgId)
  const oauthNext = new Map(workspace.connections.map((c) => [`${c.app}/${c.connection}`, c]))
  const connections: SetupStateReport["connections"] = []
  for (const [app, connection] of orgConnections(orgId)) {
    const decl = connectionConfigRegistry.get([orgId, app, connection])
    const setup = appConnectionSetup(orgId, app, connection)
    if (!decl || !setup) continue
    const key = `${app}/${connection}`
    const state = oauthNext.get(key)
    connections.push({
      app,
      connection,
      type: decl.type,
      optional: decl.optional === true,
      connected: state ? state.connected : active.has(key),
      ...(state ? { next: state.next } : {}),
      guide: setup.guideCommand,
      ...(decl.type === "oauth2" ? { connect: `liaison connect ${key} --config <path>` } : {}),
    })
  }
  const server = serverSetup(env)
  const plan = workspace.features
  const guideOf = new Map(connections.map((c) => [`${c.app}/${c.connection}`, c.guide]))
  const left: string[] = []
  if (plan.chosen === null) {
    left.push(
      `features: not chosen yet, the basics (${plan.counted.join(", ")}) are counted; ask which features they want and record it (config setup.features)`,
    )
  }
  for (const item of workspace.items) {
    if (!item.done && !item.optional) left.push(`workspace ${item.key}: ${item.detail}`)
  }
  for (const s of server) {
    if (s.done === false && !s.optional)
      left.push(`server ${s.id}: ${s.detail} (liaison guide server)`)
  }
  for (const step of plan.left) {
    if (step.item) {
      left.push(`feature ${step.feature}: workspace ${step.item} not done`)
    } else if (step.unavailable) {
      left.push(
        `feature ${step.feature}: its app is off (${step.refs.join(" or ")}); turn it on first (config apps)`,
      )
    } else {
      const ways = step.refs.map((r) => `${r} (${guideOf.get(r) ?? `liaison guide ${r}`})`)
      left.push(
        `feature ${step.feature}: connect ${ways.join(" or ")}${step.done ? ` (already connected: ${step.done.join(", ")})` : ""}`,
      )
    }
  }
  for (const c of workspace.connections) {
    for (const { scope: missing, setting, settingOn } of c.missingProtectedScopes ?? []) {
      left.push(
        `connection ${c.app}/${c.connection}: lacks ${missing} (setting ${setting}${settingOn ? " is on: reconnect" : " is off"})`,
      )
    }
  }
  const leftMinutes: [number, number] = [...plan.leftMinutes]
  for (const s of server) {
    const m = s.done === false && !s.optional ? SERVER_ESTIMATES[s.id]?.minutes : undefined
    if (m) {
      leftMinutes[0] += m[0]
      leftMinutes[1] += m[1]
    }
  }
  const menu: SetupStateReport["menu"] = plan.menu.map((m) => ({
    id: `feature ${m.feature}`,
    label: m.label,
    ...(m.minutes ? { minutes: m.minutes } : {}),
    ...(m.done ? { done: m.done, open: (m.open ?? []).map((refs) => refs.join(" or ")) } : {}),
  }))
  for (const s of server) {
    if (s.done !== false || !s.optional) continue
    const m = SERVER_ESTIMATES[s.id]?.minutes
    menu.push({
      id: `server ${s.id}`,
      label: s.detail,
      ...(m && m[1] > 0 ? { minutes: m } : {}),
    })
  }
  return { workspace, connections, server, left, leftMinutes, menu }
}

export function renderSetupState(r: SetupStateReport): string[] {
  const mark = (done: boolean | null) => (done === null ? "?" : done ? "x" : " ")
  const lines = ["Workspace"]
  for (const i of r.workspace.items) {
    lines.push(`  [${mark(i.done)}] ${i.key}${i.optional ? " (optional)" : ""}: ${i.detail}`)
  }
  lines.push("", "Connections (apps that are on)")
  for (const c of r.connections) {
    lines.push(
      `  [${mark(c.connected)}] ${c.app}/${c.connection} (${c.type}${c.optional ? ", optional" : ""})${c.next && !c.connected ? ` next: ${c.next}` : ""}: ${c.guide}`,
    )
  }
  for (const c of r.workspace.connections) {
    for (const { scope: missing, setting, settingOn } of c.missingProtectedScopes ?? []) {
      lines.push(
        `  ! ${c.app}/${c.connection} lacks ${missing}: ${settingOn ? "reconnect it to grant it" : `turn on the ${setting} setting, then reconnect`} (liaison guide ${c.app === "shopify" ? "shopify" : `${c.app}/${c.connection}`})`,
      )
    }
  }
  lines.push("", "Server (liaison guide server for the steps)")
  for (const s of r.server) {
    lines.push(`  [${mark(s.done)}] ${s.id}${s.optional ? " (optional)" : ""}: ${s.detail}`)
  }
  lines.push(
    "",
    !r.left.length
      ? "Nothing left."
      : r.leftMinutes[1] > 0
        ? `Left (about ${r.leftMinutes[0]} to ${r.leftMinutes[1]} min of your own time, estimated, plus provider waits):`
        : "Left:",
  )
  for (const l of r.left) lines.push(`  - ${l}`)
  if (r.menu.length) {
    lines.push("", "You can also add (a menu to offer, not a to-do):")
    for (const m of r.menu) {
      lines.push(
        `  - ${m.id}: ${m.label}${m.done ? ` (partly done: ${m.done.join(", ")} connected; left: ${(m.open ?? []).join("; ")})` : ""}${m.minutes ? ` (about ${m.minutes[0]} to ${m.minutes[1]} min)` : ""}`,
      )
    }
  }
  return lines
}

export async function runSetupState(args: {
  orgSlug?: string
  json?: boolean
}): Promise<{ exitCode: number }> {
  const resolved = await resolveOrgId(
    args.orgSlug,
    "multiple orgs exist — pass --org <slug> to disambiguate",
  )
  if (!resolved.ok) {
    process.stderr.write(`setup state: ${resolved.message}\n`)
    return { exitCode: 2 }
  }
  const report = await buildSetupState(resolved.orgId)
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else process.stdout.write(`${renderSetupState(report).join("\n")}\n`)
  return { exitCode: 0 }
}
