// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { approvalRequests } from "~/db/schema/kernel/agent-memory"
import { contacts } from "~/db/schema/kernel/contacts"
import { threads } from "~/db/schema/kernel/threads"
import { entityRegistry, type SearchIndexFields, viewRegistry } from "~/modules/apps/app-registries"
import { isMailEntitySuppressed } from "~/modules/mailbox-crypto/content-suppression"

export interface ReferenceDisplayResolved {
  tabType: string
  label: string
  icon: string
  snippet?: string
}

/** What the label readers need of a transaction: an RLS one or a privileged one. */
type LabelReader = Pick<PrivilegedDb, "select" | "execute">

interface ManifestMeta {
  tabType: string
  label: string
  icon: string
}

// Hardcoded fallback for kernel + apps not yet registered when reference resolution
// happens (e.g., before any org has been bootstrapped). Manifest registry wins when
// it has an entry.
const KERNEL_FALLBACK: Record<string, ManifestMeta> = {
  thread: { tabType: "kernel:thread", label: "Thread", icon: "MessageSquare" },
  contact: { tabType: "kernel:contact", label: "Contact", icon: "User" },
  approval_request: {
    tabType: "kernel:approval_request",
    label: "Approval",
    icon: "ShieldCheck",
  },
}

function lookupFromRegistry(orgId: string, app: string, entityType: string): ManifestMeta | null {
  const candidates: string[] = orgId ? [orgId, "*"] : ["*"]
  for (const id of candidates) {
    const views = viewRegistry.get([id, app]) as
      | { tabTypes?: Record<string, { label?: string; icon?: string }> }
      | undefined
    const tab = views?.tabTypes?.[entityType]
    if (tab) {
      return {
        tabType: `${app}:${entityType}`,
        label: tab.label ?? entityType,
        icon: typeof tab.icon === "string" ? tab.icon : "Square",
      }
    }
  }
  return null
}

export function resolveReferenceMetadataFromManifests(
  app: string,
  entityType: string,
  orgId = "",
): ManifestMeta | null {
  const fromRegistry = lookupFromRegistry(orgId, app, entityType)
  if (fromRegistry) return fromRegistry
  if (app === "kernel") return KERNEL_FALLBACK[entityType] ?? null
  return null
}

function shortId(id: string): string {
  return id.length > 8 ? `#${id.slice(0, 8)}` : `#${id}`
}

// SQL-identifier guard. Registry values (tableName/labelField/indexFields) come
// from app manifests, but the manifest schema only types them as `string`. We
// interpolate them as raw identifiers, so reject anything that isn't a plain
// snake/camel identifier before it reaches the query builder.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

interface RegistryEntityShape {
  labelField: string
  handlePrefix: string
  tableName?: string
  indexFields?: SearchIndexFields
}

/**
 * Look up a non-kernel entity's registry declaration, preferring an org-scoped
 * registration and falling back to the wildcard one — same precedence as
 * `lookupFromRegistry` for view metadata.
 */
function lookupEntityDecl(
  orgId: string,
  app: string,
  entityType: string,
): RegistryEntityShape | null {
  const candidates: string[] = orgId ? [orgId, "*"] : ["*"]
  for (const id of candidates) {
    const decl = entityRegistry.get([id, app, entityType])
    if (decl) return decl
  }
  return null
}

/**
 * Resolve an app entity's label (and snippet) generically from its registry
 * declaration, with no per-app SQL. The label comes from the declared
 * `labelField`; an optional `indexFields.handle` column lets us render a
 * `#handle` fallback when the label is null. Tables live in the per-app schema
 * (`app_<appName>`) by convention.
 */
async function loadAppEntityLabelAndSnippet(
  tx: LabelReader,
  decl: RegistryEntityShape,
  params: { orgId: string; app: string; entityType: string; entityId: string },
): Promise<{ label?: string; snippet?: string } | null> {
  const { orgId, app, entityType, entityId } = params
  const tableName = decl.tableName
  const labelField = decl.labelField
  const handleField = decl.indexFields?.handle
  if (!tableName || !SAFE_IDENT.test(tableName) || !SAFE_IDENT.test(labelField)) return null
  if (handleField && !SAFE_IDENT.test(handleField)) return null
  if (!SAFE_IDENT.test(app)) return null

  const schema = `app_${app}`
  const labelCol = drizzleSql.raw(`"${labelField}"`)
  const tableRef = drizzleSql.raw(`"${schema}"."${tableName}"`)
  const selectCols = handleField
    ? drizzleSql`${labelCol} AS label, ${drizzleSql.raw(`"${handleField}"`)} AS handle`
    : drizzleSql`${labelCol} AS label`

  const result = await tx.execute(drizzleSql`
    SELECT ${selectCols} FROM ${tableRef}
    WHERE id = ${entityId} AND org_id = ${orgId}
    LIMIT 1
  `)
  const row = extractRows<{ label?: string | null; handle?: string | null }>(result)[0]
  if (!row) return null

  // Invariant K, third of the three sites that read `labelField`. This snippet is
  // injected verbatim into the agent's referenced-entity context and from there
  // into the model's prompt and the persisted turn, so for an encrypted personal
  // mailbox the label is dropped and only the id survives. The agent still knows
  // WHICH conversation is referenced, and reads its content through the
  // client-fulfilled path.
  const mailSuppressed =
    app === "mail" &&
    (await withPrivilegedDb(orgId, "reference-display-mail-suppression", (ptx) =>
      isMailEntitySuppressed(ptx, orgId, entityType, entityId),
    ))
  if (mailSuppressed) {
    return {
      label: `${entityType} ${shortId(entityId)}`,
      snippet: `[Entity: ${app}:${entityType}, id: ${entityId}] { content encrypted, readable only by the mailbox owner }`,
    }
  }

  const handle = row.handle ?? null
  const label = row.label ?? (handle ? `#${handle}` : shortId(entityId))
  const labelClause = row.label ? `${labelField}: "${row.label}"` : `${labelField}: "(unnamed)"`
  return {
    label,
    snippet: `[Entity: ${app}:${entityType}${handle ? ` #${handle}` : ""}, id: ${entityId}] { ${labelClause} }`,
  }
}

async function loadKnownEntityLabelAndSnippet(
  tx: LabelReader,
  params: { orgId: string; app: string; entityType: string; entityId: string },
): Promise<{ label?: string; snippet?: string } | null> {
  const { orgId, app, entityType, entityId } = params
  try {
    if (app === "kernel" && entityType === "thread") {
      const [row] = await tx
        .select({ handle: threads.handle, title: threads.title })
        .from(threads)
        .where(and(eq(threads.id, entityId), eq(threads.orgId, orgId)))
        .limit(1)
      if (!row) return null
      const label = row.title ?? `#${row.handle}`
      return {
        label,
        snippet: `[Entity: kernel:thread #${row.handle}, id: ${entityId}] { title: "${row.title ?? "(untitled)"}" }`,
      }
    }
    if (app === "kernel" && entityType === "contact") {
      const [row] = await tx
        .select({ name: contacts.name, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.id, entityId), eq(contacts.orgId, orgId)))
        .limit(1)
      if (!row) return null
      const label = row.name ?? row.email ?? "(unnamed)"
      return {
        label,
        snippet: `[Entity: kernel:contact, id: ${entityId}] { name: "${row.name ?? "(unnamed)"}", email: "${row.email ?? ""}" }`,
      }
    }
    if (app === "kernel" && entityType === "approval_request") {
      // An approval is named by its own summary title ("Refund order 1042"),
      // read with `tx`'s visibility like every other kind.
      const [row] = await tx
        .select({ handle: approvalRequests.handle, summary: approvalRequests.summary })
        .from(approvalRequests)
        .where(and(eq(approvalRequests.id, entityId), eq(approvalRequests.orgId, orgId)))
        .limit(1)
      if (!row) return null
      const title = (row.summary as { title?: unknown } | null)?.title
      const label = typeof title === "string" && title.trim().length > 0 ? title : row.handle
      return {
        label,
        snippet: `[Entity: kernel:approval_request ${row.handle}, id: ${entityId}] { title: "${label}" }`,
      }
    }
    // Non-kernel app entities resolve generically through the entity registry —
    // the declared `labelField`/`tableName`/`indexFields.handle` describe where
    // the label lives, so no per-app SQL or app-name branching is needed.
    const decl = lookupEntityDecl(orgId, app, entityType)
    if (decl) {
      return await loadAppEntityLabelAndSnippet(tx, decl, params)
    }
  } catch {
    return null
  }
  return null
}

/**
 * An entity's own name (a task's title), read with `tx`'s visibility: null
 * when the entity is gone, its kind declares no label, or `tx` may not see it.
 */
export async function resolveEntityLabel(
  tx: LabelReader,
  params: { orgId: string; app: string; entityType: string; entityId: string },
): Promise<string | null> {
  const found = await loadKnownEntityLabelAndSnippet(tx, params)
  return found?.label ?? null
}

export async function resolveReferenceDisplay(
  tx: RlsClient,
  params: { orgId: string; app: string; entityType: string; entityId: string },
): Promise<ReferenceDisplayResolved> {
  const meta = resolveReferenceMetadataFromManifests(params.app, params.entityType, params.orgId)
  const tabType = meta?.tabType ?? `${params.app}:${params.entityType}`
  const icon = meta?.icon ?? "Square"
  const enriched = await loadKnownEntityLabelAndSnippet(tx, params)
  const label = enriched?.label ?? `${meta?.label ?? params.entityType} ${shortId(params.entityId)}`
  return { tabType, icon, label, snippet: enriched?.snippet }
}
