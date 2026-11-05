// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Knowledge provisioner (Task 12). Provisions `knowledge.collections`,
 * `knowledge.documents`, and `knowledge.sources`. Runs LAST in the canonical
 * order so a source's referenced app connection is already resolved.
 *
 * Handle: `ctx.rls` as the ensured admin (admin holds `knowledge:*` via the
 * wildcard scope). All KB services take a branded `RlsClient` + a `KnowledgeActor`
 * built from the context via `knowledgeActorFromContext` — no `as`/`as unknown as`.
 *
 *  - collections: idempotent by NAME (correction #13 — `KnowledgeCollectionInput`
 *    has NO slug; the config `slug` is an optional display alias only). Pre-check
 *    via `listKnowledgeCollections` filtered by name; absent → `createKnowledgeCollection`.
 *  - documents: a `{ dir, collection }` entry expands to one document per
 *    matching text file (`knowledge-dir.ts`); then every document, single-file
 *    or from a folder, takes the same path. Explicit (orgId, collection, title)
 *    pre-check: an org doc with that exact title that is a member of the target
 *    collection. Absent → read `contentFile` (resolved RELATIVE to the config dir, with
 *    absolute-escape path traversal rejected) → `createKnowledgeDocument` with
 *    `documentScope:'organization'` + `collectionIds:[collectionId]`. Present → skip.
 *  - sources: a source links a collection to an app connection. Headless
 *    synced-source registration (`createSyncedSource`) is NOT cleanly callable
 *    here — it requires a LIVE, enabled app adapter (`registerDefaultKnowledgeSources`
 *    → `registry.listEnabled(actor)`) AND a real network folder-read precheck
 *    against the external provider. A provisioning run cannot satisfy either
 *    headlessly (most app connections are oauth2 → pending). So sources are scoped
 *    to "report pending + action required" — surfaced in `pending[]`, never
 *    half-created. (sourcesDecision.)
 */
import { readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import {
  createKnowledgeCollection,
  type KnowledgeCollectionRow,
  listKnowledgeCollections,
} from "~/apps/knowledge/collections"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  createKnowledgeDocument,
  type KnowledgeActor,
  knowledgeActorFromContext,
} from "~/apps/knowledge/service"
import { kernelRel } from "~/apps/tickets/schema-refs"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { readActorFile, statActorFile } from "~/cli/provisioners/actor-file"
import { disambiguateTitles, expandKnowledgeDir } from "~/cli/provisioners/knowledge-dir"
import type {
  PendingItem,
  Provisioner,
  ProvisionPlan,
  ProvisionResult,
} from "~/cli/provisioners/types"
import { extractRows, type PrivilegedDb } from "~/db"

/** The largest uploaded file a document is read from. */
const KNOWLEDGE_FILE_MAX_BYTES = 5 * 1024 * 1024

interface KnowledgeSection {
  collections: number
  documents: number
  sources: number
  /** Folder files matched but not imported (empty or too large), with why. */
  skipped?: Array<{ path: string; reason: string }>
}

/**
 * Build the KnowledgeActor for the current context from the actor's own
 * dimension grants. The Knowledge guards read the named `team` / `sensitivity`
 * keys and do not interpret the generic `"*"` key, so a holder of the wildcard
 * data grant (the CLI's provisioning admin, an org admin approving a config
 * tool) gets wildcard `team` + `sensitivity` spelled out, exactly as RLS reads
 * the wildcard. Anyone else acts with their own grants.
 * `expandKnowledgeSensitivityGrants(["*"])` keeps `["*"]`, which satisfies
 * `includesGrant`.
 */
export function knowledgeDimensionGrants(
  grants: Record<string, string[]>,
): Record<string, string[]> {
  if (!(grants["*"] ?? []).includes("*")) return grants
  return { ...grants, team: ["*"], sensitivity: ["*"] }
}

function actorFor(ctx: {
  orgId: string
  actor: { userId: string; scopes: string[]; dimensionGrants: Record<string, string[]> }
}): KnowledgeActor {
  return knowledgeActorFromContext({
    orgId: ctx.orgId,
    userId: ctx.actor.userId,
    scopes: ctx.actor.scopes,
    dimensionGrants: knowledgeDimensionGrants(ctx.actor.dimensionGrants),
  })
}

/**
 * Resolve a config `contentFile` against the config dir, rejecting any path that
 * escapes that dir (absolute paths or `../` traversal). Returns the safe absolute
 * path, or throws `ConfigError(exitCode:2)`.
 */
function resolveContentFile(configDir: string, contentFile: string): string {
  if (isAbsolute(contentFile)) {
    throw new ConfigError(
      `knowledge: contentFile '${contentFile}' must be a path relative to the config file directory (absolute paths are rejected)`,
    )
  }
  const base = resolve(configDir)
  const target = resolve(base, contentFile)
  const rel = relative(base, target)
  // An escaping path produces a `..`-prefixed (or absolute) relative path.
  if (
    rel === ".." ||
    rel.startsWith(`..${"/"}`) ||
    rel.startsWith(`..${"\\"}`) ||
    isAbsolute(rel)
  ) {
    throw new ConfigError(
      `knowledge: contentFile '${contentFile}' escapes the config file directory (path traversal rejected)`,
    )
  }
  return target
}

/** Every live collection name of the org, whoever can see it (privileged, this org only). */
async function orgCollectionNames(ctx: {
  orgId: string
  priv: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>
}): Promise<Set<string>> {
  if (ctx.orgId === "") return new Set()
  return new Set(
    extractRows<{ name: string }>(
      await ctx.priv("config-knowledge-collection-names", (tx) =>
        tx.execute(drizzleSql`
          SELECT name FROM ${knowledgeRel("collections")}
          WHERE org_id = ${ctx.orgId}::uuid AND archived_at IS NULL`),
      ),
    ).map((c) => c.name),
  )
}

export const knowledgeProvisioner: Provisioner<ProvisioningConfig> = {
  key: "knowledge",

  async plan(ctx, config): Promise<ProvisionPlan> {
    const kb = config.knowledge
    if (!kb) return { actions: [] }
    const actions: string[] = []
    // Tool path: collections diff by name against the live org; every
    // document counts as a possible change (its plan echoes the params). The
    // names are read org-wide (privileged, this org only), not through the
    // actor's RLS: the requester plans a proposal and the approver re-plans it,
    // and the two must see the same plan.
    const existing = ctx.toolPath ? await orgCollectionNames(ctx) : null
    let changes = 0
    for (const c of kb.collections ?? []) {
      if (existing?.has(c.name)) {
        actions.push(`collection '${c.name}' unchanged`)
        continue
      }
      changes++
      actions.push(existing ? `create collection '${c.name}'` : `ensure collection '${c.name}'`)
    }
    changes += (kb.documents ?? []).length
    for (const d of kb.documents ?? []) {
      if ("contentFileId" in d && ctx.orgId !== "") {
        // Read as the planning person (the requester at proposal, the approver
        // at execution): both must be able to read the file, and the card
        // names it.
        const file = await statActorFile(ctx, d.contentFileId, `knowledge: document '${d.title}'`)
        actions.push(
          `ensure document '${d.title}' in '${d.collection}' from uploaded file '${file.filename}' (${file.id})`,
        )
        continue
      }
      actions.push(
        "dir" in d
          ? `ensure one document per file under ${d.dir} in '${d.collection}'`
          : "content" in d
            ? `ensure document '${d.title}' in '${d.collection}' (inline, ${Buffer.byteLength(d.content, "utf8")} bytes)`
            : "contentFileId" in d
              ? `ensure document '${d.title}' in '${d.collection}' from uploaded file ${d.contentFileId}`
              : `ensure document '${d.title}' in '${d.collection}' from ${d.contentFile}`,
      )
    }
    for (const s of kb.sources ?? []) actions.push(`register source '${s.type}' (${s.app})`)
    return existing ? { actions, changes } : { actions }
  },

  async apply(ctx, _plan, config): Promise<ProvisionResult> {
    const kb = config.knowledge
    if (!kb) return {}

    const changed: string[] = []
    const unchanged: string[] = []
    const pending: PendingItem[] = []

    // --- collections (idempotent by name) ----------------------------------
    // Resolve collections once into a name→id map the documents step reuses.
    const byName = new Map<string, KnowledgeCollectionRow>()
    // Existence is decided org-wide, the way the plan decides it: a collection
    // the applying person cannot see still exists, and creating another with
    // its name would duplicate it.
    const orgWide = await orgCollectionNames(ctx)
    await ctx.rls(async (rls) => {
      const actor = actorFor(ctx)
      for (const existing of await listKnowledgeCollections(rls, actor)) {
        if (!byName.has(existing.name)) byName.set(existing.name, existing)
      }
      for (const c of kb.collections ?? []) {
        if (byName.has(c.name) || orgWide.has(c.name)) {
          ctx.log(`knowledge: collection '${c.name}' already exists (unchanged)`)
          unchanged.push(`knowledge.collection.${c.name}`)
          continue
        }
        const row = await createKnowledgeCollection(rls, { name: c.name }, actor)
        byName.set(row.name, row)
        ctx.log(`knowledge: collection '${c.name}' created`)
        changed.push(`knowledge.collection.${c.name}`)
      }
    })

    // --- documents (idempotent by (collection, title)) ---------------------
    // Pre-read every contentFile BEFORE any write so a missing/traversal file
    // aborts with exit-2 and no partial document lands (plan-fail-before-write).
    const docPayloads: Array<{ title: string; collectionId: string; body: string }> = []
    const skippedFiles: Array<{ path: string; reason: string }> = []
    // Per collection: titles of single-file entries, and documents from folders.
    const fixedTitles = new Map<string, string[]>()
    const fromDirs = new Map<string, Array<{ path: string; title: string; body: string }>>()
    for (const d of kb.documents ?? []) {
      const collection = byName.get(d.collection)
      if (!collection && orgWide.has(d.collection)) {
        throw new ConfigError(
          `knowledge: collection '${d.collection}' exists but you cannot see it; ask its owner to share it`,
        )
      }
      if (!collection) {
        const what = "dir" in d ? `dir '${d.dir}'` : `document '${d.title}'`
        throw new ConfigError(`knowledge: ${what} references unknown collection '${d.collection}'`)
      }
      if ("dir" in d) {
        const expansion = await expandKnowledgeDir(ctx.configDir, d)
        for (const s of expansion.skipped) {
          ctx.log(`knowledge: skipped '${s.path}' (${s.reason})`)
          skippedFiles.push(s)
        }
        ctx.log(`knowledge: ${expansion.documents.length} file(s) under '${d.dir}'`)
        const list = fromDirs.get(collection.id) ?? []
        list.push(...expansion.documents)
        fromDirs.set(collection.id, list)
        continue
      }
      let body: string
      if ("content" in d) {
        // Stored exactly as given: never interpolated, never read from disk.
        body = d.content
      } else if ("contentFileId" in d) {
        const file = await readActorFile(ctx, d.contentFileId, {
          what: `knowledge: document '${d.title}'`,
          maxBytes: KNOWLEDGE_FILE_MAX_BYTES,
        })
        body = file.bytes.toString("utf8")
      } else {
        const path = resolveContentFile(ctx.configDir, d.contentFile)
        try {
          body = await readFile(path, "utf8")
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          throw new ConfigError(`knowledge: cannot read contentFile '${d.contentFile}': ${reason}`)
        }
      }
      docPayloads.push({ title: d.title, collectionId: collection.id, body })
      const titles = fixedTitles.get(collection.id) ?? []
      titles.push(d.title)
      fixedTitles.set(collection.id, titles)
    }
    for (const [collectionId, docs] of fromDirs) {
      for (const doc of disambiguateTitles(fixedTitles.get(collectionId) ?? [], docs)) {
        docPayloads.push({ title: doc.title, collectionId, body: doc.body })
      }
    }

    if (docPayloads.length > 0) {
      await ctx.rls(async (rls) => {
        const actor = actorFor(ctx)
        for (const payload of docPayloads) {
          // (orgId, collection, title) pre-check: a doc with this exact title
          // that is ALREADY a member of the target collection → skip. Looked up
          // inside the collection, not org-wide: the same title in another
          // collection (a website page and a README both named after the
          // company) is a different document, and matching it made every
          // re-run create the second one again.
          const existing = await rls.execute(drizzleSql`
            SELECT d.id FROM ${knowledgeRel("documents")} d
            JOIN ${knowledgeRel("collection_memberships")} m
              ON m.org_id = d.org_id AND m.target_type = 'document' AND m.target_id = d.id
            WHERE d.org_id = ${ctx.orgId}::uuid AND m.collection_id = ${payload.collectionId}::uuid
              AND d.archived_at IS NULL AND btrim(d.title) = ${payload.title.trim()}
            LIMIT 1
          `)
          if (extractRows(existing).length > 0) {
            ctx.log(`knowledge: document '${payload.title}' already in collection (unchanged)`)
            unchanged.push(`knowledge.document.${payload.title}`)
            continue
          }
          await createKnowledgeDocument(
            rls,
            {
              title: payload.title,
              body: payload.body,
              documentScope: "organization",
              collectionIds: [payload.collectionId],
              tagNames: [],
              team: [],
              sensitivity: "internal",
              verifyNow: false,
            },
            actor,
            // Provisioned from a declarative file, outside any turn (D5).
            [],
          )
          ctx.log(`knowledge: document '${payload.title}' created`)
          changed.push(`knowledge.document.${payload.title}`)
        }
      })
    }

    // --- sources (scoped to pending — see sourcesDecision) -----------------
    for (const s of kb.sources ?? []) {
      // A source needs an ACTIVE app connection to register headlessly; even
      // then, `createSyncedSource` runs a live network folder-read precheck that
      // a provisioning run cannot satisfy. Detect whether the app has ANY active
      // connection to phrase the pending message precisely, then report pending.
      const active = await ctx.priv("cli-knowledge-source-conn-check", (tx) =>
        tx.execute(drizzleSql`
          SELECT id FROM ${kernelRel("connected_accounts")}
          WHERE org_id = ${ctx.orgId}::uuid AND app_name = ${s.app} AND status = 'active'
          LIMIT 1
        `),
      )
      const hasActiveConnection = extractRows(active).length > 0
      const message = hasActiveConnection
        ? `Knowledge source '${s.type}' (${s.app}) requires headless registration which is not available in 'config apply'; register it in the Knowledge UI (Synced Sources) for path '${s.path}'.`
        : `Knowledge source '${s.type}' (${s.app}) cannot be registered until the '${s.app}' app connection is active; connect the app, then register the synced source for path '${s.path}'.`
      ctx.log(`knowledge: source '${s.type}' (${s.app}) → pending (${s.path})`)
      pending.push({
        kind: "source",
        app: s.app,
        action: `register knowledge source '${s.type}' (${s.app}) for '${s.path}'`,
        message,
      })
    }

    // Counts are "ensured to exist after this apply" (created + already-present),
    // so a re-run reports the same totals — an idempotent, stable report.
    const section: KnowledgeSection = {
      collections: (kb.collections ?? []).length,
      documents: docPayloads.length,
      sources: 0, // none registered headlessly — all reported pending
      ...(skippedFiles.length > 0 ? { skipped: skippedFiles } : {}),
    }
    return {
      section,
      ...(changed.length > 0 ? { changed } : {}),
      ...(unchanged.length > 0 ? { unchanged } : {}),
      ...(pending.length > 0 ? { pending } : {}),
    }
  },
}
