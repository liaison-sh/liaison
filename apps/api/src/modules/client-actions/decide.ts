// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reading an action by its token, the page a holder sees, and the one decide.
// `decideClientAction` is the only writer of a decision: one transaction, the
// row locked, its state and its company re-read, the target's hash compared
// with the one frozen at mint (the app's tool is asked first, outside the
// transaction, within its budget), the proof spent, then a guarded UPDATE whose
// WHERE repeats every condition. A second decide finds the row decided and
// gets 409 with the state. Imported only by the public routes and the portal's.

import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { spendProof } from "./codes"
import { writeClientActionEvent } from "./events"
import { maskEmail } from "./mail"
import { SYSTEM_ACTOR_ID } from "./mint"
import { type ClientActionState, clientActionState } from "./state"
import { type ClientActionKind, type ClientActionView, viewTarget } from "./targets"

const K = () => sql.raw(schemaRef("kernel"))

/** The columns the public flow reads. Never the token hashes. */
export interface ActionRow {
  id: string
  org_id: string
  org_name: string
  kind: ClientActionKind
  target_app: string
  target_type: string
  target_id: string
  target_sha256: string
  company_id: string | null
  signer_user_id: string | null
  invited_email: string
  invited_name: string
  expires_at: Date
  first_opened_at: Date | null
  document_shown_at: Date | null
  code_wrong_total: number
  code_locked_at: Date | null
  code_verified_at: Date | null
  decided_at: Date | null
  decision: "signed" | "accepted" | "approved" | "declined" | null
  revoked_at: Date | null
  revoke_reason: string | null
  required_phrase: string | null
  created_by_user_id: string | null
  sender_name: string | null
  sender_email: string | null
  sender_locale: string | null
  has_token: boolean
  company_ended: boolean
  now: Date
}

const ROW_COLUMNS = sql`
  a.id, a.org_id, o.name AS org_name, a.kind, a.target_app, a.target_type, a.target_id,
  a.target_sha256, a.company_id, a.signer_user_id, a.invited_email, a.invited_name, a.expires_at,
  a.first_opened_at, a.document_shown_at, a.code_wrong_total, a.code_locked_at, a.code_verified_at,
  a.decided_at, a.decision, a.revoked_at, a.revoke_reason, a.required_phrase, a.created_by_user_id,
  u.name AS sender_name, u.email AS sender_email, u.locale AS sender_locale,
  (a.token_hash IS NOT NULL) AS has_token,
  (c.id IS NOT NULL AND (c.closed_at IS NOT NULL OR c.portal_ended_at IS NOT NULL)) AS company_ended,
  now() AS now`

function fromRows(rows: ActionRow[]): ActionRow | null {
  const r = rows[0]
  if (!r) return null
  const d = (v: unknown) => (v ? new Date(v as string) : null)
  return {
    ...r,
    expires_at: new Date(r.expires_at),
    first_opened_at: d(r.first_opened_at),
    document_shown_at: d(r.document_shown_at),
    code_locked_at: d(r.code_locked_at),
    code_verified_at: d(r.code_verified_at),
    decided_at: d(r.decided_at),
    revoked_at: d(r.revoked_at),
    now: new Date(r.now),
  }
}

export type TokenMatch = { current: ActionRow } | { prior: ActionRow } | null

/**
 * The action a token names: as its live token, or as one rotated away (which
 * opens only the replaced page). The hash is globally unique, so no org is given.
 */
export async function findByTokenHash(hash: string): Promise<TokenMatch> {
  return withSystemDb("client-action-by-token", async (db) => {
    const current = fromRows(
      extractRows<ActionRow>(
        await db.execute(sql`
          SELECT ${ROW_COLUMNS}
            FROM ${K()}.client_actions a
            JOIN ${K()}.organizations o ON o.id = a.org_id
            LEFT JOIN ${K()}.users u ON u.id = a.created_by_user_id AND u.org_id = a.org_id
            LEFT JOIN ${K()}.companies c ON c.id = a.company_id AND c.org_id = a.org_id
           WHERE a.token_hash = ${hash}
           LIMIT 1
        `),
      ),
    )
    if (current) return { current }
    const prior = fromRows(
      extractRows<ActionRow>(
        await db.execute(sql`
          SELECT ${ROW_COLUMNS}
            FROM ${K()}.client_actions a
            JOIN ${K()}.organizations o ON o.id = a.org_id
            LEFT JOIN ${K()}.users u ON u.id = a.created_by_user_id AND u.org_id = a.org_id
            LEFT JOIN ${K()}.companies c ON c.id = a.company_id AND c.org_id = a.org_id
           WHERE a.prior_token_hashes @> ARRAY[${hash}]::text[]
           LIMIT 1
        `),
      ),
    )
    return prior ? { prior } : null
  })
}

export function stateOf(row: ActionRow): ClientActionState {
  return clientActionState(
    {
      revokedAt: row.revoked_at,
      decidedAt: row.decided_at,
      decision: row.decision,
      expiresAt: row.expires_at,
      codeLockedAt: row.code_locked_at,
      hasToken: row.has_token,
    },
    row.now,
  )
}

/** The page states a holder of a genuine token can see. */
export type Frame =
  | "open"
  | "expired"
  | "used"
  | "revoked"
  | "declined"
  | "signed"
  | "attempts"
  | "replaced"
  | "ended"

export function frameOf(row: ActionRow, via: "current" | "prior"): Frame {
  if (via === "prior") return "replaced"
  if (row.revoked_at) {
    if (row.revoke_reason === "replaced") return "replaced"
    if (row.revoke_reason === "access_ended" || row.revoke_reason === "person_removed")
      return "ended"
    return "revoked"
  }
  if (row.decision === "signed") return "signed"
  if (row.decision === "declined") return "declined"
  if (row.decision) return "used"
  if (row.company_ended) return "ended"
  const s = stateOf(row)
  if (s === "expired") return "expired"
  if (s === "locked") return "attempts"
  if (s === "waiting_turn") return "revoked"
  return "open"
}

/**
 * A dead page: the state, who sent it and the next step, never the document, a
 * price or another name. The next step names what the page offers.
 */
export function deadFrameBody(row: ActionRow, frame: Exclude<Frame, "open">) {
  const next =
    frame === "signed" || frame === "used" || frame === "declined"
      ? "email_copy"
      : frame === "replaced"
        ? "resend_link"
        : "ask_sender"
  return {
    state: frame,
    sender: { name: row.sender_name ?? row.org_name, org: row.org_name },
    next,
  }
}

export function stepsOf(kind: ClientActionKind): string[] {
  return kind === "sign" ? ["read", "identity", "sign"] : ["review", "identity", kind]
}

export function openFrameBody(row: ActionRow, view: ClientActionView) {
  return {
    state: "open" as const,
    kind: row.kind,
    sender: { name: view.senderName ?? row.sender_name ?? row.org_name, org: row.org_name },
    title: view.title,
    ref: row.id.slice(0, 8),
    valid_until: row.expires_at.toISOString(),
    summary: view.summary,
    invited_email_masked: maskEmail(row.invited_email),
    steps: stepsOf(row.kind),
  }
}

export async function viewOf(row: ActionRow): Promise<ClientActionView | "down"> {
  return viewTarget({
    orgId: row.org_id,
    targetApp: row.target_app,
    targetType: row.target_type,
    targetId: row.target_id,
    actingUserId: row.created_by_user_id,
  })
}

const DECISION_OF: Record<ClientActionKind, "signed" | "accepted" | "approved"> = {
  sign: "signed",
  accept: "accepted",
  approve: "approved",
}

/** Name, capacity, phrase and reason: no control character, 200 characters (a reason 2,000). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/
export function cleanTyped(v: string | undefined | null, max = 200): string | null | "invalid" {
  if (v === undefined || v === null) return null
  const t = v.trim()
  if (t === "") return null
  if (t.length > max || CONTROL.test(max > 200 ? t.replace(/[\n\r\t]/g, " ") : t)) return "invalid"
  return t
}

function sameName(a: string, b: string): boolean {
  const n = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase()
  return n(a) === n(b)
}

export type DecideInput = {
  decision: "sign" | "accept" | "approve" | "decline"
  typedName?: string | null
  typedPhrase?: string | null
  reason?: string | null
  ip: string | null
  userAgent: string | null
} & (
  | { via: "link"; tokenHash: string; proof?: string }
  | {
      via: "portal"
      actionId: string
      orgId: string
      portalUserId: string
      /** The portal route checked the emailed code (or the fresh session's click) itself. */
      codeVerified: boolean
    }
)

export type DecideOutcome =
  | { ok: true; state: "signed" | "accepted" | "approved" | "declined"; copyTo: string }
  | { ok: false; status: number; body: Record<string, unknown> }

const NOT_FOUND = { ok: false as const, status: 404, body: { error: { code: "not_found" } } }

/** The one decide. See the file's head for the order of the checks. */
export async function decideClientAction(input: DecideInput): Promise<DecideOutcome> {
  let pre: ActionRow | null
  if (input.via === "link") {
    const m = await findByTokenHash(input.tokenHash)
    if (!m) return NOT_FOUND
    if ("prior" in m) return { ok: false, status: 410, body: deadFrameBody(m.prior, "replaced") }
    pre = m.current
  } else {
    pre = await withPrivilegedDb(input.orgId, "client-action-portal-read", async (tx) =>
      fromRows(
        extractRows<ActionRow>(
          await tx.execute(sql`
            SELECT ${ROW_COLUMNS}
              FROM ${K()}.client_actions a
              JOIN ${K()}.organizations o ON o.id = a.org_id
              LEFT JOIN ${K()}.users u ON u.id = a.created_by_user_id AND u.org_id = a.org_id
              LEFT JOIN ${K()}.companies c ON c.id = a.company_id AND c.org_id = a.org_id
             WHERE a.id = ${input.actionId} AND a.org_id = ${input.orgId}
          `),
        ),
      ),
    )
    if (!pre) return NOT_FOUND
  }
  const wanted = input.decision === "decline" ? "declined" : DECISION_OF[pre.kind]
  if (input.decision !== "decline" && input.decision !== pre.kind) {
    return {
      ok: false,
      status: 400,
      body: { error: { code: "wrong_decision", expected: pre.kind } },
    }
  }
  const name = cleanTyped(input.typedName)
  const phrase = cleanTyped(input.typedPhrase)
  const reason = cleanTyped(input.reason, 2000)
  if (name === "invalid" || phrase === "invalid" || reason === "invalid") {
    return { ok: false, status: 400, body: { error: { code: "invalid_text" } } }
  }

  // Asked before the transaction, within its budget: no lock is held while an app answers.
  const view = await viewOf(pre)
  if (view === "down") return { ok: false, status: 503, body: { state: "down" } }

  const orgId = pre.org_id
  const actionId = pre.id
  return withPrivilegedDb(orgId, "client-action-decide", async (tx) => {
    const row = fromRows(
      extractRows<ActionRow>(
        await tx.execute(sql`
          SELECT ${ROW_COLUMNS}
            FROM ${K()}.client_actions a
            JOIN ${K()}.organizations o ON o.id = a.org_id
            LEFT JOIN ${K()}.users u ON u.id = a.created_by_user_id AND u.org_id = a.org_id
            LEFT JOIN ${K()}.companies c ON c.id = a.company_id AND c.org_id = a.org_id
           WHERE a.id = ${actionId}
           FOR UPDATE OF a
        `),
      ),
    )
    if (!row) return NOT_FOUND
    const frame = frameOf(row, "current")
    if (frame !== "open")
      return { ok: false as const, status: 409, body: deadFrameBody(row, frame) }
    if (view.sha256 !== row.target_sha256) {
      return { ok: false as const, status: 409, body: { error: { code: "VERSION_CHANGED" } } }
    }
    if (input.via === "portal" && !input.codeVerified && wanted !== "declined") {
      return { ok: false as const, status: 401, body: { error: { code: "code_required" } } }
    }
    let provedName: string | null = null
    let provedCapacity: string | null = null
    if (input.via === "link" && wanted !== "declined") {
      const proof = await spendProof(actionId, input.proof, input.userAgent)
      if (!proof.ok)
        return { ok: false as const, status: 401, body: { error: { code: "bad_proof" } } }
      provedName = proof.name
      provedCapacity = proof.capacity
    }
    if (wanted !== "declined") {
      const typed = name ?? provedName
      if (!typed || (provedName && !sameName(typed, provedName))) {
        return { ok: false as const, status: 422, body: { error: { code: "name_mismatch" } } }
      }
      if (row.required_phrase && (!phrase || !sameName(phrase, row.required_phrase))) {
        return { ok: false as const, status: 422, body: { error: { code: "phrase_mismatch" } } }
      }
    }
    const decidedUserId = input.via === "portal" ? input.portalUserId : null
    const updated = extractRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE ${K()}.client_actions
           SET decided_at = now(), decision = ${wanted}, decided_via = ${input.via},
               decided_user_id = ${decidedUserId},
               typed_name = ${wanted === "declined" ? null : (name ?? provedName)},
               capacity = ${wanted === "declined" ? null : provedCapacity},
               typed_phrase = ${wanted === "declined" ? null : phrase},
               decline_reason = ${wanted === "declined" ? reason : null}
         WHERE id = ${actionId} AND decided_at IS NULL AND revoked_at IS NULL
           AND expires_at > now() AND code_locked_at IS NULL
         RETURNING id
      `),
    )
    if (updated.length === 0) {
      return { ok: false as const, status: 409, body: { state: frameOf(row, "current") } }
    }
    await writeClientActionEvent(tx, {
      orgId,
      actionId,
      event: wanted === "declined" ? "declined" : "decided",
      actorKind: input.via === "portal" ? "portal_user" : "holder",
      actorUserId: decidedUserId,
      meta: { decision: wanted, via: input.via, code_verified: row.code_verified_at !== null },
      ip: input.ip,
      userAgent: input.userAgent,
    })
    await tx.queueEvent({
      app: "kernel",
      entity: "client_action",
      action: "decided",
      entityId: actionId,
      data: {
        id: actionId,
        kind: row.kind,
        target: { app: row.target_app, type: row.target_type, id: row.target_id },
        decision: wanted,
        decided_via: input.via,
        companyId: row.company_id,
        title: view.title,
        invitedName: row.invited_name,
        senderUserIds: row.created_by_user_id ? [row.created_by_user_id] : [],
      },
      actorId: SYSTEM_ACTOR_ID,
      actorType: "system",
      orgId,
    })
    return { ok: true as const, state: wanted, copyTo: maskEmail(row.invited_email) }
  })
}
