// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `data` of the messages this server sends to the Liaison team, built and
// checked through the shared contract (`@liaison/control-plane-contract`), so a
// field the control plane does not expect can never be queued. Registration
// and the heartbeat carry the version, the edition and the active user count,
// and nothing else (docs/self-hosting/liaison-team.md lists every field).

import {
  heartbeatDataSchema,
  leadDataSchema,
  leadUpdateDataSchema,
  type MessageData,
  registerDataSchema,
} from "@liaison/control-plane-contract"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { edition } from "~/lib/edition"
import { env } from "~/lib/env"

/** What a register row stores: the nonce is added at send time from the identity. */
export type StoredRegisterData = Omit<MessageData<"register">, "nonce">

/**
 * Active people on this server: every org's `active` users, without import
 * placeholders (`@import.invalid`), demo orgs (`settings.demo`) or orgs being
 * deleted. One query, privileged (it reads every org).
 */
export async function countActiveUsers(db: Pick<PrivilegedDb, "execute">): Promise<number> {
  const K = drizzleSql.raw(`"${schemaRef("kernel")}"`)
  const [row] = extractRows<{ n: number | string }>(
    await db.execute(drizzleSql`
      SELECT count(*)::int AS n
        FROM ${K}.users u
        JOIN ${K}.organizations o ON o.id = u.org_id
       WHERE u.status = 'active'
         AND COALESCE(u.email, '') NOT LIKE '%@import.invalid'
         AND o.deleting_at IS NULL
         AND jsonb_typeof(o.settings -> 'demo') IS DISTINCT FROM 'object'`),
  )
  return Number(row?.n ?? 0)
}

/** The register row's data (the nonce is added when it is sent). */
export function registerData(activeUsers: number): StoredRegisterData {
  // Parsed with a placeholder nonce so the stored part is checked too.
  const { nonce: _nonce, ...data } = registerDataSchema.parse({
    version: env.LIAISON_VERSION,
    edition: edition(),
    activeUsers,
    nonce: "A".repeat(43),
  })
  return data
}

export function heartbeatData(activeUsers: number): MessageData<"heartbeat"> {
  return heartbeatDataSchema.parse({
    version: env.LIAISON_VERSION,
    edition: edition(),
    activeUsers,
  })
}

export function deregisterData(): MessageData<"deregister"> {
  return {}
}

/** The lead message: exactly the Protocol fields, checked through the contract. */
export function leadData(lead: {
  id: string
  email: string
  name: string
  needs: readonly string[]
  verifiedAt: Date | null
  notifyManagedAt: Date | null
  noticeVersion: string
  createdAt: Date
}): MessageData<"lead"> {
  return leadDataSchema.parse({
    leadId: lead.id,
    email: lead.email,
    name: lead.name,
    needs: [...lead.needs],
    verified: lead.verifiedAt !== null,
    notifyManaged: lead.notifyManagedAt !== null,
    noticeVersion: lead.noticeVersion,
    signedUpAt: lead.createdAt.toISOString(),
  })
}

export function leadUpdateData(
  leadId: string,
  change: Omit<MessageData<"lead-update">, "leadId">,
): MessageData<"lead-update"> {
  return leadUpdateDataSchema.parse({ leadId, ...change })
}
