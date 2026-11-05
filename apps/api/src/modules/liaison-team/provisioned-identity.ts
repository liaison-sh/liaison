// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A provisioned identity: minted on this server and pinned by the control
// plane's operator, never obtained by registering (the managed edition). Two
// steps, run by `liaison team identity mint|install` (cli/team-identity.ts):
//
//   mint     a fresh instance id, state `pending`, nothing queued; the operator
//            pins the id on the control plane, which derives the instance key.
//   install  the instance key from a file, encrypted under ENCRYPTION_KEY,
//            state `registered`.
//
// Both run in one privileged transaction under the liaison team lock
// (`lockLiaisonTeam`), so they never interleave with the outbox.

import { createHash } from "node:crypto"
import { withSystemDb } from "~/db/privileged"
import {
  deleteIdentity,
  encryptInstanceKey,
  type LiaisonTeamIdentity,
  lockLiaisonTeam,
  mintIdentity,
  readIdentity,
  writeIdentity,
} from "./identity"
import { cancelPending } from "./outbox"

/** A refused mint or install, with the reason an operator can act on. */
export class ProvisionedIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProvisionedIdentityError"
  }
}

const HEX_64 = /^[0-9a-f]{64}$/

/** First 16 hex chars of sha256(instance key): what the control plane pins beside the id. */
export function instanceKeyFingerprint(instanceKey: string): string {
  return createHash("sha256").update(instanceKey).digest("hex").slice(0, 16)
}

/**
 * Mint a new identity (state `pending`). Refuses when one exists unless
 * `force` (re-keying): the old identity is then forgotten and every waiting
 * outbox row cancelled, as a new identity starts with an empty queue.
 */
export async function mintProvisionedIdentity(
  opts: { force?: boolean; now?: Date } = {},
): Promise<LiaisonTeamIdentity> {
  return withSystemDb("liaison-team:identity-mint", async (tx) => {
    await lockLiaisonTeam(tx)
    const existing = await readIdentity(tx)
    if (existing && !opts.force) {
      throw new ProvisionedIdentityError(
        `This server already has an identity (${existing.instanceId}, ${existing.state}); pass --force to replace it`,
      )
    }
    if (existing) await deleteIdentity(tx)
    await cancelPending(tx, "new_identity", opts.now)
    const minted = mintIdentity()
    await writeIdentity(tx, minted)
    return minted
  })
}

/** Install the instance key for the minted identity: state `registered`. */
export async function installProvisionedKey(
  instanceKey: string,
  now: Date = new Date(),
): Promise<{ instanceId: string; fingerprint: string }> {
  const key = instanceKey.trim()
  if (!HEX_64.test(key)) {
    throw new ProvisionedIdentityError("The instance key must be 64 lowercase hex characters")
  }
  return withSystemDb("liaison-team:identity-install", async (tx) => {
    await lockLiaisonTeam(tx)
    const identity = await readIdentity(tx)
    if (!identity) {
      throw new ProvisionedIdentityError(
        "No identity to install a key for: run `liaison team identity mint` first",
      )
    }
    if (identity.state !== "pending") {
      throw new ProvisionedIdentityError(
        `The identity ${identity.instanceId} is ${identity.state}, not pending: mint a new one with --force to re-key`,
      )
    }
    await writeIdentity(tx, {
      ...identity,
      keyCiphertext: encryptInstanceKey(key),
      state: "registered",
      registeredAt: now.toISOString(),
      authFailingSince: null,
    })
    return { instanceId: identity.instanceId, fingerprint: instanceKeyFingerprint(key) }
  })
}
