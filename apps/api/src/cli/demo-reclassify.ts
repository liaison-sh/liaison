// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison demo reclassify --since <instant> --until <instant> [--org <id>] [--apply]`
//
// Gives the class `demo` to the visitor workspaces the previous release made
// during a rolling deploy (modules/demo/reclassify.ts). A dry run unless
// `--apply`. STDOUT carries one JSON report.

import {
  listWindowOrgs,
  ReclassifyRefusedError,
  reclassifyWindowOrgs,
} from "~/modules/demo/reclassify"

export const DEMO_RECLASSIFY_USAGE =
  "usage: liaison demo reclassify --since <instant> --until <instant> [--org <id>] [--apply]"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** An instant with its zone: a bare date would silently mean a whole other window. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

export interface DemoReclassifyCliResult {
  exitCode: number
  report: Record<string, unknown> | null
  message?: string
}

function instant(raw: string | undefined): Date | null {
  if (!raw || !INSTANT.test(raw)) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function runDemoReclassifyCli(argv: string[]): Promise<DemoReclassifyCliResult> {
  const usage = (message = DEMO_RECLASSIFY_USAGE) => ({ exitCode: 2, report: null, message })
  let since: Date | null = null
  let until: Date | null = null
  let orgId: string | undefined
  let apply = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--since") since = instant(argv[++i])
    else if (a === "--until") until = instant(argv[++i])
    else if (a === "--org") orgId = argv[++i] ?? ""
    else if (a === "--apply") apply = true
    else return usage()
  }
  if (!since || !until) {
    return usage(
      `${DEMO_RECLASSIFY_USAGE}\n--since and --until are instants with a zone, such as 2026-01-31T09:00:00Z`,
    )
  }
  if (since > until) return usage("--since is after --until")
  if (orgId !== undefined && !UUID.test(orgId)) return usage("--org takes an organization's id")
  const window = { since, until, ...(orgId !== undefined ? { orgId } : {}) }
  try {
    const orgs = apply ? await reclassifyWindowOrgs(window) : await listWindowOrgs(window)
    return {
      exitCode: 0,
      report: {
        applied: apply,
        since: since.toISOString(),
        until: until.toISOString(),
        count: orgs.length,
        orgs,
      },
    }
  } catch (err) {
    if (err instanceof ReclassifyRefusedError) {
      return { exitCode: 2, report: null, message: err.message }
    }
    throw err
  }
}
