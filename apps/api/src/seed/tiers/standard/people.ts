// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The standard tier's people: the four QA teammates join the admin's org the
// way an invited person does (a role of their own, the admin's invitation,
// the invitee's registration), then the approver split and the knowledge
// grants are applied.
//
// Privileged writes, named: the per-person role and its scope grants (the
// admin's role editor writes the same rows), the approver split's revokes and
// direct grants, and the permission version bump that makes a running server
// drop its cached permissions.
import { and, eq, inArray, sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { inviteRegister } from "~/modules/auth/auth"
import { createInvitation } from "~/modules/users/invites"
import type { SeedContext } from "~/seed/context"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import {
  QA_APPROVER_SPLIT,
  QA_KNOWLEDGE_DIMENSIONS,
  QA_MEMBER_SCOPES,
  QA_MEMBERS,
  QA_PASSWORD,
  type QaMemberKey,
  type QaPersonKey,
} from "~/seed/world/qa"

export interface StandardPerson {
  id: string
  email: string
  name: string
}

export type StandardPeople = Record<QaPersonKey, StandardPerson>

const K = () => sql.identifier(schemaRef("kernel"))

/** The QA people already in this org, by email. */
export async function existingQaMembers(orgId: string): Promise<string[]> {
  const rows = await withSystemDb("seed-standard:people-present", (tx) =>
    tx
      .select({ email: users.email })
      .from(users)
      .where(
        and(
          eq(users.orgId, orgId),
          inArray(
            users.email,
            QA_MEMBERS.map((m) => m.email),
          ),
        ),
      ),
  )
  return rows.map((r) => r.email)
}

/**
 * A role carrying exactly `scopes`, named as the QA roles always were
 * (`e2e-role-<instant>-<person>`).
 */
async function createMemberRole(
  ctx: SeedContext,
  key: QaMemberKey,
  scopes: readonly string[],
): Promise<string> {
  return withPrivilegedDb(ctx.orgId, "seed-standard:member-role", async (tx) => {
    const roleId = ctx.id("qa-role", key)
    await tx.execute(
      sql`INSERT INTO ${K()}.roles (id, org_id, name, description)
          VALUES (${roleId}::uuid, ${ctx.orgId}::uuid, ${`e2e-role-${ctx.now.getTime()}-${key}`},
                  'E2E test role')`,
    )
    for (const scope of scopes) {
      await tx.execute(
        sql`INSERT INTO ${K()}.role_scope_grants (role_id, scope) VALUES (${roleId}::uuid, ${scope})`,
      )
    }
    return roleId
  })
}

/** Invite `email` to `roleId` as the admin, then register the invitee. */
async function inviteAndRegister(
  ctx: SeedContext,
  adminId: string,
  member: { email: string; name: string },
  roleId: string,
): Promise<string> {
  const admin = await actorFor(ctx, adminId)
  const invited = await asUser(admin, (tx) =>
    createInvitation(tx as never, {
      orgId: ctx.orgId,
      email: member.email,
      roleId,
      invitedBy: adminId,
      actorScopes: admin.scopes,
      actorDimensionGrants: admin.dimensionGrants ?? {},
    }),
  )
  if (!invited || "error" in invited) {
    throw new Error(
      `standard seed: invitation of ${member.email} refused: ${invited ? invited.error : "role not found"}`,
    )
  }
  const registered = await inviteRegister(invited.inviteToken, QA_PASSWORD, member.name)
  if (!registered.success) {
    throw new Error(`standard seed: registration of ${member.email} failed: ${registered.error}`)
  }
  // What the registration route records once the account exists.
  await withSystemDb("seed-standard:registered-event", (db) =>
    db.queueEvent({
      app: "kernel",
      entity: "user",
      action: "registered",
      entityId: registered.data.userId,
      orgId: ctx.orgId,
      actorType: "system",
      data: { method: "invitation" },
    }),
  )
  return registered.data.userId
}

/** The four teammates, invited and registered in order. */
export async function seedQaMembers(
  ctx: SeedContext,
  admin: StandardPerson,
): Promise<StandardPeople> {
  const people = { admin } as StandardPeople
  for (const member of QA_MEMBERS) {
    const roleId = await createMemberRole(ctx, member.key, QA_MEMBER_SCOPES)
    const id = await inviteAndRegister(ctx, admin.id, member, roleId)
    people[member.key] = { id, email: member.email, name: member.name }
  }
  return people
}

/**
 * The approver split (`QA_APPROVER_SPLIT`), then a permission version bump for
 * everyone it touched, so a server that cached their permissions reloads them.
 */
export async function applyApproverSplit(ctx: SeedContext, people: StandardPeople): Promise<void> {
  await withPrivilegedDb(ctx.orgId, "seed-standard:approver-split", async (tx) => {
    for (const { key, scopes } of QA_APPROVER_SPLIT.revoked) {
      await tx.execute(
        sql`DELETE FROM ${K()}.role_scope_grants rsg
            USING ${K()}.user_roles ur
            WHERE rsg.role_id = ur.role_id AND ur.user_id = ${people[key].id}::uuid
              AND rsg.scope IN (${sql.join(
                scopes.map((s) => sql`${s}`),
                sql`, `,
              )})`,
      )
    }
    for (const { key, scope } of QA_APPROVER_SPLIT.userScopes) {
      await tx.execute(
        sql`INSERT INTO ${K()}.user_scope_grants (user_id, org_id, scope)
            VALUES (${people[key].id}::uuid, ${ctx.orgId}::uuid, ${scope}) ON CONFLICT DO NOTHING`,
      )
    }
    for (const { key, dimension, values } of QA_APPROVER_SPLIT.userDimensions) {
      await upsertUserDimension(tx, ctx.orgId, people[key].id, dimension, values)
    }
    const touched = [...new Set(QA_APPROVER_SPLIT.revoked.map((r) => people[r.key].id))]
    await tx.execute(
      sql`UPDATE ${K()}.users SET permission_version = permission_version + 1
          WHERE id IN (${sql.join(
            touched.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
    )
  })
}

type PrivTx = Parameters<Parameters<typeof withPrivilegedDb>[2]>[0]

async function upsertUserDimension(
  tx: PrivTx,
  orgId: string,
  userId: string,
  dimension: string,
  values: readonly string[],
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO ${K()}.user_dimension_grants (user_id, org_id, dimension_key, dimension_values)
        VALUES (${userId}::uuid, ${orgId}::uuid, ${dimension}, ${JSON.stringify(values)}::jsonb)
        ON CONFLICT (user_id, org_id, dimension_key)
        DO UPDATE SET dimension_values = EXCLUDED.dimension_values`,
  )
}

/** Every person sees every team's and every sensitivity's knowledge (`QA_KNOWLEDGE_DIMENSIONS`). */
export async function grantKnowledgeDimensions(
  ctx: SeedContext,
  people: StandardPeople,
): Promise<void> {
  const order: QaPersonKey[] = ["admin", "amina", "lucas", "tobias", "margot"]
  await withPrivilegedDb(ctx.orgId, "seed-standard:knowledge-dimensions", async (tx) => {
    for (const key of order) {
      for (const { dimension, values } of QA_KNOWLEDGE_DIMENSIONS) {
        await upsertUserDimension(tx, ctx.orgId, people[key].id, dimension, values)
      }
    }
  })
}
