// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison org caps <org> [--seats N] [--mailboxes N] [--storage-gb N]
//                         [--jobs-per-hour N] [--unset <cap>]...`
//
// The operator's per-org caps (modules/org/caps.ts). Without a change flag it
// prints the org's caps and usage; with one it changes the named caps and
// keeps the others. `--unset` puts a cap back to unlimited. A cap is a whole
// number of at least 1: 0 is refused (unlimited is `--unset`, not 0). Caps set below the
// current usage evict nothing: new additions are refused until usage drops.
// STDOUT carries one JSON report.

import { ORG_CAP_KINDS, type OrgCapKind } from "@liaison/shared"
import { eq } from "drizzle-orm"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import { withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { getOrgUsage, readOrgCaps, setOrgCaps } from "~/modules/org/caps"

export const ORG_CAPS_USAGE =
  "usage: liaison org caps <org slug or id> [--seats <n>] [--mailboxes <n>] [--storage-gb <n>] [--jobs-per-hour <n>] [--custom-apps <n>] [--audit-days <n>] [--unset <seats|mailboxes|storage-gb|jobs-per-hour|custom-apps|audit-days>]..."

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** CLI flag name of each cap. */
const FLAG_OF: Record<OrgCapKind, string> = {
  seats: "--seats",
  mailboxes: "--mailboxes",
  storageGb: "--storage-gb",
  jobsPerHour: "--jobs-per-hour",
  customApps: "--custom-apps",
  auditDays: "--audit-days",
}
const KIND_OF_FLAG = new Map(ORG_CAP_KINDS.map((k) => [FLAG_OF[k], k] as const))
const KIND_OF_NAME = new Map(ORG_CAP_KINDS.map((k) => [FLAG_OF[k].slice(2), k] as const))

export interface OrgCapsCliResult {
  exitCode: number
  report: Record<string, unknown> | null
  message?: string
}

async function resolveCapsOrgId(ref: string): Promise<string | null> {
  if (UUID.test(ref)) {
    const [row] = await withSystemDb("cli-org-caps-org", (tx) =>
      tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, ref)),
    )
    return row?.id ?? null
  }
  const r = await resolveOrgId(ref, "")
  return r.ok ? r.orgId : null
}

export async function runOrgCapsCli(argv: string[]): Promise<OrgCapsCliResult> {
  const usage = (message = ORG_CAPS_USAGE) => ({ exitCode: 2, report: null, message })
  const set: Partial<Record<OrgCapKind, number>> = {}
  const unset: OrgCapKind[] = []
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    const kind = KIND_OF_FLAG.get(a)
    if (kind) {
      const raw = argv[++i]
      const n = Number(raw)
      // A cap is a whole number of at least 1. 0 is refused: it would
      // read as "nobody" for seats and as "no limit" for jobs; unlimited is
      // the cap's absence (--unset).
      if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) {
        return usage(
          `${a} takes a whole number of at least 1; --unset ${FLAG_OF[kind].slice(2)} removes the cap (unlimited)`,
        )
      }
      set[kind] = n
      continue
    }
    if (a === "--unset") {
      const k = KIND_OF_NAME.get(argv[++i] ?? "")
      if (!k) return usage()
      unset.push(k)
      continue
    }
    if (a.startsWith("--")) return usage()
    positional.push(a)
  }
  const ref = positional[0]
  if (!ref || positional.length > 1) return usage()
  const both = unset.find((k) => set[k] !== undefined)
  if (both) return usage(`${FLAG_OF[both]} and --unset ${FLAG_OF[both].slice(2)} contradict`)

  const orgId = await resolveCapsOrgId(ref)
  if (!orgId) return { exitCode: 2, report: null, message: `org '${ref}' not found` }

  const changed = Object.keys(set).length > 0 || unset.length > 0
  const caps = changed ? await setOrgCaps(orgId, { set, unset }) : await readOrgCaps(orgId)
  const usageNow = await getOrgUsage(orgId)
  return {
    exitCode: 0,
    report: { orgId, changed, caps, usage: usageNow },
  }
}
