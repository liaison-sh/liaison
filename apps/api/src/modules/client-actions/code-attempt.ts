// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One try of an emailed code, the same for the link page and the portal: the
// guess takes its place in the row's total before it is compared (guesses sent at
// once never pass the lock), a right code or one never compared gives the place
// back, five wrong per code pause, twenty in total lock. The consent words a
// decision records are made here too, in the page's language.

import { toShippedLocale } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { serverT } from "~/modules/i18n/server-i18n"
import { checkCode, PAUSES_TO_TELL, pausedUntil, WRONG_PER_CODE, WRONG_TOTAL_LOCK } from "./codes"
import { type ActionRow, deadFrameBody } from "./decide"
import { type ClientActionActorKind, writeClientActionEvent } from "./events"
import { clientActionHearers } from "./hearers"
import { SYSTEM_ACTOR_ID } from "./mint"

const K = () => sql.raw(schemaRef("kernel"))

/** The consent words for a decision, in the page's language, else the sender's, else English. */
export function wordsFor(
  row: Pick<ActionRow, "kind" | "sender_locale">,
  title: string,
  pageLang?: string,
) {
  const lang =
    toShippedLocale(pageLang ?? undefined) ??
    toShippedLocale(row.sender_locale ?? undefined) ??
    "en"
  const words_key = `client-action.words.${row.kind}`
  return { words: serverT(lang, words_key, { title }), words_key, lang }
}

/** A kernel event about one client action (opened, requested, code locked). */
export async function queueClientActionEvent(
  tx: PrivilegedDb,
  row: ActionRow,
  action: "opened" | "requested" | "code_locked",
  data: Record<string, unknown>,
) {
  return await tx.queueEvent({
    app: "kernel",
    entity: "client_action",
    action,
    entityId: row.id,
    data: {
      id: row.id,
      kind: row.kind,
      companyId: row.company_id,
      invitedName: row.invited_name,
      senderUserIds: await clientActionHearers(tx, row.org_id, row.id),
      ...data,
    },
    actorId: SYSTEM_ACTOR_ID,
    actorType: "system",
    orgId: row.org_id,
  })
}

export interface CodeActor {
  kind: Extract<ClientActionActorKind, "holder" | "portal_user">
  userId: string | null
  ip: string | null
  userAgent: string | null
}

export type CodeAttempt =
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> }

/** Tries one typed code against the action's budgets; a right code is spent. */
export async function attemptCode(
  row: ActionRow,
  typed: string,
  actor: CodeActor,
): Promise<CodeAttempt> {
  const taken = await withPrivilegedDb(row.org_id, "client-action-code-try", async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE ${K()}.client_actions SET code_wrong_total = code_wrong_total + 1
         WHERE id = ${row.id} AND code_wrong_total < ${WRONG_TOTAL_LOCK} AND code_locked_at IS NULL
         RETURNING id
      `),
    ),
  )
  if (taken.length === 0) return { ok: false, status: 410, body: deadFrameBody(row, "attempts") }
  const giveBack = () =>
    withPrivilegedDb(row.org_id, "client-action-code-try-back", (tx) =>
      tx.execute(sql`
        UPDATE ${K()}.client_actions SET code_wrong_total = greatest(code_wrong_total - 1, 0)
         WHERE id = ${row.id}
      `),
    )
  const check = await checkCode(row.id, typed.trim())
  if (check.ok) {
    await giveBack()
    return { ok: true }
  }
  if (check.reason === "paused") {
    await giveBack()
    return {
      ok: false,
      status: 423,
      body: { error: { code: "paused", retry_at: check.until.toISOString() } },
    }
  }
  if (check.reason === "no_code") {
    await giveBack()
    return { ok: false, status: 401, body: { error: { code: "code_ended" } } }
  }
  // Wrong: the total lives on the row, so neither a new code nor a new address resets it.
  const total = await withPrivilegedDb(row.org_id, "client-action-code-wrong", async (tx) => {
    const [r] = extractRows<{ code_wrong_total: number; locked: boolean }>(
      await tx.execute(sql`
        UPDATE ${K()}.client_actions
           SET code_locked_at = CASE WHEN code_wrong_total >= ${WRONG_TOTAL_LOCK}
                                     THEN coalesce(code_locked_at, now()) ELSE code_locked_at END
         WHERE id = ${row.id}
         RETURNING code_wrong_total, (code_locked_at IS NOT NULL) AS locked
      `),
    )
    await writeClientActionEvent(tx, {
      orgId: row.org_id,
      actionId: row.id,
      event: r?.locked ? "locked" : check.pausedNow ? "paused" : "code_wrong",
      actorKind: actor.kind,
      actorUserId: actor.userId,
      ip: actor.ip,
      userAgent: actor.userAgent,
    })
    if (r?.locked || check.pausesInARow >= PAUSES_TO_TELL) {
      await queueClientActionEvent(tx, row, "code_locked", { locked: r?.locked === true })
    }
    return r
  })
  if (total?.locked) return { ok: false, status: 410, body: deadFrameBody(row, "attempts") }
  if (check.pausedNow) {
    const until = await pausedUntil(row.id)
    return {
      ok: false,
      status: 423,
      body: { error: { code: "paused", retry_at: until?.toISOString() ?? null } },
    }
  }
  return {
    ok: false,
    status: 401,
    body: { error: { code: "wrong_code", left: WRONG_PER_CODE - check.wrongForCode } },
  }
}
