// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The second line of a mention picker row. Four tasks all called "Email-bounce
// dashboard for support" are four identical rows: the title alone does not say
// which one the writer means, so every row carries a fact that tells them
// apart. A task carries its project, which is the fact that differs.
//
// The fact can sit on ANOTHER row, one join away, which `labelSecondary` (a
// column of the entity's own table) cannot name. An entity declares that join
// as `indexFields.labelSecondaryFrom` and this resolves it for whichever app
// declared it: the kernel names no app here.
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { collectSearchableRegistrations } from "~/modules/search/searchable-entities"
import type { MentionHit } from "~/modules/search/service"

/**
 * Fills the secondary label of the hits that have none of their own. The hits
 * are already permission filtered by the caller; this reads only the label
 * fact for those exact ids, privileged because the picker's rows are not the
 * caller's own rows to join from.
 */
export async function attachMentionSecondaryLabels(
  orgId: string,
  hits: MentionHit[],
  /**
   * Read the label fact with this transaction's visibility instead (a
   * notification naming the entity to one reader: only a fact that reader may
   * see is named).
   */
  reader?: Pick<PrivilegedDb, "execute">,
): Promise<void> {
  const unlabeled = hits.filter((h) => !h.secondaryLabel)
  if (unlabeled.length === 0) return

  const declared = new Map<
    string,
    { schemaName: string; tableName: string; from: NonNullable<RelatedLabel> }
  >()
  for (const reg of collectSearchableRegistrations(orgId).entities) {
    const from = reg.indexFields?.labelSecondaryFrom
    if (!from || !reg.schemaName || !reg.tableName) continue
    declared.set(`${reg.app}\u0000${reg.entityType}`, {
      schemaName: reg.schemaName,
      tableName: reg.tableName,
      from,
    })
  }
  if (declared.size === 0) return

  const idsByEntity = new Map<string, string[]>()
  for (const hit of unlabeled) {
    const key = `${hit.app}\u0000${hit.entityType}`
    if (!declared.has(key)) continue
    idsByEntity.set(key, [...(idsByEntity.get(key) ?? []), hit.id])
  }

  const labels = new Map<string, string>()
  for (const [key, ids] of idsByEntity) {
    const { schemaName, tableName, from } = declared.get(key)!
    const schema = drizzleSql.raw(schemaRef(schemaName))
    const idList = drizzleSql.join(
      ids.map((id) => drizzleSql`${id}::uuid`),
      drizzleSql`, `,
    )
    const columns = drizzleSql.join(
      from.columns.map(
        (c, i) => drizzleSql`r.${drizzleSql.identifier(c)} AS ${drizzleSql.raw(`c${i}`)}`,
      ),
      drizzleSql`, `,
    )
    const read = (tx: Pick<PrivilegedDb, "execute">) =>
      tx.execute(drizzleSql`
        SELECT t.id, ${columns}
        FROM ${schema}.${drizzleSql.identifier(tableName)} t
        JOIN ${schema}.${drizzleSql.identifier(from.tableName)} r
          ON r.id = t.${drizzleSql.identifier(from.foreignKey)} AND r.org_id = t.org_id
        WHERE t.org_id = ${orgId}::uuid AND t.id IN (${idList})
      `)
    const rows = reader
      ? await read(reader)
      : await withPrivilegedDb(orgId, "mention-secondary-labels", read)
    for (const row of extractRows<Record<string, unknown>>(rows)) {
      const label = from.columns
        .map((_, i) => row[`c${i}`])
        .find((v) => typeof v === "string" && v.length > 0) as string | undefined
      if (label) labels.set(`${key}\u0000${row.id}`, label)
    }
  }

  for (const hit of unlabeled) {
    const label = labels.get(`${hit.app}\u0000${hit.entityType}\u0000${hit.id}`)
    if (label) hit.secondaryLabel = label
  }
}

type RelatedLabel = NonNullable<
  ReturnType<typeof collectSearchableRegistrations>["entities"][number]["indexFields"]
>["labelSecondaryFrom"]
