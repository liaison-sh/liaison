// SPDX-License-Identifier: FSL-1.1-ALv2

import { and, eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { oauthAccounts, roles, userRoles, users } from "~/db/schema/kernel"
import { authLogger as log } from "~/lib/logger"
import { assertSeatRoom } from "~/modules/org/caps"

interface AutoProvisionParams {
  orgId: string
  email: string
  name: string
  providerId: string
  externalSubject: string
  externalEmail: string
  externalProfile: unknown
}

/** Auto-provision found the email already taken in the org; nothing was linked. */
export class OAuthEmailTakenError extends Error {
  constructor() {
    super("An account with this email already exists")
    this.name = "OAuthEmailTakenError"
  }
}

export async function autoProvisionUser(db: RlsClient, params: AutoProvisionParams) {
  return db.transaction(async (tx) => {
    // Lookup default "member" role
    const [defaultRole] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, params.orgId), eq(roles.name, "member")))
      .limit(1)

    // The org's seat cap (modules/org/caps.ts), under its seats lock: a refusal
    // (CapLimitError) fails the sign-in before any row is written.
    await assertSeatRoom(tx, params.orgId)

    let newUser: typeof users.$inferSelect
    try {
      // Its own SAVEPOINT: a concurrent provision's 23505 must roll back only this
      // insert, so the lookup and link below still run on a live transaction.
      ;[newUser] = await tx.transaction((sp) =>
        sp
          .insert(users)
          .values({
            orgId: params.orgId,
            email: params.email.toLowerCase(),
            name: params.name,
            status: "active",
          })
          .returning(),
      )
    } catch (err: any) {
      // The email already belongs to an account (one created a moment ago by a
      // concurrent provision, an invitation or an operator). A provider identity
      // is never linked to an existing account on its email: the caller refuses
      // the sign-in exactly as it does when it sees the account before trying.
      // Drizzle wraps the postgres error, so the SQLSTATE sits on `.cause`.
      if ((err?.code ?? err?.cause?.code) === "23505") {
        log.info(
          { orgId: params.orgId, providerId: params.providerId },
          "OAuth auto-provision refused: the email belongs to an existing account",
        )
        throw new OAuthEmailTakenError()
      }
      throw err
    }

    await tx.insert(oauthAccounts).values({
      userId: newUser.id,
      orgId: params.orgId,
      providerId: params.providerId,
      externalSubject: params.externalSubject,
      externalEmail: params.externalEmail,
      externalProfile: params.externalProfile,
    })

    if (defaultRole) {
      await tx.insert(userRoles).values({
        userId: newUser.id,
        roleId: defaultRole.id,
        orgId: params.orgId,
      })
    } else {
      log.warn(
        { orgId: params.orgId, email: params.email },
        "No default 'member' role found — user provisioned without role",
      )
    }

    log.info({ userId: newUser.id, email: params.email }, "OAuth auto-provisioned user")
    return newUser
  })
}
