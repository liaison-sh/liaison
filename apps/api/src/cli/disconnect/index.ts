// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison disconnect <app>/<connection> <account> [--force] [--yes] [--org <slug>]`
 *
 * Disconnects one account the way Settings' Disconnect button does (the app's
 * cleanup, tokens cleared, grant revoked), by its address or identifier:
 *
 *  - an organization connection: the CLI runs privileged, as an admin;
 *  - a personal connection: its owner's to remove. The CLI does it only with
 *    `--force`, and writes an audit entry naming the owner
 *    (modules/apps/connections/disconnect-account.ts).
 *
 * It prints what gets deleted (what Liaison imported from the account; the
 * provider keeps the original) and asks to confirm; `--yes` confirms for a
 * script. Without a terminal and without `--yes` it refuses.
 */
import { createInterface } from "node:readline/promises"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import {
  type DisconnectTarget,
  decideDisconnect,
  disconnectImpact,
  findDisconnectTargets,
  performDisconnect,
} from "~/modules/apps/connections/disconnect-account"
import { ensureAppsForOrg } from "~/modules/apps/init"

export const DISCONNECT_USAGE =
  "usage: liaison disconnect <app>/<connection> <account> [--force] [--yes] [--org <slug>]\n" +
  "  <account>  the address or identifier (e.g. ana@example.com), or the connection id\n" +
  "  --force    disconnect someone's PERSONAL connection (recorded in the audit log)\n" +
  "  --yes      confirm without asking (scripts)"

export interface RunDisconnectArgs {
  ref: string
  account: string
  force?: boolean
  yes?: boolean
  orgSlug?: string
}

export interface DisconnectDeps {
  log: (msg: string) => void
  /** Asks the question; resolves true on yes. Null when there is no terminal. */
  confirm: ((question: string) => Promise<boolean>) | null
  ensureAppsForOrg: (orgId: string) => Promise<void>
}

const defaultDeps: DisconnectDeps = {
  log: (msg) => process.stderr.write(`${msg}\n`),
  confirm: process.stdin.isTTY
    ? async (question) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr })
        try {
          return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim())
        } finally {
          rl.close()
        }
      }
    : null,
  ensureAppsForOrg,
}

function describe(t: DisconnectTarget): string {
  return t.ownerType === "org"
    ? `${t.appName}/${t.connectionName} ${t.identifier} (organization connection)`
    : `${t.appName}/${t.connectionName} ${t.identifier} (personal connection of ${t.ownerEmail ?? t.ownerId})`
}

export function createDisconnect(deps: DisconnectDeps = defaultDeps) {
  return async function runDisconnect(args: RunDisconnectArgs): Promise<{ exitCode: number }> {
    const slash = args.ref.indexOf("/")
    if (slash <= 0 || slash >= args.ref.length - 1 || !args.account) {
      deps.log(DISCONNECT_USAGE)
      return { exitCode: 2 }
    }
    const appName = args.ref.slice(0, slash)
    const connectionName = args.ref.slice(slash + 1)
    const resolved = await resolveOrgId(
      args.orgSlug,
      "multiple orgs exist — pass --org <slug> to disambiguate",
    )
    if (!resolved.ok) {
      deps.log(`disconnect: ${resolved.message}`)
      return { exitCode: 2 }
    }
    const orgId = resolved.orgId
    await deps.ensureAppsForOrg(orgId)

    const targets = await findDisconnectTargets(orgId, appName, connectionName, args.account)
    if (targets.length === 0) {
      deps.log(`disconnect: no active ${args.ref} connection for '${args.account}'`)
      return { exitCode: 1 }
    }
    if (targets.length > 1) {
      deps.log(
        `disconnect: '${args.account}' matches ${targets.length} connections; pass the id of one:`,
      )
      for (const t of targets) deps.log(`  ${t.id}  ${describe(t)}`)
      return { exitCode: 2 }
    }
    const target = targets[0] as DisconnectTarget
    const decision = decideDisconnect(orgId, target, { kind: "cli" }, { force: args.force })
    if (!decision.allowed) {
      deps.log(`disconnect: ${decision.message}`)
      return { exitCode: 2 }
    }

    deps.log(`About to disconnect ${describe(target)}.`)
    deps.log(disconnectImpact(appName))
    if (decision.forced) {
      deps.log(
        `This is ${target.ownerEmail ?? "a member"}'s own account: the disconnect is recorded in the audit log.`,
      )
    }
    if (!args.yes) {
      if (!deps.confirm) {
        deps.log("disconnect: no terminal to confirm on; pass --yes to confirm")
        return { exitCode: 2 }
      }
      if (!(await deps.confirm("Disconnect and delete?"))) {
        deps.log("disconnect: cancelled, nothing changed")
        return { exitCode: 1 }
      }
    }

    await performDisconnect({
      orgId,
      target,
      actor: { kind: "cli" },
      forced: decision.forced,
    })
    deps.log(`Disconnected ${describe(target)}.`)
    return { exitCode: 0 }
  }
}

const productionDisconnect = createDisconnect()

export function runDisconnect(args: RunDisconnectArgs): Promise<{ exitCode: number }> {
  return productionDisconnect(args)
}
