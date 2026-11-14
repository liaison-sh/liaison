// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Whether an invoice went out to its customer. An invoice's status stays `issued` when it is sent,
// so the send leaves its own record: a `sent_to_customer` entry on the document's lifecycle log
// (documents_send_to_customer), or an e-invoice the platform took.

import type { MutationsDb } from "./mutations/shared"

export const SENT_EVENT = "sent_to_customer"

/** E-invoice states in which the platform has the invoice. */
const EINVOICE_OUT = new Set(["imported", "validation_pending", "sent"])

/** Record that a document was emailed to its customer, appended to the log as it is at commit. */
export async function recordSent(
  db: Pick<MutationsDb, "batch">,
  documentId: string,
  actor: string | null,
): Promise<void> {
  await db.batch({
    ops: [
      {
        update: "documents",
        id: documentId,
        append: {
          lifecycle_log: [{ event: SENT_EVENT, actor, ts: new Date().toISOString() }],
        },
      },
    ],
  })
}

/** True once the document was emailed to its customer or handed to the e-invoicing platform. */
export async function wasSent(
  db: Pick<MutationsDb, "findMany">,
  doc: { id?: unknown; lifecycle_log?: unknown },
): Promise<boolean> {
  const log = Array.isArray(doc.lifecycle_log)
    ? (doc.lifecycle_log as Array<{ event?: unknown }>)
    : []
  if (log.some((e) => e?.event === SENT_EVENT)) return true
  const transmissions = (await db.findMany("einvoice_transmissions", {
    where: { document_id: String(doc.id), action: "send_einvoice" },
    limit: 20,
  })) as Array<{ state?: unknown }>
  return transmissions.some((t) => EINVOICE_OUT.has(String(t.state ?? "")))
}
