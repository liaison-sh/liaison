// SPDX-License-Identifier: FSL-1.1-ALv2
//
// This server's identity with the Liaison team: a random instance id minted
// when an admin first turns registration on (never `infra/instance-id.ts`, which
// changes every boot), the nonce its registration carries, and the instance key
// the control plane answers once, stored encrypted under ENCRYPTION_KEY. Kept in
// `kernel.instance_settings` (`liaison_team.identity`), privileged pool only.
//
// An instance key that no longer decrypts (ENCRYPTION_KEY changed, a restore
// from elsewhere) counts as no identity: logged once, and the outbox registers
// again under a new id (docs/self-hosting/liaison-team.md).

import { randomBytes, randomUUID } from "node:crypto"
import { sql as drizzleSql, eq } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { instanceSettings } from "~/db/schema/kernel"
import { decryptSecret, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"

/** The `kernel.instance_settings` key of the identity. */
export const IDENTITY_SETTING = "liaison_team.identity"
/** AAD of the instance key ciphertext (`lib/crypto.ts` encryptSecret). */
const KEY_CONTEXT = "liaison-team-instance-key"

export type IdentityState = "pending" | "registered" | "retiring"

export interface LiaisonTeamIdentity {
  instanceId: string
  /** 32 random bytes, base64url: what the registration carries. */
  nonce: string
  /** encryptSecret(instanceKey), null until the registration reply arrived. */
  keyCiphertext: string | null
  state: IdentityState
  registeredAt: string | null
  /** ISO time of the first 401 of an unbroken run; any delivery clears it. */
  authFailingSince: string | null
  /** Control plane clock minus ours, learned from a 401's `Date` header. */
  clockOffsetMs: number
}

type Db = Pick<PrivilegedDb, "select" | "insert" | "delete">

const STATES: readonly IdentityState[] = ["pending", "registered", "retiring"]

function parseIdentity(value: unknown): LiaisonTeamIdentity | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  if (typeof v.instanceId !== "string" || typeof v.nonce !== "string") return null
  // An unknown state written by a newer release reads as no identity: never throw.
  if (!STATES.includes(v.state as IdentityState)) return null
  return {
    instanceId: v.instanceId,
    nonce: v.nonce,
    keyCiphertext: typeof v.keyCiphertext === "string" ? v.keyCiphertext : null,
    state: v.state as IdentityState,
    registeredAt: typeof v.registeredAt === "string" ? v.registeredAt : null,
    authFailingSince: typeof v.authFailingSince === "string" ? v.authFailingSince : null,
    clockOffsetMs: typeof v.clockOffsetMs === "number" ? v.clockOffsetMs : 0,
  }
}

/** The stored identity, or null. */
export async function readIdentity(db: Db): Promise<LiaisonTeamIdentity | null> {
  const [row] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, IDENTITY_SETTING))
  return parseIdentity(row?.value)
}

export async function writeIdentity(db: Db, identity: LiaisonTeamIdentity): Promise<void> {
  await db
    .insert(instanceSettings)
    .values({ key: IDENTITY_SETTING, value: identity, decidedAt: new Date() })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: identity, decidedAt: new Date() },
    })
}

export async function deleteIdentity(db: Db): Promise<void> {
  await db.delete(instanceSettings).where(eq(instanceSettings.key, IDENTITY_SETTING))
}

/**
 * Serialise every change to the switches or the identity (setSharing, and the
 * outbox applying a reply): one transaction-scoped advisory lock, taken first
 * in the transaction, so a reply read before a switch-off can never write the
 * identity back after it.
 */
export async function lockLiaisonTeam(db: Pick<PrivilegedDb, "execute">): Promise<void> {
  await db.execute(drizzleSql`SELECT pg_advisory_xact_lock(hashtext('liaison:liaison_team'))`)
}

/** A fresh identity, state `pending`: a new random id with no link to any earlier one. */
export function mintIdentity(): LiaisonTeamIdentity {
  return {
    instanceId: randomUUID(),
    nonce: randomBytes(32).toString("base64url"),
    keyCiphertext: null,
    state: "pending",
    registeredAt: null,
    authFailingSince: null,
    clockOffsetMs: 0,
  }
}

export function encryptInstanceKey(instanceKey: string): string {
  return encryptSecret(instanceKey, env.ENCRYPTION_KEY, KEY_CONTEXT)
}

let decryptFailureLogged = false

/**
 * The instance key, or null when there is none or it no longer decrypts. A
 * decrypt failure is logged once per process: the caller then registers again.
 */
export function decryptInstanceKey(identity: LiaisonTeamIdentity): string | null {
  if (!identity.keyCiphertext) return null
  try {
    return decryptSecret(identity.keyCiphertext, env.ENCRYPTION_KEY, KEY_CONTEXT)
  } catch (err) {
    if (!decryptFailureLogged) {
      decryptFailureLogged = true
      log.warn(
        { err, instanceId: identity.instanceId },
        "Liaison team instance key does not decrypt (ENCRYPTION_KEY changed or restored from elsewhere): registering again under a new id",
      )
    }
    return null
  }
}
