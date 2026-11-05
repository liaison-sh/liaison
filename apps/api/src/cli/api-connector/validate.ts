// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison api-connector validate <file>`: the adapter schema and role rules,
 * OFFLINE. This module and everything it imports read no environment (no
 * secrets, no database, no Redis), so the CLI entry runs it before loading
 * the rest of the CLI: a developer validates an adapter from a bare checkout.
 *
 * Exit codes: 0 valid, 1 adapter issues (the path-precise list on STDOUT),
 * 2 usage or an unreadable file.
 */

import { readFileSync } from "node:fs"
import { parseAdapterDocument } from "~/apps/api-connector/adapter-policy"

export const API_CONNECTOR_USAGE = `usage: liaison api-connector validate <adapter file>
       liaison api-connector test <identifier> <operation> [--param name=value ...] [--pages N | --all-pages] [--dry-run] [--org <slug>]`

export interface CliRunResult {
  exitCode: number
  report: unknown
  message?: string
}

export function runApiConnectorValidate(file: string): CliRunResult {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (err) {
    return {
      exitCode: 2,
      report: { ok: false },
      message: `cannot read '${file}': ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const r = parseAdapterDocument(text)
  if (!r.ok) return { exitCode: 1, report: { ok: false, issues: r.issues } }
  const a = r.adapter
  return {
    exitCode: 0,
    report: {
      ok: true,
      adapter: {
        id: a.id,
        name: a.name,
        version: a.version,
        baseUrl: a.baseUrl,
        auth: a.auth.type,
        roles: a.operations.flatMap((o) => (o.role ? [o.role] : [])),
        operations: a.operations.map((o) => ({
          name: o.name,
          kind: o.kind,
          ...(o.role ? { role: o.role } : {}),
        })),
      },
    },
  }
}

/**
 * The `api-connector` subcommands that need no environment: `validate <file>`,
 * and the usage line for anything that is not `test`. Null for `test`, which
 * the full CLI runs (it reads the database).
 */
export function runApiConnectorOffline(args: readonly string[]): CliRunResult | null {
  const [sub, file] = args
  if (sub === "test") return null
  if (sub === "validate" && file && !file.startsWith("--")) return runApiConnectorValidate(file)
  return { exitCode: 2, report: null, message: API_CONNECTOR_USAGE }
}
