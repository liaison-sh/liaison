// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The standard tier's knowledge: three collections (Engineering with Backend
// nested, Sales) and thirteen documents, created by the admin through the
// knowledge service the Knowledge UI calls. A document's review state is then
// set directly (privileged, named): the product reaches `verified`, `stale`
// or `needs_review` only through a review over time.
//
// A developer's own Drive connection is added when `QA_DRIVE_REFRESH_TOKEN` is
// set (OAuth cannot run from a seed); without it the Drive surface shows its
// "not connected" state.
import { knowledgeCollectionSchema, knowledgeCreateDocumentSchema } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { createKnowledgeCollection } from "~/apps/knowledge/collections"
import { createKnowledgeDocument, knowledgeActorFromContext } from "~/apps/knowledge/service"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import type { SeedContext } from "~/seed/context"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import { QA_COLLECTIONS, QA_DOCUMENTS, type QaCollectionKey } from "~/seed/world/qa"

export interface StandardKnowledge {
  collections: Record<QaCollectionKey, string>
  documents: string[]
  driveConnected: boolean
}

export async function seedQaKnowledge(
  ctx: SeedContext,
  adminId: string,
  encryptionKey: string | undefined,
): Promise<StandardKnowledge> {
  const admin = await actorFor(ctx, adminId)
  const actor = knowledgeActorFromContext({
    orgId: ctx.orgId,
    userId: admin.userId,
    scopes: admin.scopes,
    dimensionGrants: admin.dimensionGrants ?? {},
    roles: admin.roles ?? [],
  })

  const collections = {} as Record<QaCollectionKey, string>
  for (const spec of QA_COLLECTIONS) {
    const input = knowledgeCollectionSchema.parse({
      name: spec.name,
      ownerUserId: null,
      ...(spec.parent ? { parentCollectionId: collections[spec.parent] } : {}),
    })
    const row = await asUser(admin, (tx) => createKnowledgeCollection(tx as never, input, actor))
    collections[spec.key] = row.id
  }

  const documents: string[] = []
  for (const spec of QA_DOCUMENTS) {
    const input = knowledgeCreateDocumentSchema.parse({
      title: spec.title,
      body: spec.body,
      documentScope: spec.documentScope,
      collectionIds: spec.collections.map((k) => collections[k]),
      tagNames: [],
      team: [],
      sensitivity: spec.sensitivity,
      verifyNow: false,
    })
    const doc = await asUser(admin, (tx) => createKnowledgeDocument(tx as never, input, actor, []))
    documents.push(doc.id)
    if (spec.reviewStatus) {
      await withPrivilegedDb(ctx.orgId, "seed-standard:knowledge-review-state", (tx) =>
        tx.execute(
          sql`UPDATE ${sql.identifier(schemaRef("app_knowledge"))}.documents
              SET review_status = ${spec.reviewStatus}
              WHERE id = ${doc.id}::uuid AND org_id = ${ctx.orgId}::uuid`,
        ),
      )
    }
  }

  const refreshToken = process.env.QA_DRIVE_REFRESH_TOKEN
  let driveConnected = false
  if (refreshToken && encryptionKey) {
    await withPrivilegedDb(ctx.orgId, "seed-standard:drive-connection", (tx) =>
      tx.execute(
        sql`INSERT INTO ${sql.identifier(schemaRef("kernel"))}.connected_accounts (
              id, org_id, app_name, connection_name, owner_type, owner_id,
              provider_type, identifier, display_name, provider_account_id,
              access_token_encrypted, refresh_token_encrypted,
              credentials_encrypted, status, created_by
            ) VALUES (
              ${ctx.id("qa-connection", "drive")}::uuid, ${ctx.orgId}::uuid, 'google-drive', 'drive',
              'user', ${adminId}::uuid, 'oauth2', 'qa-dev-drive@example.com', 'QA Drive Connection',
              'qa-dev-account-id',
              ${encryptSecret("qa-dev-placeholder-access-token", encryptionKey, CryptoContext.connectedAccountAccessToken)},
              ${encryptSecret(refreshToken, encryptionKey, CryptoContext.connectedAccountRefreshToken)},
              NULL, 'active', ${adminId}::uuid
            )`,
      ),
    )
    driveConnected = true
  } else {
    ctx.log(
      "QA_DRIVE_REFRESH_TOKEN not set: no Drive connection (the Drive surface shows 'not connected')",
    )
  }

  return { collections, documents, driveConnected }
}
