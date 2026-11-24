// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison knowledge links-backfill [--org <uuid>] [--dry-run]`
//
// Knowledge page links are stored as `[](knowledge:document:<id>)`, the id alone. Texts
// written before held the linked page's title (`@[Title](knowledge:document:<id>)`, as
// agents wrote them). This removes those titles from stored bodies, summaries and page
// history and records each page's links, the same work the daily
// `knowledge:page-links-backfill` job does (apps/knowledge/links.ts). Only link tokens
// change: no revision, no event, no review status. Idempotent. `--dry-run` only counts.

import { backfillPageLinks, type PageLinksBackfillReport } from "~/apps/knowledge/links"

export const KNOWLEDGE_LINKS_BACKFILL_USAGE =
  "usage: liaison knowledge links-backfill [--org <uuid>] [--dry-run]"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ParsedLinksBackfillArgs =
  | { ok: true; orgId: string | null; dryRun: boolean }
  | { ok: false; error: string }

export function parseLinksBackfillArgv(argv: string[]): ParsedLinksBackfillArgs {
  let orgId: string | null = null
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === "--dry-run") {
      dryRun = true
    } else if (flag === "--org") {
      const value = argv[++i]
      if (!value || !UUID.test(value)) {
        return { ok: false, error: `--org requires an org uuid\n${KNOWLEDGE_LINKS_BACKFILL_USAGE}` }
      }
      orgId = value
    } else {
      return { ok: false, error: `unknown argument ${flag}\n${KNOWLEDGE_LINKS_BACKFILL_USAGE}` }
    }
  }
  return { ok: true, orgId, dryRun }
}

export async function runKnowledgeLinksBackfillCli(
  argv: string[],
  deps: {
    backfill?: (opts: { orgId?: string; dryRun?: boolean }) => Promise<PageLinksBackfillReport>
  } = {},
): Promise<number> {
  const parsed = parseLinksBackfillArgv(argv)
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`)
    return 2
  }
  const backfill = deps.backfill ?? backfillPageLinks
  const report = await backfill({
    ...(parsed.orgId ? { orgId: parsed.orgId } : {}),
    dryRun: parsed.dryRun,
  })
  process.stdout.write(`${JSON.stringify(report)}\n`)
  return 0
}
