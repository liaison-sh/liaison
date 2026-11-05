// SPDX-License-Identifier: FSL-1.1-ALv2
import { quoteIdent } from "~/lib/sql-utils"
import type { DimensionDefinition } from "~/modules/permissions/dimensions"

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

function snake(s: string): string {
  return s.replace(/([A-Z])/g, "_$1").toLowerCase()
}

function generateScopeCheck(
  escapedApp: string,
  escapedEntity: string,
  includeRead: boolean,
  /**
   * An OPTIONAL extra FULL scope grant (already in `app:entity:action` form, e.g.
   * `social:internal`) that ALSO satisfies this check. Used for an app whose UNGATED
   * INTERNAL-mutation tools (e.g. social set_triage / dismiss_finding, scope
   * `social:internal`) write to a table whose RLS scope-entity (`rlsScope`) is a
   * DIFFERENT, gated family (`social:findings:*`). Without this, a context holding only
   * the internal scope (a triage-only routine ceiling, NO `social:findings:write`)
   * passes the TOOL scope check but its UPDATE is silently RLS-denied (0 rows, no error)
   * — the handler then reports success on a write that never landed. The literal is the
   * full scope id (NOT `app:entity` form), so it is matched exactly, never widened.
   */
  extraWriteScope?: string,
): string {
  const readLine = includeRead ? `\n          OR g = '${escapedApp}:${escapedEntity}:read'` : ""
  const extraLine =
    extraWriteScope && extraWriteScope.length > 0
      ? `\n          OR g = '${escapeSqlLiteral(extraWriteScope)}'`
      : ""
  return `(
      rls_ctx.scopes() = '*'
      OR EXISTS (
        SELECT 1 FROM unnest(string_to_array(
          rls_ctx.scopes(), ','
        )) AS g
        WHERE g = '*'
          OR g = '${escapedApp}:${escapedEntity}'
          OR g = '${escapedApp}:${escapedEntity}:write'${readLine}${extraLine}
          OR g = '${escapedApp}:*'
          OR g = '${escapedApp}'
          OR starts_with('${escapedApp}:${escapedEntity}', g || ':')
      )
    )`
}

function generateDimensionCondition(
  key: string,
  def: DimensionDefinition,
  columnRef?: string,
  grantKey = key,
): string {
  const resolvedCol = columnRef ?? quoteIdent(key)
  const escapedKey = grantKey.replace(/'/g, "''")
  const dimJson = `rls_ctx.dimensions()::jsonb`
  const globalWildcard = `(${dimJson} ? '*' AND ${dimJson}->'*' @> '"*"'::jsonb)`
  const keyWildcard = `(${dimJson} ? '${escapedKey}' AND ${dimJson}->'${escapedKey}' @> '"*"'::jsonb)`
  const wildcard = `(${globalWildcard} OR ${keyWildcard})`

  const needsUuidCast = columnRef !== undefined && !columnRef.includes(".")

  switch (def.type) {
    case "membership":
    case "enum":
    case "value":
      // A row whose dimension column is NULL/unset is UNCLASSIFIED — it belongs to no
      // team/segment, so it must be visible+writable to ANYONE holding a grant on this
      // dimension, NOT hidden from everyone but the `*` wildcard. Without the `IS NULL`
      // branch, `NULL = ANY(grants)` → NULL (not TRUE), so a row created with no team is
      // silently inaccessible to a SCOPED grant holder — the exact footgun the `level`
      // case documents and COALESCEs around (BL-91: tickets:create with no team threw a
      // 42501 RLS WITH CHECK violation for a support agent holding a scoped tickets:team
      // grant, so the ticket couldn't be created at all). An explicitly-classified row is
      // UNCHANGED (a 'support-eu' row still requires the 'support-eu' grant), so this only
      // un-hides unclassified NULLs — it never broadens access to a classified row.
      return `(
      ${wildcard}
      OR ${resolvedCol} IS NULL
      OR ${resolvedCol} = ANY(
        ARRAY(SELECT jsonb_array_elements_text(
          ${dimJson}->'${escapedKey}'
        )${needsUuidCast ? "::uuid" : ""})
      )
    )`

    case "level": {
      if (!def.order) return "false"
      const cases = def.order.map((v, i) => `WHEN '${v.replace(/'/g, "''")}' THEN ${i}`).join(" ")
      // A row whose level column is NULL/unset (or holds a value not in `order`) is UNCLASSIFIED —
      // semantically the LEAST sensitive, so it must be visible to anyone holding any grant at the
      // lowest band or above, NOT hidden from everyone but the `*` wildcard. Without the COALESCE,
      // `CASE NULL … END` → NULL and `NULL <= x` is false, so a row created without an explicit level
      // is silently admin-only — the footgun that made every connected mail account (onAccountConnected
      // inserts no sensitivity) invisible to non-admin support agents, blocking the shared-inbox reply
      // path. COALESCE to 0 (the first/lowest band in `order`) treats unclassified as least-sensitive.
      // Explicitly-classified rows are UNCHANGED (a 'restricted' row stays hidden from a 'confidential'
      // grant), so this only un-hides accidental NULLs — it never broadens access to classified rows.
      //
      // The GRANT side needs the same COALESCE: a viewer with NO grants under this key
      // (dimensions `{}` — every plain member role that never received an explicit
      // sensitivity grant) makes the MAX() subselect return NULL, and `0 <= NULL` is not
      // TRUE — so scope-holding members lost EVERY row, including lowest-band ones they
      // were assigned to. Missing grants default the viewer's clearance to the lowest
      // band (0): baseline rows are visible to anyone holding the scope, and every band
      // above the lowest still requires an explicit dimension grant.
      return `(
      ${wildcard}
      OR COALESCE(CASE ${resolvedCol} ${cases} END, 0) <= COALESCE((
        SELECT MAX(CASE v ${cases} END)
        FROM jsonb_array_elements_text(
          ${dimJson}->'${escapedKey}'
        ) AS v
      ), 0)
    )`
    }

    default:
      return wildcard
  }
}

function buildInheritFromExists(
  schemaName: string,
  tableName: string,
  key: string,
  def: DimensionDefinition,
  grantKey: string,
): string {
  if (!def.inheritFrom) return "true"
  const parentSchema = quoteIdent(schemaName)
  const parentTable = quoteIdent(def.inheritFrom.table)
  const localCol = quoteIdent(snake(def.inheritFrom.localColumn))
  const remoteCol = quoteIdent(snake(def.inheritFrom.remoteColumn))
  const parentQualifiedCol = `parent.${quoteIdent(snake(key))}`
  const parentDimCheck = generateDimensionCondition(
    key,
    { ...def, inheritFrom: undefined } as DimensionDefinition,
    parentQualifiedCol,
    grantKey,
  )
  return `EXISTS (
        SELECT 1 FROM ${parentSchema}.${parentTable} parent
        WHERE parent.${remoteCol} = ${quoteIdent(tableName)}.${localCol}
          AND parent.org_id = ${quoteIdent(tableName)}.org_id
          AND ${parentDimCheck}
      )`
}

/**
 * Resolve the LOGICAL scope-entity a table's RLS gates on. By default this is
 * the physical table name, but a manifest table may declare `rlsScope` to alias
 * a physical table onto a coarser grantable scope (e.g. `document_lines` →
 * `documents`, `issuer_profiles` → `settings`). This decouples the physical
 * table vocabulary from the app's declared grantable scope vocabulary.
 */
export function rlsScopeEntityForTable(
  tableName: string,
  table: { rlsScope?: unknown } | undefined,
): string {
  const s = table?.rlsScope
  return typeof s === "string" && s.length > 0 ? s : tableName
}

/**
 * Whether a single grant string would satisfy `generateScopeCheck` for app
 * `appName` + scope-entity `scopeEntity`. Mirrors the accepted-grant set the
 * generated SQL encodes: `*`, the app itself, `app:*`, `app:entity`, and the
 * `:read`/`:write` suffixed forms. (The `starts_with(app:entity, g||':')`
 * branch reduces to `g === app` for a colon-free entity, already covered.)
 */
export function scopeEntityReachableByGrant(
  appName: string,
  scopeEntity: string,
  grant: string,
): boolean {
  return (
    grant === "*" ||
    grant === appName ||
    grant === `${appName}:*` ||
    grant === `${appName}:${scopeEntity}` ||
    grant === `${appName}:${scopeEntity}:read` ||
    grant === `${appName}:${scopeEntity}:write`
  )
}

/**
 * The scopes an app lets an org grant: its top-level `scopes` (the install
 * ceiling of a `.liaisonapp` manifest), plus every scope its roles and tools
 * declare, the same sources the live scope catalog is built from. Bundled apps
 * declare no top-level `scopes`; reading only that array made the reachability
 * guard below report every governed table of every bundled app as unreachable.
 */
export function declaredGrantableScopes(desc: {
  scopes?: unknown
  roles?: unknown
  tools?: unknown
}): string[] {
  const out = new Set<string>()
  const add = (list: unknown) => {
    if (!Array.isArray(list)) return
    for (const s of list) if (typeof s === "string" && s.length > 0) out.add(s)
  }
  add(desc.scopes)
  if (desc.roles && typeof desc.roles === "object") {
    for (const role of Object.values(desc.roles as Record<string, { scopes?: unknown }>)) {
      add(role?.scopes)
    }
  }
  if (desc.tools && typeof desc.tools === "object") {
    for (const tool of Object.values(desc.tools as Record<string, { requiredScopes?: unknown }>)) {
      add(tool?.requiredScopes)
    }
  }
  return [...out]
}

type GovernedTable = { rlsScope?: unknown; rlsGovernedByMigration?: unknown }

/**
 * The governed tables whose real access is defined by policies the SQL
 * migrations own, not by the generated `<table>_rls_<op>` policies:
 * - every table of an app declaring `rlsManagedBy: "migration"` (the runtime
 *   generates no policy for it at all);
 * - a table declaring `rlsGovernedByMigration: true`. The runtime still
 *   generates its policies (they keep serving wildcard grants), but Postgres
 *   ORs them with the migration's PERMISSIVE policies, which grant the access
 *   real roles rely on (a message visible iff its conversation is, a draft or
 *   a read marker to its own user only, ...). Aliasing such a table with
 *   `rlsScope` instead would OR in a coarser scope-only policy and widen it.
 * The scope-reachability guard cannot evaluate those policies, so it leaves
 * these tables out, and registration checks instead that each one carries at
 * least one migration policy that can grant something.
 */
export function migrationGovernedTables(
  schema: Record<string, GovernedTable> | undefined,
  opts?: { rlsManagedBy?: unknown },
): string[] {
  if (!schema) return []
  if (opts?.rlsManagedBy === "migration") return Object.keys(schema)
  return Object.entries(schema)
    .filter(([, table]) => table?.rlsGovernedByMigration === true)
    .map(([name]) => name)
}

/**
 * RLS-scope reachability guard. A governed table whose effective scope-entity
 * (`rlsScope` alias, else the table name) is matched by NONE of the app's
 * declared grantable scopes is UNREACHABLE: no grantable role can ever satisfy
 * its RLS, so least-privilege roles fail (e.g. 500 mid-issuance) on it. This is
 * the invoicing `document_lines`/`issuer_profiles` bug class. Returns the
 * offending physical table names (empty = every table is reachable).
 *
 * Tables whose access the migrations own (`migrationGovernedTables`) are not
 * judged here: the generated policy is not what grants them.
 */
export function tablesUnreachableByGrantableScopes(
  appName: string,
  schema: Record<string, GovernedTable> | undefined,
  grantableScopes: string[] | undefined,
  opts?: { rlsManagedBy?: unknown },
): string[] {
  if (!schema) return []
  const scopes = grantableScopes ?? []
  const migrationGoverned = new Set(migrationGovernedTables(schema, opts))
  const unreachable: string[] = []
  for (const [tableName, table] of Object.entries(schema)) {
    if (migrationGoverned.has(tableName)) continue
    const scopeEntity = rlsScopeEntityForTable(tableName, table)
    if (!scopes.some((g) => scopeEntityReachableByGrant(appName, scopeEntity, g))) {
      unreachable.push(tableName)
    }
  }
  return unreachable
}

export interface RequiredScopesVisibility {
  /** text[] column: every entry must be covered by the viewer's grants. */
  requiredScopesColumn: string
  /** uuid[] (or text[]) column: user ids that see the row regardless of grants. */
  disclosureListColumn: string
}

/**
 * Read-time visibility clause: the viewer's grants cover every entry of the
 * required-scopes column, OR the viewer's user id is on the disclosure list.
 * The SQL mirror of `isMessageVisible` (services/security/visibility.ts), with
 * coverage following `hasScope` (permissions.ts) rule for rule:
 * - an empty or NULL required entry is never covered, and a NULL column never
 *   satisfies the scope branch; an empty column is covered by anyone;
 * - grant `*` covers everything;
 * - a grant with more segments than the required scope never covers it;
 * - a `*` segment is honoured only as the LAST segment of the grant (a
 *   mid-segment wildcard makes the grant cover nothing);
 * - every other grant segment must equal the required segment at the same
 *   position, so `a`, `a:b`, `a:*` and `a:b:*` cover `a:b:read`, while `a:*`
 *   does not cover the bare `a`.
 * Deliberately NOT `app_has_scope`, whose wildcard rules differ. Segments are
 * split with `regexp_split_to_array`, because `string_to_array('', ':')` is an
 * empty array where JavaScript's `''.split(':')` is `['']`. The `__none__`
 * sentinel `withRlsContext` writes for an empty grant list is no grant at all.
 * The disclosure match compares as text, like the JS `includes`, and yields
 * false (not NULL) for a NULL list or an empty user GUC. No semicolons: callers
 * split generated SQL on ';'.
 */
export function generateRequiredScopesVisibilityClause(opts: RequiredScopesVisibility): string {
  const required = quoteIdent(snake(opts.requiredScopesColumn))
  const disclosure = quoteIdent(snake(opts.disclosureListColumn))
  return `(
      (
        ${required} IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM unnest(${required}) AS req(scope)
          WHERE (
            req.scope <> ''
            AND EXISTS (
              SELECT 1
              FROM unnest(string_to_array(
                NULLIF(NULLIF(rls_ctx.scopes(), ''), '__none__'), ','
              )) AS grant_row(scope)
              CROSS JOIN LATERAL (SELECT
                regexp_split_to_array(grant_row.scope, ':') AS gp,
                regexp_split_to_array(req.scope, ':') AS rp
              ) AS parts
              WHERE grant_row.scope = '*'
                OR (
                  cardinality(parts.gp) <= cardinality(parts.rp)
                  AND COALESCE(array_position(parts.gp, '*'), cardinality(parts.gp)) = cardinality(parts.gp)
                  AND NOT EXISTS (
                    SELECT 1 FROM generate_subscripts(parts.gp, 1) AS i
                    WHERE parts.gp[i] <> '*' AND parts.gp[i] IS DISTINCT FROM parts.rp[i]
                  )
                )
            )
          ) IS NOT TRUE
        )
      )
      OR COALESCE(NULLIF(rls_ctx.user_id(), '') = ANY(${disclosure}::text[]), false)
    )`
}

/**
 * ENABLE and FORCE row-level security on one table. The generated policy SQL
 * does this itself; a table whose app manages RLS by migration gets only these
 * two statements from the runtime, so a migration that forgot them (or an app
 * that shipped no migration at all) still ends up deny-by-default and subject
 * to RLS for the table owner too, instead of wide open.
 */
export function forceRlsStatements(schemaName: string, tableName: string): string[] {
  const fullTable = `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`
  return [
    `ALTER TABLE ${fullTable} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${fullTable} FORCE ROW LEVEL SECURITY;`,
  ]
}

/**
 * A policy expression that already holds a sublink reads the request context
 * in sub-selects: `(SELECT rls_ctx.org_id())` is an InitPlan, computed once
 * per statement, where a plain call is evaluated per row wherever it is not an
 * index condition (migration 0186). An expression without a sublink keeps the
 * plain calls: a first sublink would make Postgres check the table's policies
 * for recursion, which fails for a table whose policies read the same table.
 */
export function withSublinkReaders(expression: string): string {
  if (!/\bSELECT\b/i.test(expression)) return expression
  return expression
    .replace(
      /(?<!SELECT )(?<!SELECT \()rls_ctx\.dimensions\(\)::jsonb/g,
      "(SELECT rls_ctx.dimensions()::jsonb)",
    )
    .replace(
      /(?<!SELECT )(?<!SELECT \()rls_ctx\.(org_id|user_id|scopes|dimensions|roles)\(\)/g,
      "(SELECT rls_ctx.$1())",
    )
}

/**
 * `rlsManagedBy: "migration"` tells the runtime NOT to generate policies
 * because Liaison's own migrations define them. A package installed from
 * outside the platform has no such migration, so the claim can only leave its
 * tables without a policy: refused.
 */
export function assertRlsManagementAllowed(desc: {
  name?: string
  rlsManagedBy?: unknown
  _installed?: boolean
  _firstParty?: boolean
}): void {
  if (desc.rlsManagedBy === "migration" && desc._installed === true && desc._firstParty !== true) {
    throw new Error(
      `App '${desc.name ?? "unknown"}' is an installed package and cannot declare rlsManagedBy "migration": its row-level security is generated by the platform`,
    )
  }
}

export function generateRlsPolicySql(
  schemaName: string,
  tableName: string,
  dimensions: Record<string, DimensionDefinition>,
  appName?: string,
  entityName?: string,
  entityFields?: Record<string, any>,
  /**
   * OPTIONAL extra full scope grant (e.g. `social:internal`) that ALSO satisfies the
   * WRITE policies (UPDATE / INSERT / DELETE) on this table — for a table whose UNGATED
   * internal-mutation tools are scoped on a DIFFERENT family than its RLS scope-entity.
   * The READ policy is unaffected. A table declaring `internalWriteScope` in its manifest
   * threads it here so an internal-scope-only context (a triage-only routine ceiling) can
   * actually write, instead of its UPDATE being silently RLS-denied (the social
   * set_triage/dismiss_finding 0-row-no-error class). Undefined for every table that does
   * not declare it (no behaviour change).
   */
  internalWriteScope?: string,
  /**
   * OPTIONAL personal-visibility restriction (manifest `personalScope`). When set,
   * every policy gains an EXTRA AND-condition: rows whose owning account row has
   * effective visibility 'personal' (explicit `visibility` column when present,
   * else owner_type='user') are visible/writable ONLY when `app.current_user_id`
   * equals the account's owner_id. Broad scopes ('*', '<app>:*') and dimension
   * wildcards no longer pierce personal rows — only the owner's RLS context (or
   * the BYPASSRLS privileged pool, e.g. sync ingestion) reaches them. Self form
   * ({}): the table itself is the account. Via form: one hop through
   * `via.localColumn` to `via.table`. The account lookup goes through a
   * SECURITY DEFINER helper (owner = the BYPASSRLS registration role) so the
   * check is NOT filtered by the account table's own RLS — an inline subquery
   * would return no rows for a hidden account and fail OPEN.
   */
  personalScope?: { via?: { table: string; localColumn: string } },
  /**
   * OPTIONAL read-time visibility (see `generateRequiredScopesVisibilityClause`).
   * When set, the SELECT policy gains an extra AND-condition: the viewer holds
   * every scope in `requiredScopesColumn` OR is on `disclosureListColumn`. Write
   * policies are unchanged. Inline, no helper function: no cross-table lookup.
   */
  requiredScopesVisibility?: RequiredScopesVisibility,
): string {
  const quotedSchema = quoteIdent(schemaName)
  const quotedTable = quoteIdent(tableName)
  const fullTable = `${quotedSchema}.${quotedTable}`
  const statements: string[] = []

  statements.push(`ALTER TABLE ${fullTable} ENABLE ROW LEVEL SECURITY;`)
  statements.push(`ALTER TABLE ${fullTable} FORCE ROW LEVEL SECURITY;`)

  // NULLIF-guard the org GUC before the ::uuid cast. `current_setting(..., true)`
  // returns '' (not NULL) when the GUC was never SET — e.g. a background job
  // that reaches its handler with no RLS context (missing/empty `orgId` on the
  // job payload). `''::uuid` is a HARD ERROR ("invalid input syntax for type
  // uuid"), not a 0-row filter, so an unguarded cast turns a missing-context
  // bug into a crashing policy instead of a harmless access denial. NULLIF
  // turns the empty string into NULL first, so `org_id = NULL` evaluates to
  // NULL (not an error) and the policy correctly yields zero rows.
  // The org comes from `rls_ctx.org_id()` (migration 0184), never straight from
  // the variable: on the request login it is the value withRlsContext verified,
  // so SQL that sets the variable itself reads no other org. withSublinkReaders
  // below turns the reader calls of a policy that holds a sublink into
  // sub-selects (InitPlans, once per statement; migration 0186).
  const orgCondition = `org_id = NULLIF(rls_ctx.org_id(), '')::uuid`
  const fields = entityFields ?? {}
  const hasEntityFields = entityFields !== undefined

  function isSelfRef(key: string, def: DimensionDefinition): boolean {
    if (def.column) return false
    if (!hasEntityFields) return false
    const snakeKey = snake(key)
    return !Object.keys(fields).some((f) => snake(f) === snakeKey)
  }

  const fieldKeys = Object.keys(fields).map(snake)
  const hasOwnership =
    hasEntityFields && fieldKeys.includes("owner_type") && fieldKeys.includes("owner_id")

  const dimEntries = Object.entries(dimensions)
  const dimConditions = dimEntries
    .filter(([key, def]) => {
      if (!hasEntityFields) return true
      if (def.column) return true
      if (def.type === "membership" && isSelfRef(key, def)) return true
      const snakeKey = snake(key)
      if (fieldKeys.includes(snakeKey)) return true
      if (def.inheritFrom) {
        const localSnake = snake(def.inheritFrom.localColumn)
        if (fieldKeys.includes(localSnake)) return true
      }
      return false
    })
    .map(([key, def]) => {
      const grantKey = appName ? `${appName}:${key}` : key
      const snakeKey = snake(key)
      const hasDirectColumn = fieldKeys.includes(snakeKey) || def.column
      if (hasDirectColumn) {
        const col = def.column ? snake(def.column) : undefined
        return generateDimensionCondition(key, def, col, grantKey)
      }
      if (def.inheritFrom) {
        return buildInheritFromExists(schemaName, tableName, key, def, grantKey)
      }
      const selfRef = def.type === "membership" && isSelfRef(key, def)
      return generateDimensionCondition(key, def, selfRef ? "id" : undefined, grantKey)
    })

  // ── personalScope: emit the SECURITY DEFINER owner-lookup helper + the
  // AND-condition every policy appends. The helper reads the account row via
  // to_jsonb so a table without an explicit `visibility` column still works
  // (effective visibility then derives purely from owner_type). NULLIF guards
  // the user GUC before the ::uuid cast (empty GUC would otherwise be a hard
  // cast error, not a 0-row filter). NOTE: the function body must not contain
  // a semicolon — callers split this SQL on ';'.
  let personalCondition: string | null = null
  if (personalScope) {
    const accountTable = personalScope.via?.table ?? tableName
    const accountCol = personalScope.via ? snake(personalScope.via.localColumn) : "id"
    const fnName = `${quotedSchema}.${quoteIdent(`${accountTable}_personal_owner`)}`
    statements.push(`CREATE OR REPLACE FUNCTION ${fnName}(acct uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT CASE
      WHEN COALESCE(to_jsonb(a)->>'visibility',
                    CASE WHEN to_jsonb(a)->>'owner_type' = 'user' THEN 'personal' ELSE 'shared' END) = 'personal'
           AND to_jsonb(a)->>'owner_type' = 'user'
      THEN (to_jsonb(a)->>'owner_id')::uuid
    END
    FROM ${quotedSchema}.${quoteIdent(accountTable)} a WHERE a.id = acct
  $$;`)
    // The empty-user branch exempts SYSTEM contexts (cron sync jobs, event
    // handlers run with actorType "system": empty `app.current_user_id`,
    // wildcard dimensions) — sync ingestion into a personal mailbox must keep
    // working. Every human/agent surface carries a user id, so the personal
    // restriction fully applies to them.
    // System contexts run with the NIL uuid as user GUC (rls.ts safeUserId
    // fallback), and no-context background paths leave it empty — both are
    // exempted below. The user comes from `rls_ctx.user_id()` (migration 0185):
    // on the request login it is the variable only when its tag matches, and
    // the max uuid otherwise, so SQL that clears or forges the variable is
    // nobody, never this system exemption.
    // A via column declared as text (calendar's `calaccess`, which carries the
    // owning account id as a string) is cast to uuid for the helper. The cast is
    // regex-guarded so one malformed value yields NULL (no account) instead of a
    // hard cast error that would break every read of the table.
    const localDef = Object.entries(fields).find(([f]) => snake(f) === accountCol)?.[1]
    const localType = typeof localDef === "string" ? localDef.replace(/\?$/, "") : localDef?.type
    const quotedCol = quoteIdent(accountCol)
    const accountArg =
      personalScope.via && localType !== undefined && localType !== "uuid"
        ? `(CASE WHEN ${quotedCol} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ${quotedCol}::uuid END)`
        : quotedCol
    personalCondition = `(
      COALESCE(NULLIF(rls_ctx.user_id(), ''), '00000000-0000-0000-0000-000000000000') = '00000000-0000-0000-0000-000000000000'
      OR ${fnName}(${accountArg}) IS NULL
      OR ${fnName}(${accountArg}) = NULLIF(rls_ctx.user_id(), '')::uuid
    )`
  }

  let ownershipOrBlock: string | null = null
  if (hasOwnership && dimEntries.length > 0) {
    const ownerCheck = `(owner_type = 'user' AND owner_id = nullif(rls_ctx.user_id(), '')::uuid)`
    const dimPart = dimConditions.join("\n    AND ")
    ownershipOrBlock = `(${ownerCheck}\n      OR (${dimPart}))`
  }

  function buildReadWhere(): string {
    const parts: string[] = [orgCondition]
    if (appName && entityName) {
      parts.push(generateScopeCheck(escapeSqlLiteral(appName), escapeSqlLiteral(entityName), true))
    }
    if (ownershipOrBlock) {
      parts.push(ownershipOrBlock)
    } else {
      parts.push(...dimConditions)
    }
    if (personalCondition) parts.push(personalCondition)
    if (requiredScopesVisibility) {
      parts.push(generateRequiredScopesVisibilityClause(requiredScopesVisibility))
    }
    return withSublinkReaders(parts.join("\n    AND "))
  }

  function buildWriteWhere(): string {
    const parts: string[] = [orgCondition]
    if (appName && entityName) {
      parts.push(
        generateScopeCheck(
          escapeSqlLiteral(appName),
          escapeSqlLiteral(entityName),
          false,
          internalWriteScope,
        ),
      )
    }
    if (ownershipOrBlock) {
      parts.push(ownershipOrBlock)
    } else {
      parts.push(...dimConditions)
    }
    if (personalCondition) parts.push(personalCondition)
    return withSublinkReaders(parts.join("\n    AND "))
  }

  function buildInsertWhere(): string {
    const parts: string[] = [orgCondition]
    if (appName && entityName) {
      parts.push(
        generateScopeCheck(
          escapeSqlLiteral(appName),
          escapeSqlLiteral(entityName),
          false,
          internalWriteScope,
        ),
      )
    }
    // Inherited dimensions must be enforced at INSERT — the parent's visibility must hold.
    const inheritedConditions = dimEntries
      .filter(([_, def]) => def.inheritFrom)
      .map(([key, def]) => {
        const grantKey = appName ? `${appName}:${key}` : key
        return buildInheritFromExists(schemaName, tableName, key, def, grantKey)
      })
    parts.push(...inheritedConditions)
    if (personalCondition) parts.push(personalCondition)
    return withSublinkReaders(parts.join("\n    AND "))
  }

  const policyPrefix = `${tableName}_rls`

  // Scope every generated app policy to the non-superuser RLS role, matching
  // the kernel policies in 0000_initial.sql. Without an explicit `TO`, Postgres
  // defaults the policy to PUBLIC (all roles) — which violates the I-DEP-3 RLS
  // invariant (governed tables must gate liaison_rls specifically) that
  // rls-completeness.test.ts enforces.
  statements.push(`CREATE POLICY ${quoteIdent(`${policyPrefix}_select`)} ON ${fullTable}
  FOR SELECT
  TO liaison_rls
  USING (
    ${buildReadWhere()}
  );`)

  statements.push(`CREATE POLICY ${quoteIdent(`${policyPrefix}_insert`)} ON ${fullTable}
  FOR INSERT
  TO liaison_rls
  WITH CHECK (
    ${buildInsertWhere()}
  );`)

  statements.push(`CREATE POLICY ${quoteIdent(`${policyPrefix}_update`)} ON ${fullTable}
  FOR UPDATE
  TO liaison_rls
  USING (
    ${buildWriteWhere()}
  )
  WITH CHECK (
    ${buildWriteWhere()}
  );`)

  statements.push(`CREATE POLICY ${quoteIdent(`${policyPrefix}_delete`)} ON ${fullTable}
  FOR DELETE
  TO liaison_rls
  USING (
    ${buildWriteWhere()}
  );`)

  return statements.join("\n\n")
}
