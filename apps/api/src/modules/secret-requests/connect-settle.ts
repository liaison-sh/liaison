// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A CONNECT CARD IS SAVED BY THE GRANT ITSELF.
//
// An `oauth_connect` card asks a person to sign in at the provider. The card
// never learns how that went: the provider's code goes to the server's
// callback, which exchanges it and stores the connected account
// (connections/service.ts, completeOAuthGrant). Right after that store
// commits, this settles the pending connect requests for that connection and
// owner through the same check every card runs (service.ts,
// completeSecretRequest): saved only when the store holds an account it did
// not hold when the agent asked. The code and the tokens never come here; the
// conversation hears which account was connected, nothing more.
//
// WHICH CARDS A GRANT SETTLES. Each card is saved by the account its own grant
// stored (that account's fingerprint), never by any other new account:
//   - a flow started from a card settles that card, and only it;
//   - a personal connect made outside a card (Settings) settles the pending
//     personal cards asked for that same person: it is their own account;
//   - an org connect made outside a card settles no card: another admin
//     connecting another inbox is not what the card asked for.

import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { rootLogger } from "~/lib/logger"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { announceSecretRequestResult } from "~/modules/secret-requests/announce"
import {
  completeSecretRequest,
  pendingRequestIdsForTarget,
} from "~/modules/secret-requests/service"
import { connectAccountFingerprint } from "~/modules/secret-requests/stored"
import type { SecretTarget } from "~/modules/secret-requests/targets"

const log = rootLogger.child({ module: "secret-request-connect" })

export interface SettleConnectArgs {
  orgId: string
  /** The person who finished the grant. */
  userId: string
  appName: string
  connectionName: string
  ownerType: "user" | "org"
  /** The connected account the grant just stored. */
  accountId: string
  /** The card the flow was started from, when one was (the OAuth state carries it). */
  cardRequestId?: string | null
}

/**
 * Settle the pending connect requests the grant just answered. Best effort,
 * after the account was stored: a failure is logged (never the tokens) and the
 * card can still be completed from its own Save path. Returns how many saved.
 */
export async function settleConnectRequests(args: SettleConnectArgs): Promise<number> {
  const target: SecretTarget = {
    kind: "oauth_connect",
    app: args.appName,
    connection: args.connectionName,
    mode: args.ownerType === "org" ? "org" : "personal",
  }
  let settled = 0
  try {
    const ids = args.cardRequestId
      ? [args.cardRequestId]
      : target.mode === "personal"
        ? // A personal connect answers only the requests asked for this person.
          await pendingRequestIdsForTarget(args.orgId, target, args.userId)
        : []
    if (ids.length === 0) return 0
    const perms = await withPrivilegedDb(args.orgId, "secret-request-connect-perms", (tx) =>
      loadEffectivePermissions(tx, args.userId, args.orgId),
    )
    const actor: UserContext = {
      actorType: "user",
      userId: args.userId,
      orgId: args.orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    }
    for (const id of ids) {
      try {
        const saved = await completeSecretRequest({
          orgId: args.orgId,
          id,
          userId: args.userId,
          scopes: perms.scopes,
          fingerprint: connectAccountFingerprint(args.accountId),
        })
        await announceSecretRequestResult(actor, saved)
        settled++
      } catch (err) {
        log.warn(
          { err, orgId: args.orgId, secretRequestId: id },
          "a pending connect request was not settled by the grant",
        )
      }
    }
  } catch (err) {
    log.error(
      { err, orgId: args.orgId, appName: args.appName, connectionName: args.connectionName },
      "failed to settle pending connect requests",
    )
  }
  return settled
}
