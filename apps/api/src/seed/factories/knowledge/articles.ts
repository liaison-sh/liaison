// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The knowledge articles factory: collections and organization documents
// written in Liaison, through `createKnowledgeCollection` and
// `createKnowledgeDocument` on an RLS transaction (they enforce their own
// scope and sensitivity checks), adopted by name and title on a re-run.
//
// No privileged write. The author is the org admin with explicit wildcard team
// and sensitivity grants (`knowledgeAuthor`), which is exactly what the
// product's own knowledge provisioner (`cli/provisioners/knowledge.ts`) does
// and for the same reason: setting a document's sensitivity requires a grant
// on that dimension, the org owner holds every dimension, and a role-scoped
// person holds none until an admin grants one. Ownership is still the real
// person: `ownerUserId` puts the article on the desk of whoever maintains it.
import { sql } from "drizzle-orm"
import { createKnowledgeCollection } from "~/apps/knowledge/collections"
import {
  createKnowledgeDocument,
  findOrgDocByTitle,
  type KnowledgeActor,
  knowledgeActorFromContext,
} from "~/apps/knowledge/service"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { seedClock } from "~/seed/clock"
import type { SeedContext } from "~/seed/context"
import { asUser, rowsOf } from "~/seed/factories/people/actors"

export interface KnowledgeCollectionSpec {
  key: string
  name: string
  description: string
  /** Person key: the collection's owner and maintainer. */
  owner: string
}

export interface ArticleSpec {
  key: string
  title: string
  collection: string
  /** Person key: the article's owner and author. */
  owner: string
  summary: string
  tags: string[]
  body: string
  /** Days in the PAST for a stale article, days in the future otherwise. */
  reviewDueInDays: number
  verified: boolean
  /** Defaults to "internal" when omitted. */
  sensitivity?: "public" | "internal" | "confidential" | "restricted"
  /** Defaults to "viewer" when omitted. */
  orgAccess?: "none" | "viewer" | "editor"
}

/** `admin` as a knowledge author in the seeded org, holding every team and sensitivity grant. */
export function knowledgeAuthor(ctx: SeedContext, admin: UserContext): KnowledgeActor {
  const actor = knowledgeActorFromContext({
    orgId: ctx.orgId,
    userId: admin.userId,
    scopes: admin.scopes,
    dimensionGrants: { "*": ["*"], team: ["*"], sensitivity: ["*"] },
    roles: admin.roles ?? [],
  })
  return { ...actor, orgId: ctx.orgId }
}

/**
 * The collection named `spec.name`, created as `admin` when the org has none
 * by that name yet.
 */
export async function findOrCreateCollection(
  ctx: SeedContext,
  admin: UserContext,
  spec: { name: string; description: string; ownerUserId: string },
): Promise<string> {
  const author = knowledgeAuthor(ctx, admin)
  return asUser(admin, async (tx) => {
    const existing = rowsOf<{ id: string }>(
      await (tx as { execute: (q: unknown) => Promise<unknown> }).execute(
        sql`SELECT id FROM ${sql.raw(schemaRef("app_knowledge"))}.collections
            WHERE org_id = ${ctx.orgId} AND name = ${spec.name} AND archived_at IS NULL LIMIT 1`,
      ),
    )
    if (existing[0]) return existing[0].id
    const created = await createKnowledgeCollection(
      tx as never,
      {
        name: spec.name,
        description: spec.description,
        ownerUserId: spec.ownerUserId,
        maintainerUserIds: [spec.ownerUserId],
      },
      author,
    )
    return created.id
  })
}

/**
 * Seed the collections, then the articles in them, as `admin`. A negative
 * `reviewDueInDays` puts the review date in the PAST, one of the conditions
 * the review queue selects on.
 */
export async function seedKnowledgeArticles(
  ctx: SeedContext,
  admin: UserContext,
  input: {
    people: Record<string, { userId: string } | undefined>
    collections: readonly KnowledgeCollectionSpec[]
    articles: readonly ArticleSpec[]
  },
): Promise<{ collectionIds: string[]; documentIds: string[]; staleCount: number }> {
  const clock = seedClock(ctx.now)
  const author = knowledgeAuthor(ctx, admin)
  const ownerOf = (key: string): string => {
    const id = input.people[key]?.userId
    if (!id) throw new Error(`knowledge seed: no owner '${key}'`)
    return id
  }

  const collectionIds: Record<string, string> = {}
  for (const spec of input.collections) {
    collectionIds[spec.key] = await findOrCreateCollection(ctx, admin, {
      name: spec.name,
      description: spec.description,
      ownerUserId: ownerOf(spec.owner),
    })
  }

  const documentIds: string[] = []
  let staleCount = 0
  for (const spec of input.articles) {
    const ownerId = ownerOf(spec.owner)
    const collectionId = collectionIds[spec.collection]
    if (!collectionId) throw new Error(`knowledge seed: no collection '${spec.collection}'`)
    const reviewDueAt =
      spec.reviewDueInDays >= 0
        ? clock.daysAfter(spec.reviewDueInDays)
        : clock.daysBefore(-spec.reviewDueInDays)
    if (spec.reviewDueInDays < 0) staleCount++

    await asUser(admin, async (tx) => {
      const existing = await findOrgDocByTitle(tx as never, ctx.orgId, spec.title, author)
      if (existing) {
        documentIds.push(existing.id)
        return
      }
      const created = await createKnowledgeDocument(
        tx as never,
        {
          documentScope: "organization",
          title: spec.title,
          summary: spec.summary,
          body: spec.body,
          collectionIds: [collectionId],
          ownerUserId: ownerId,
          tagNames: spec.tags,
          team: [],
          sensitivity: spec.sensitivity ?? "internal",
          orgAccess: spec.orgAccess ?? "viewer",
          verifyNow: spec.verified,
          reviewDueAt: reviewDueAt.toISOString(),
        } as never,
        author,
        [],
      )
      documentIds.push(created.id)
    })
  }

  return { collectionIds: Object.values(collectionIds), documentIds, staleCount }
}
