// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Trusted senders (kernel.trusted_senders, migration 0154): addresses and domains staff marked
// as trusted for their org. One mechanism, two readers:
//   - inbound mail (apps/tickets/inbound.ts): a trusted sender whose message carries no provider
//     verdict counts as verified for acknowledgement, desk routing, contact linking and adding
//     participants. A message the provider says is forged ("fail") stays forged.
//   - calendar invitations (modules/agent/scopes/known-guests.ts): a trusted address or domain is
//     a known guest.
// A public mail provider's domain is never trusted at domain level (only single addresses
// there): refused on write, and ignored on read should one ever be stored.

import {
  emailDomainOf,
  isPublicEmailProvider,
  type TrustedSender,
  type TrustedSenderCreate,
} from "@liaison/shared"
import { and, asc, eq } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { trustedSenders } from "~/db/schema/kernel"
import type { SenderAuth } from "~/lib/email/sender-auth"

/** Who may change the list: a contacts admin or a tickets settings admin. */
export const TRUSTED_SENDERS_ADMIN_SCOPES = ["kernel:contacts:admin", "tickets:settings:admin"]
/** Who may read it: anyone who reads contacts or tickets. */
export const TRUSTED_SENDERS_READ_SCOPES = ["kernel:contacts:read", "tickets:tickets:read"]

function toDto(row: typeof trustedSenders.$inferSelect): TrustedSender {
  return {
    id: row.id,
    kind: row.kind,
    value: row.value,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function listTrustedSenders(orgId: string): Promise<TrustedSender[]> {
  const rows = await withPrivilegedDb(orgId, "trusted-senders-list", (tx) =>
    tx
      .select()
      .from(trustedSenders)
      .where(eq(trustedSenders.orgId, orgId))
      .orderBy(asc(trustedSenders.kind), asc(trustedSenders.value)),
  )
  return rows.map(toDto)
}

/** Add an entry (idempotent: an existing one is returned). Recorded as an audited event. */
export async function addTrustedSender(
  orgId: string,
  userId: string,
  input: TrustedSenderCreate,
): Promise<TrustedSender> {
  if (input.kind === "domain" && isPublicEmailProvider(input.value)) {
    throw new Error("a public mail provider's domain cannot be trusted")
  }
  return withPrivilegedDb(orgId, "trusted-senders-add", async (tx) => {
    const [inserted] = await tx
      .insert(trustedSenders)
      .values({ orgId, kind: input.kind, value: input.value, createdBy: userId })
      .onConflictDoNothing()
      .returning()
    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(trustedSenders)
        .where(
          and(
            eq(trustedSenders.orgId, orgId),
            eq(trustedSenders.kind, input.kind),
            eq(trustedSenders.value, input.value),
          ),
        )
      if (!existing) throw new Error("trusted sender insert conflicted but no row exists")
      return toDto(existing)
    }
    await tx.queueEvent({
      app: "kernel",
      entity: "trusted_sender",
      action: "create",
      entityId: inserted.id,
      orgId,
      actorId: userId,
      data: { kind: inserted.kind, value: inserted.value },
    })
    return toDto(inserted)
  })
}

/** Remove an entry. False when it does not exist in this org. Recorded as an audited event. */
export async function removeTrustedSender(
  orgId: string,
  userId: string,
  id: string,
): Promise<boolean> {
  return withPrivilegedDb(orgId, "trusted-senders-remove", async (tx) => {
    const [removed] = await tx
      .delete(trustedSenders)
      .where(and(eq(trustedSenders.orgId, orgId), eq(trustedSenders.id, id)))
      .returning()
    if (!removed) return false
    await tx.queueEvent({
      app: "kernel",
      entity: "trusted_sender",
      action: "delete",
      entityId: removed.id,
      orgId,
      actorId: userId,
      data: { kind: removed.kind, value: removed.value },
    })
    return true
  })
}

/**
 * Which of these addresses are trusted, by exact address or by their (non-public) domain.
 * A caller holding a privileged transaction passes it as `privilegedTx`: the list is then read
 * on it, never on a second privileged connection.
 */
export async function trustedAmong(
  orgId: string,
  addresses: string[],
  privilegedTx?: PrivilegedDb,
): Promise<Set<string>> {
  const wanted = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))]
  if (wanted.length === 0) return new Set()
  const read = (tx: PrivilegedDb) =>
    tx
      .select({ kind: trustedSenders.kind, value: trustedSenders.value })
      .from(trustedSenders)
      .where(eq(trustedSenders.orgId, orgId))
  const rows = privilegedTx
    ? await read(privilegedTx)
    : await withPrivilegedDb(orgId, "trusted-senders-match", read)
  const exact = new Set(rows.filter((r) => r.kind === "address").map((r) => r.value))
  const domains = new Set(
    rows.filter((r) => r.kind === "domain" && !isPublicEmailProvider(r.value)).map((r) => r.value),
  )
  return new Set(
    wanted.filter((a) => {
      if (exact.has(a)) return true
      const d = emailDomainOf(a)
      return !!d && domains.has(d) && !isPublicEmailProvider(d)
    }),
  )
}

export async function isTrustedSender(
  orgId: string,
  address: string | null | undefined,
  privilegedTx?: PrivilegedDb,
): Promise<boolean> {
  if (!address) return false
  return (await trustedAmong(orgId, [address], privilegedTx)).size > 0
}

/**
 * The sender verdict the inbound rules act on: the provider's own, except that a message with no
 * verdict ("none") from a trusted sender counts as verified. A failed verdict stays failed: a
 * forged From of a trusted address gains nothing.
 */
export async function senderAuthForRules(
  orgId: string,
  verdict: SenderAuth,
  from: string | null | undefined,
  privilegedTx?: PrivilegedDb,
): Promise<SenderAuth> {
  if (verdict !== "none") return verdict
  return (await isTrustedSender(orgId, from, privilegedTx)) ? "pass" : verdict
}
