// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `search reindex` — on-demand full reindex of the unified search index.
 *
 * The primary, authoritative prod-backfill instruction for the unified-search
 * feature (§3.6/§11 of the unified-search spec): a deploy's boot-time drift
 * detection is the automatic safety net (it fires when settings change, e.g.
 * the new `sensitivity` filterable attribute or the raised `maxTotalHits`
 * ceiling), but this CLI is the PLAN — idempotent, runnable on demand,
 * independent of drift actually firing.
 *
 * Unlike the other `tickets`/`projects`/`invoicing` CLI subcommands (which
 * resolve ONE org), this reindexes EVERY org in one run. The rebuild builds a
 * shadow index with the expected settings and swaps it in atomically
 * (reindex.ts), so search keeps serving the old index until the new one is
 * complete; nothing is applied to the live index in place.
 *
 * Registrations gap (confirmed, not assumed): `collectSearchableRegistrations`
 * reads the in-memory `entityRegistry`, which is populated ONLY by
 * `registerApps` (called from `initAppsForOrg`) — a bare CLI invocation with
 * no app boot would see kernel built-ins only and silently skip every
 * manifest-declared entity (tickets included). This script boots app
 * registrations for every org before applying settings / reindexing, the
 * same registration path the server takes at startup (`ensureAppsForOrg`),
 * without booting the HTTP server, WS, outbox worker, or job queues.
 *
 *   docker exec <app container> bun run --cwd apps/api src/cli/search/reindex.ts
 *   (or, once wired into the `liaison` CLI dispatcher: `liaison search reindex`)
 */
// App registrations here record job handlers but create no BullMQ worker:
// only a declared job host does (infra/jobs/jobs.ts, hostJobWorkers).
import { sql as drizzleSql } from "drizzle-orm"
import { registerMailSearchEnrichment } from "~/apps/mail/search-enrichment"
import { kernelRel } from "~/apps/tickets/schema-refs"
import { registerTicketsSearchEnrichment } from "~/apps/tickets/search-enrichment"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { rootLogger } from "~/lib/logger"
import { getDefaultApps, initAppsForOrg } from "~/modules/apps/init"
import { runReindex } from "~/modules/search/reindex"

const log = rootLogger.child({ module: "cli-search-reindex" })

export interface SearchReindexResult {
  exitCode: number
  report: Awaited<ReturnType<typeof runReindex>> | { error: string }
}

async function listAllOrgIds(): Promise<string[]> {
  return withSystemDb("cli-search-reindex:list-orgs", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`SELECT id FROM ${kernelRel("organizations")}`),
    )
    return rows.map((r) => r.id)
  })
}

export async function runSearchReindexCli(): Promise<SearchReindexResult> {
  try {
    // Register the tickets enrichment hook before anything reads the
    // registry — same ordering requirement as boot-phase10.ts.
    registerTicketsSearchEnrichment()
    registerMailSearchEnrichment()

    const orgIds = await listAllOrgIds()
    const apps = await getDefaultApps()
    for (const orgId of orgIds) {
      await initAppsForOrg(orgId, apps)
    }
    log.info({ orgs: orgIds.length }, "search reindex: app registrations loaded")

    // Settings are not applied to the live index here: the rebuild creates its
    // shadow index with them and swaps it in, so search serves throughout.
    const result = await runReindex()
    if (!result.swapped) throw new Error("another search index rebuild is running")
    log.info(result, "search reindex: completed")
    return { exitCode: 0, report: result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err }, "search reindex: failed")
    return { exitCode: 1, report: { error: message } }
  }
}

// Allow direct invocation: `bun run src/cli/search/reindex.ts` (the ops
// runbook path, e.g. `docker exec <app> bun run --cwd apps/api
// src/cli/search/reindex.ts`), as well as import from cli/main.ts's
// dispatcher.
if (import.meta.main) {
  runSearchReindexCli()
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res.report)}\n`)
      process.exit(res.exitCode)
    })
    .catch((e) => {
      process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`)
      process.exit(1)
    })
}
