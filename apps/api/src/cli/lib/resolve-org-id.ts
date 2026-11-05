// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Shared org-resolution helper for the CLI subcommands.
 *
 * With a slug → look up by slug (error if not found). Without a slug → single-org
 * default: error if zero orgs exist, error if more than one exists (ambiguous).
 * The `multiOrgMessage` parameter lets each caller surface a command-specific
 * disambiguation hint.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel } from "~/apps/tickets/schema-refs"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"

export async function resolveOrgId(
  slug: string | undefined,
  multiOrgMessage: string,
): Promise<{ ok: true; orgId: string } | { ok: false; message: string }> {
  return withSystemDb("cli-resolve-org", async (tx) => {
    if (slug) {
      const rows = extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`SELECT id FROM ${kernelRel("organizations")} WHERE slug = ${slug} LIMIT 1`,
        ),
      )
      if (rows.length === 0) return { ok: false as const, message: `org '${slug}' not found` }
      return { ok: true as const, orgId: rows[0]!.id }
    }
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`SELECT id FROM ${kernelRel("organizations")} LIMIT 2`),
    )
    if (rows.length === 0) return { ok: false as const, message: "no org exists" }
    if (rows.length > 1) return { ok: false as const, message: multiOrgMessage }
    return { ok: true as const, orgId: rows[0]!.id }
  })
}
