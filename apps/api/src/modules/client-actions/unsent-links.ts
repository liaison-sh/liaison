// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Links made by a server that stopped between their commit and their mail: nobody holds them,
// and the same send asked again answers that they exist. This job finds them (a token that
// stands, `sent_at` empty, no failure recorded, owed for some minutes), gives each a fresh token
// and mails it. Never twice: the old token's mail can no longer be claimed, the row is read again
// under its lock, and the fresh one is claimed like any other mail (mint.ts `claimLinkMail`). The
// message its sender typed was only in the memory of the run that stopped, so the mail goes
// without it. A mail already being handed over when the server stopped is not one of these: it
// may have left, and a reminder is the sender's to send.

import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { sweepSkippingMoving, writeUnlessMoving } from "~/modules/org/transfer-state/skip-moving"
import { remailClientAction, unsentLinkSql } from "./mint"

const log = rootLogger.child({ module: "client-actions" })

/** The most links one run mails; the next run takes the rest. */
const PER_RUN = 200

export async function mailUnsentLinks(): Promise<{ mailed: number }> {
  const found = await sweepSkippingMoving((notMoving) =>
    withSystemDb("client-action-unsent-links", async (db) =>
      extractRows<{ id: string; org_id: string }>(
        await db.execute(sql`
          SELECT a.id, a.org_id FROM ${sql.raw(schemaRef("kernel"))}.client_actions a
           WHERE ${unsentLinkSql()} AND ${notMoving(sql.raw("a.org_id"))}
           ORDER BY a.created_at LIMIT ${PER_RUN}
        `),
      ),
    ),
  )
  let mailed = 0
  for (const f of found) {
    try {
      const sent = await writeUnlessMoving(f.org_id, () =>
        remailClientAction(f.org_id, f.id, { onlyUnsent: true }),
      )
      if (sent === true) mailed += 1
    } catch (err) {
      log.error({ err, orgId: f.org_id, actionId: f.id }, "an unsent link was not mailed")
    }
  }
  return { mailed }
}
