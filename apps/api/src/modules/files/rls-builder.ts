// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Generates the SELECT policy for `kernel.files` from the manifest fileParent
 * registry. Each registered `(app, entityType)` adds an EXISTS branch joining
 * the file's `entity_id` to the parent table's join column, scoped by org. Apps
 * that have not registered are not addressable through the policy, so files with
 * an unknown parent are denied by default. The uploader-only kinds
 * (`UPLOADER_ONLY_FILE_KINDS`) add one branch each, with no parent join.
 */

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function ident(s: string): string {
  if (!IDENT_RE.test(s)) throw new Error(`invalid identifier: ${s}`)
  return `"${s}"`
}

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

export interface FileParentRegistration {
  app: string
  entityType: string
  schemaRef: string
  tableName: string
  joinOn: string
  /**
   * A soft-delete column on the parent. When set, a parent row whose column is
   * not NULL hides its files: a deleted message's attachments are unreadable
   * even before (or if ever without) their rows being removed.
   */
  softDeleteColumn?: string
}

/**
 * A kind of kernel file with no parent row, readable only by the member who
 * uploaded it (`uploaded_by` is the reading user, in the reading org). A
 * data-subject export bundle is one: it is written for the person who asked
 * for it, so neither the subject, nor another member, nor an admin reaches it
 * through a parent.
 */
export interface UploaderOnlyFileKind {
  app: string
  entityType: string
}

/** The uploader-only kinds, in policy order. */
export const UPLOADER_ONLY_FILE_KINDS: readonly UploaderOnlyFileKind[] = [
  { app: "kernel", entityType: "data_subject_export" },
]

// Anchored UUID shape guard for the entity_id → uuid cast in the policy join.
const UUID_SHAPE_RE =
  "'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'"

/**
 * Build the SELECT policy DDL. The kernel schema name must be passed in (not
 * hard-coded) so worker-isolated tests can target their prefixed schema
 * (`w<id>_kernel`) rather than the original `kernel` schema.
 *
 * The parent join casts `files.entity_id` to uuid (CASE-guarded so a non-UUID
 * entity_id yields NULL, never a cast error) instead of casting the parent's
 * `joinOn` column to text. The direction matters: `p.id::text = entity_id`
 * contains the non-leakproof `uuid_out` applied to the RLS-protected parent's
 * column, so Postgres refuses to push it below the parent's own policies and
 * seq-scans the whole parent table, evaluating per-row policy functions (e.g.
 * `can_read_ticket`) on every row — seconds per files SELECT on a live
 * instance. With the cast on the files side the inner qual is a leakproof
 * `uuid = uuid` against the parent's primary key index.
 *
 * `legacyTextJoin` regenerates the old text-cast form for parents whose
 * `joinOn` column is not uuid-typed (the uuid form fails CREATE POLICY with a
 * datatype mismatch there — the boot rebuild falls back on that error).
 */
export function buildFilesSelectPolicy(
  parents: FileParentRegistration[],
  kernelSchema: string = "kernel",
  opts: { legacyTextJoin?: boolean } = {},
): string {
  const k = ident(kernelSchema)
  const head =
    `DROP POLICY IF EXISTS files_select ON ${k}.files;\n` +
    `CREATE POLICY files_select ON ${k}.files FOR SELECT TO liaison_rls`
  if (parents.length === 0) {
    return `${head} USING (false);`
  }
  const branches = parents.map((p) => {
    const join = opts.legacyTextJoin
      ? `p.${ident(p.joinOn)}::text = ${k}.files.entity_id`
      : `p.${ident(p.joinOn)} = (CASE WHEN ${k}.files.entity_id ~ ${UUID_SHAPE_RE} ` +
        `THEN ${k}.files.entity_id::uuid END)`
    return (
      `( EXISTS (SELECT 1 FROM ${ident(p.schemaRef)}.${ident(p.tableName)} p ` +
      `WHERE ${join} ` +
      `AND ${k}.files.app = ${lit(p.app)} ` +
      `AND ${k}.files.entity_type = ${lit(p.entityType)} ` +
      `AND ${k}.files.org_id = p.org_id` +
      (p.softDeleteColumn ? ` AND p.${ident(p.softDeleteColumn)} IS NULL` : "") +
      `) )`
    )
  })
  const uploaderOnly = UPLOADER_ONLY_FILE_KINDS.map(
    (kind) =>
      `( ${k}.files.app = ${lit(kind.app)} ` +
      `AND ${k}.files.entity_type = ${lit(kind.entityType)} ` +
      `AND ${k}.files.org_id = NULLIF(rls_ctx.org_id(), '')::uuid ` +
      `AND ${k}.files.uploaded_by = NULLIF(rls_ctx.user_id(), '')::uuid )`,
  )
  return `${head} USING (${[...branches, ...uploaderOnly].join(" OR ")});`
}
