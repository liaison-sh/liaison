// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The additive data rule (S10, A21): a new version of an app may add tables,
 * columns and enum values, and nothing else. The server keeps the previous
 * version to switch back to (activation.ts), and that version must still run on
 * the data the new one wrote, so a version is refused when its declared schema
 * would lose or reshape what the active version stores:
 *
 *  - a table or a column the active version declares is gone (dropped or renamed);
 *  - a column's type changed;
 *  - an enum lost a value, or a free column became an enum;
 *  - a nullable column became required (NOT NULL on existing rows);
 *  - a unique constraint is dropped or changed (a partial one's predicate too),
 *    or now covers columns that already hold data, or a new column every
 *    existing row fills with the same default.
 *
 * Both schemas are the `schema` objects of the manifests as written
 * (`app.manifest.json`): `{ <table>: { fields: { <column>: "type" | "type?" |
 * { type, required?, enum?, precision?, scale? } }, constraints?: { unique? } } }`.
 */

interface FieldShape {
  type: string
  nullable: boolean
  enum: string[] | null
}

type SchemaDecl = Record<string, unknown>

function fieldShape(def: unknown): FieldShape | null {
  if (typeof def === "string") {
    return { type: def.replace("?", ""), nullable: def.endsWith("?"), enum: null }
  }
  if (!def || typeof def !== "object") return null
  const d = def as {
    type?: unknown
    required?: unknown
    enum?: unknown
    precision?: unknown
    scale?: unknown
  }
  if (typeof d.type !== "string") return null
  const type =
    d.type === "numeric" && typeof d.precision === "number"
      ? `numeric(${d.precision},${typeof d.scale === "number" ? d.scale : 0})`
      : d.type
  return {
    type,
    nullable: d.required === false,
    enum: Array.isArray(d.enum) ? d.enum.map(String) : null,
  }
}

function fieldsOf(table: unknown): Record<string, unknown> {
  if (!table || typeof table !== "object") return {}
  const fields = (table as { fields?: unknown }).fields
  return fields && typeof fields === "object" ? (fields as Record<string, unknown>) : {}
}

interface UniqueKey {
  /** Sorted, comma-joined columns, plus ` where <predicate>` for a partial unique. */
  key: string
  columns: string[]
}

/** Each unique constraint of a table, full and partial. */
function uniquesOf(table: unknown): UniqueKey[] {
  if (!table || typeof table !== "object") return []
  const unique = (table as { constraints?: { unique?: unknown } }).constraints?.unique
  if (!Array.isArray(unique)) return []
  const out: UniqueKey[] = []
  for (const u of unique) {
    const cols = Array.isArray(u)
      ? u
      : u && typeof u === "object"
        ? (u as { columns?: unknown }).columns
        : undefined
    if (!Array.isArray(cols)) continue
    const columns = cols.map(String).sort()
    const where =
      !Array.isArray(u) && u && typeof u === "object" ? (u as { where?: unknown }).where : undefined
    out.push({
      key: `${columns.join(",")}${typeof where === "string" ? ` where ${where}` : ""}`,
      columns,
    })
  }
  return out
}

function hasNonNullDefault(def: unknown): boolean {
  if (!def || typeof def !== "object") return false
  const d = (def as { default?: unknown }).default
  return d !== undefined && d !== null
}

/**
 * What the new schema would lose against the active one, one line each, in
 * declaration order. Empty when the change is additive.
 */
export function nonAdditiveChanges(active: unknown, next: unknown): string[] {
  const before = (active && typeof active === "object" ? active : {}) as SchemaDecl
  const after = (next && typeof next === "object" ? next : {}) as SchemaDecl
  const out: string[] = []
  for (const [table, beforeTable] of Object.entries(before)) {
    if (!(table in after)) {
      out.push(`table ${table} is dropped`)
      continue
    }
    const beforeFields = fieldsOf(beforeTable)
    const afterFields = fieldsOf(after[table])
    for (const [column, beforeDef] of Object.entries(beforeFields)) {
      const was = fieldShape(beforeDef)
      if (!(column in afterFields)) {
        out.push(`column ${table}.${column} is dropped`)
        continue
      }
      const now = fieldShape(afterFields[column])
      if (!was || !now) continue
      if (was.type !== now.type) {
        out.push(`column ${table}.${column} changes type from ${was.type} to ${now.type}`)
      }
      if (now.enum) {
        const lost = was.enum ? was.enum.filter((v) => !now.enum?.includes(v)) : null
        if (lost === null) {
          out.push(`column ${table}.${column} becomes an enum; its existing values may not fit`)
        } else if (lost.length > 0) {
          out.push(`column ${table}.${column} loses enum values ${lost.join(", ")}`)
        }
      }
      if (was.nullable && !now.nullable) {
        out.push(`column ${table}.${column} becomes required (NOT NULL)`)
      }
    }
    const existing = new Set(Object.keys(beforeFields))
    const afterUniques = uniquesOf(after[table])
    const afterKeys = new Set(afterUniques.map((u) => u.key))
    const beforeKeys = new Set(uniquesOf(beforeTable).map((u) => u.key))
    for (const u of uniquesOf(beforeTable)) {
      if (!afterKeys.has(u.key))
        out.push(`table ${table} drops a unique constraint (${u.key || "org"})`)
    }
    for (const u of afterUniques) {
      if (beforeKeys.has(u.key)) continue
      if (u.columns.length === 0 || u.columns.some((c) => existing.has(c))) {
        out.push(`table ${table} adds a unique constraint on existing data (${u.key || "org"})`)
      } else if (u.columns.some((c) => hasNonNullDefault(afterFields[c]))) {
        // Every existing row gets the same default: the constraint fails on them.
        out.push(
          `table ${table} adds a unique constraint on a new column with a default (${u.key})`,
        )
      }
    }
  }
  return out
}

/**
 * Refuse a version whose schema is not additive over the active one, naming
 * what would be lost.
 */
export function assertAdditiveSchema(
  app: string,
  activeVersion: string,
  nextVersion: string,
  active: unknown,
  next: unknown,
): void {
  const changes = nonAdditiveChanges(active, next)
  if (changes.length === 0) return
  throw new Error(
    `Cannot move '${app}' from ${activeVersion} to ${nextVersion}: the new version would lose data the running version keeps. ` +
      `A new version may only add tables, columns and enum values. Would be lost: ${changes.join("; ")}.`,
  )
}
