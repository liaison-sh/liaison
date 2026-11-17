// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `change_request_send`: one card holding a reply to the client's mail and a change request on
// a signed agreement. An agent's call parks the card; the person sees the reply, the work, the
// hours with their source, the rate and the price, and the passage of the signed text it rests
// on, and may change the hours and the rate (the payload is bound again). Approved, the change
// request is written and frozen, its approval link is minted under the card's mail check (a
// client who wrote after the card stops it: nothing is sent), and the reply leaves from the
// person's mailbox under the same check. A reply that fails revokes the link, and the change
// request stays a draft. Nothing is marked started.

import type { DbBatchOp } from "@liaison/app-sdk"
import { accessOps, currentShares, emitAccessChanged, type OrgAccess } from "./access"
import { agreementPrepare } from "./agreements"
import { CHANGE_REQUEST, changeRequestPrice } from "./change-requests"
import {
  type AgreementsCtx,
  actingAgentId,
  bridgeAnswer,
  callerUserId,
  type ErrorEnvelope,
  refusal,
} from "./ctx"
import { agreementPassageGet } from "./passage"
import { resolveSigners, TARGET_TYPE } from "./send"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LINK_DAYS = 14

export interface ChangeRequestSendParams {
  parent_agreement_id: string
  title: string
  work: string[]
  hours_minutes: number
  hours_source: string
  rate_minor: string | number
  reply: { conversation_id: string; body: string }
  passage: { version_id: string; section: string }
  mail_message_id: string
  sendGuard?: Record<string, unknown>
  guardKey?: string
  /** Pinned by the preflight: the parent's currency, for the card. */
  currency?: string
}

interface Parent {
  id: string
  number: string
  title: string
  kind: string
  status: string
  company_id?: string | null
  contact_id?: string | null
  project_id?: string | null
  currency?: string | null
  language?: string | null
  org_access?: string | null
}

interface Ready {
  parent: Parent
  passage: { version_number: number; section: string; text: string }
  price: bigint
  rate: bigint
  client: { contact_id: string | null; email: string; name: string }
}

function isError(x: unknown): x is ErrorEnvelope {
  return typeof x === "object" && x !== null && (x as { status?: unknown }).status === "error"
}

function minorOf(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  if (typeof v === "string" && /^\d{1,15}$/.test(v)) return BigInt(v)
  return null
}

/** A money amount for the card and the text: "1,234.50 EUR", from minor units, no float. */
export function moneyText(minor: bigint, currency: string | null | undefined): string {
  const whole = (minor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  const cents = (minor % 100n).toString().padStart(2, "0")
  return `${whole}.${cents}${currency ? ` ${currency}` : ""}`
}

function hoursText(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** Every refusal the send has, before the card and again when it is approved. */
async function readyToSend(
  ctx: AgreementsCtx,
  p: ChangeRequestSendParams,
): Promise<Ready | ErrorEnvelope> {
  if (typeof p?.parent_agreement_id !== "string" || !UUID.test(p.parent_agreement_id))
    return refusal(
      "NOT_FOUND",
      "parent_agreement_id is the signed agreement's id. Nothing was sent.",
    )
  const parent = (await ctx.db.findOne("agreements", p.parent_agreement_id)) as Parent | null
  if (!parent)
    return refusal("NOT_FOUND", "No agreement you can see has this id. Nothing was sent.")
  if (parent.kind === CHANGE_REQUEST)
    return refusal(
      "PARENT_IS_A_CHANGE_REQUEST",
      `${parent.number} is itself a change request: a change request goes on the signed agreement. Nothing was sent.`,
    )
  if (parent.status !== "signed")
    return refusal(
      "PARENT_NOT_SIGNED",
      `${parent.number} is ${parent.status}, not signed: a change request needs a signed agreement. Answer from the draft, and say it is a draft. Nothing was sent.`,
    )
  if (typeof p.title !== "string" || p.title.trim() === "")
    return refusal("TITLE_REQUIRED", "A change request needs a title. Nothing was sent.")
  const work = Array.isArray(p.work) ? p.work.filter((w) => typeof w === "string" && w.trim()) : []
  if (work.length === 0)
    return refusal("WORK_REQUIRED", "A change request lists the work it adds. Nothing was sent.")
  if (!Number.isSafeInteger(p.hours_minutes) || p.hours_minutes <= 0)
    return refusal(
      "HOURS_REQUIRED",
      "hours_minutes is the work's size in minutes, more than 0. Nothing was sent.",
    )
  if (typeof p.hours_source !== "string" || p.hours_source.trim() === "")
    return refusal(
      "HOURS_SOURCE_REQUIRED",
      "hours_source says where the hours come from (past similar work, the person's estimate). Nothing was sent.",
    )
  const rate = minorOf(p.rate_minor)
  if (rate === null)
    return refusal(
      "RATE_REQUIRED",
      "rate_minor is the hourly rate from the signed text, in minor units. Nothing was sent.",
    )
  if (
    typeof p.reply?.conversation_id !== "string" ||
    !UUID.test(p.reply.conversation_id) ||
    typeof p.reply.body !== "string" ||
    p.reply.body.trim() === ""
  )
    return refusal(
      "REPLY_REQUIRED",
      "reply is the answer to the client's mail: its conversation_id and body. Nothing was sent.",
    )
  if (typeof p.mail_message_id !== "string" || p.mail_message_id.trim() === "")
    return refusal("MAIL_REQUIRED", "mail_message_id is the client's mail. Nothing was sent.")
  // The passage is read from the signed text, never from memory, and must be the parent's.
  const read = (await agreementPassageGet(ctx, p.passage ?? {})) as Record<string, unknown>
  if (isError(read)) return read
  const ref = read as {
    agreement: { id: string }
    version: { number: number; status: string }
    passage: { section: string; text: string }
  }
  if (ref.agreement.id !== parent.id || ref.version.status !== "signed")
    return refusal(
      "PASSAGE_NOT_SIGNED_TEXT",
      `The passage must come from a signed version of ${parent.number}. Nothing was sent.`,
    )
  if (!parent.contact_id)
    return refusal(
      "NO_CLIENT_CONTACT",
      `${parent.number} names no client contact to approve the change request. Nothing was sent.`,
    )
  const r = await resolveSigners(ctx, [{ contact_id: parent.contact_id }])
  if (isError(r)) return r
  const client = r.signers[0] as { contact_id: string | null; email: string; name: string }
  const price = changeRequestPrice({
    id: "",
    number: "",
    kind: CHANGE_REQUEST,
    status: "draft",
    hours_minutes: p.hours_minutes,
    rate_minor: rate.toString(),
  })
  return {
    parent,
    passage: {
      version_number: ref.version.number,
      section: ref.passage.section,
      text: ref.passage.text,
    },
    price,
    rate,
    client,
  }
}

/** The send's key: the parent and the client's mail it answers. */
export function changeRequestGuardKey(
  p: Pick<ChangeRequestSendParams, "parent_agreement_id" | "mail_message_id">,
) {
  return `${p.parent_agreement_id}:${p.mail_message_id}`
}

function guardOf(ready: Ready, p: ChangeRequestSendParams): Record<string, unknown> {
  const at = new Date().toISOString()
  return {
    v: 1,
    applies: true,
    mode: "plain",
    since: at,
    stagedAt: at,
    addresses: [ready.client.email],
    contactIds: ready.client.contact_id ? [ready.client.contact_id] : [],
    conversationId: p.reply.conversation_id,
    refs: [],
    classification: "service",
  }
}

function cardLines(ready: Ready, p: ChangeRequestSendParams): string[] {
  const cur = ready.parent.currency ?? null
  return [
    `Reply to ${ready.client.name} <${ready.client.email}>:`,
    p.reply.body,
    `Change request on ${ready.parent.number} "${ready.parent.title}": ${p.title.trim()}`,
    ...p.work.map((w) => `Work: ${w}`),
    `Hours: ${hoursText(p.hours_minutes)} (from ${p.hours_source.trim()})`,
    `Rate: ${moneyText(ready.rate, cur)} per hour`,
    `Price: ${moneyText(ready.price, cur)}`,
    `Signed text, ${ready.parent.number} version ${ready.passage.version_number}, section ${ready.passage.section}: "${ready.passage.text}"`,
    `${ready.client.name} approves it on a link with an emailed code: a recorded approval, not a signature.`,
    "Nothing is started until it is approved.",
  ]
}

/** Checked before the card: the same refusals as the approved call; pins the mail check. */
export async function changeRequestSendPreflight(
  ctx: AgreementsCtx,
  p: ChangeRequestSendParams,
): Promise<
  | {
      ok: true
      pinnedParams: { sendGuard: Record<string, unknown>; guardKey: string; currency: string }
    }
  | { error: { code: string; message: string } }
> {
  const ready = await readyToSend(ctx, p)
  if (isError(ready)) return { error: ready.error }
  return {
    ok: true,
    pinnedParams: {
      sendGuard: guardOf(ready, p),
      guardKey: changeRequestGuardKey(p),
      currency: ready.parent.currency ?? "",
    },
  }
}

interface MintAnswer {
  status: string
  error?: { code: string; message: string }
  group_id?: string
  actions?: Array<{ id: string; status: string }>
}

function sourceOf(ready: Ready, p: ChangeRequestSendParams) {
  const cur = ready.parent.currency ?? null
  return {
    body: {
      blocks: [
        { type: "heading", text: `Change request to ${ready.parent.number}: ${p.title.trim()}` },
        {
          type: "paragraph",
          text: `This change request adds to ${ready.parent.number} "${ready.parent.title}":`,
        },
        ...p.work.map((w) => ({ type: "paragraph", text: `- ${w.trim()}` })),
        {
          type: "paragraph",
          text: `Size: ${hoursText(p.hours_minutes)} at ${moneyText(ready.rate, cur)} per hour, ${moneyText(ready.price, cur)} in total.`,
        },
        {
          type: "paragraph",
          text: `It rests on section ${ready.passage.section} of ${ready.parent.number} version ${ready.passage.version_number}: "${ready.passage.text}"`,
        },
        {
          type: "paragraph",
          text: `Everything else in ${ready.parent.number} is unchanged.`,
        },
      ],
    },
    data: {},
  }
}

/** `change_request_send`: an agent's call parks one card; the person's approval sends both. */
export async function changeRequestSend(ctx: AgreementsCtx, p: ChangeRequestSendParams) {
  const ready = await readyToSend(ctx, p)
  if (isError(ready)) return ready
  const agent = await actingAgentId(ctx)
  if (agent !== null && !ctx.approval) {
    if (!ctx.requestApproval)
      return refusal(
        "APPROVAL_REQUIRED",
        `A change request on ${ready.parent.number} needs a person's decision. Nothing was sent.`,
      )
    const a = await ctx.requestApproval({
      tool_name: "agreements:change_request_send",
      summary: `Reply and change request on ${ready.parent.number}`,
      summary_detail: { subtitle: "Reply and change request", lines: cardLines(ready, p) },
      current_payload: p,
      editable_fields: ["hours_minutes", "rate_minor"],
      noAutoApprove: true,
    })
    return {
      status: "pending_approval",
      approval_id: a.approval_id,
      message: `Nothing was sent yet: the reply and the change request on ${ready.parent.number} go to ${ready.client.name} only when a person approves card ${a.approval_id}.`,
    }
  }
  // An approved call is the one its card showed: the pinned check and key must still match.
  if (ctx.approval || p.sendGuard !== undefined || p.guardKey !== undefined) {
    const addresses = Array.isArray(p.sendGuard?.addresses)
      ? (p.sendGuard.addresses as unknown[])
      : []
    if (
      !p.sendGuard ||
      p.guardKey !== changeRequestGuardKey(p) ||
      !addresses.includes(ready.client.email)
    )
      return refusal(
        "SEND_GUARD_MISMATCH",
        `The change request on ${ready.parent.number} no longer matches the card that was approved. Nothing was sent. Next: draft it again for a new decision.`,
      )
  }
  if (!ctx.client_actions_mint || !ctx.client_actions_revoke || !ctx.executeTool)
    return refusal(
      "LINKS_NOT_AVAILABLE",
      "This server cannot send a change request (no links or no mail). Nothing was sent.",
    )

  // 1. The change request, a draft under its parent, frozen. It is seen by exactly who sees its
  //    parent: the parent's access and list, written through the one access writer.
  const user = await callerUserId(ctx)
  const parentAccess: OrgAccess =
    ready.parent.org_access === "none" || ready.parent.org_access === "viewer"
      ? ready.parent.org_access
      : "editor"
  const shares = (await currentShares(ctx, ready.parent.id)).map((s) => ({
    user_id: s.user_id,
    role: s.role,
  }))
  // The sender writes the change request: on its list as editor, as a creator is. They read
  // the parent, so on a restricted parent they are already on its list.
  const parentList =
    shares.length > 0 && user && !shares.some((s) => s.user_id === user)
      ? [...shares, { user_id: user, role: "editor" as const }]
      : shares.map((s) => (s.user_id === user ? { ...s, role: "editor" as const } : s))
  const access: DbBatchOp[] = []
  if (parentList.length > 0) {
    const acc = accessOps("", parentAccess, parentList, "new", user, new Date().toISOString())
    if (isError(acc)) return acc
    access.push(...acc)
  } else if (parentAccess === "none")
    return refusal(
      "ACCESS_LIST_EMPTY",
      `${ready.parent.number} is closed to the organization with nobody on its list. Nothing was sent.`,
    )
  const created = await ctx.db.batch({
    sequence: {
      key: `agreements:CR:${ready.parent.id}`,
      format: { prefix: "CR-", pad: 1 },
      unique: {
        entity: "agreements",
        field: "number",
        where: { parent_agreement_id: ready.parent.id },
      },
    },
    ops: [
      {
        insert: "agreements",
        as: "agreement",
        data: {
          number: { $seq: "formatted" },
          kind: CHANGE_REQUEST,
          status: "draft",
          title: p.title.trim(),
          parent_agreement_id: ready.parent.id,
          company_id: ready.parent.company_id ?? null,
          contact_id: ready.parent.contact_id ?? null,
          project_id: ready.parent.project_id ?? null,
          language: ready.parent.language ?? "en",
          fit_tag: "commercial",
          pricing_mode: "fixed",
          price_minor: ready.price.toString(),
          currency: ready.parent.currency ?? null,
          hours_minutes: p.hours_minutes,
          rate_minor: ready.rate.toString(),
          org_access: parentList.length > 0 ? "editor" : parentAccess,
          created_by_user_id: user,
          created_by_agent_id: null,
        },
      },
      {
        insert: "agreement_drafts",
        data: {
          agreement_id: { $ref: "agreement" },
          source: sourceOf(ready, p),
          upload_file_id: null,
          lock_version: 1,
          next_number: 1,
          updated_by_user_id: user,
          updated_by_agent_id: null,
        },
      },
      ...access,
    ],
  })
  const crId = String(created.rows.agreement?.id ?? "")
  const number = created.sequence?.formatted ?? "CR"
  const frozen = (await agreementPrepare(ctx, { id: crId })) as {
    status: string
    version_id?: string | null
    sha256?: string | null
    error?: { code: string; message: string }
  }
  if (frozen.status !== "ok" || !frozen.version_id || !frozen.sha256)
    return refusal(
      frozen.error?.code ?? "FREEZE_FAILED",
      `${number} on ${ready.parent.number} was written as a draft but could not be frozen (${frozen.error?.message ?? "no version"}). Nothing was sent to ${ready.client.name}.`,
    )

  // 2. The approval link, under the card's mail check: a client who wrote since stops it here.
  //    A restricted change request's link is seen by its list alone, like its parent's.
  const visibleTo = parentAccess === "none" ? parentList.map((s) => s.user_id).sort() : null
  if (visibleTo) await emitAccessChanged(ctx, crId, parentAccess, parentList)
  const out = bridgeAnswer<MintAnswer>(
    await ctx.client_actions_mint({
      send: {
        ...(visibleTo ? { visible_to: visibleTo } : {}),
        target_type: TARGET_TYPE,
        target_id: frozen.version_id,
        sha256: frozen.sha256,
        kind: "approve",
        expires_in_days: LINK_DAYS,
        order: "any",
        message: null,
        required_phrase: null,
        company_id: ready.parent.company_id ?? null,
        signers: [ready.client],
        ...(p.sendGuard ? { send_guard: p.sendGuard } : {}),
      },
    }),
  )
  if (out.status !== "ok")
    return refusal(
      out.error?.code ?? "SEND_FAILED",
      `Neither the reply nor ${number} was sent: ${(out.error?.message ?? "no link was made").replace(/\.+\s*$/, "")}. ${number} stays a draft.`,
    )

  // 3. The reply, from the person's mailbox, under the same check.
  const reply = await ctx.executeTool("mail:reply", {
    conversationId: p.reply.conversation_id,
    textBody: p.reply.body,
    ...(p.sendGuard ? { sendGuard: p.sendGuard } : {}),
  })
  if (reply?.status !== "completed") {
    await ctx.client_actions_revoke({
      target_type: TARGET_TYPE,
      target_id: frozen.version_id,
      reason: "withdrawn",
    })
    const why =
      reply?.status === "error"
        ? `${reply.error.code}: ${reply.error.message}`
        : reply?.status === "pending_approval"
          ? "it waits for another decision"
          : "the mail did not leave"
    return refusal(
      reply?.status === "error" ? reply.error.code : "REPLY_NOT_SENT",
      `The reply to ${ready.client.name} was not sent (${why}), so the approval link of ${number} was withdrawn. ${number} stays a draft; nothing reached the client.`,
    )
  }
  await ctx.db.update("agreements", crId, { status: "sent" })
  await ctx.emit?.({
    entity: "agreement",
    action: "sent",
    entityId: crId,
    data: { number, version: 1 },
  })
  return {
    status: "ok",
    change_request: {
      id: crId,
      number,
      parent: ready.parent.number,
      price_minor: ready.price.toString(),
      hours_minutes: p.hours_minutes,
      status: "sent",
    },
    message: `The reply went to ${ready.client.name}, and ${number} on ${ready.parent.number} (${moneyText(ready.price, ready.parent.currency)}) waits for their approval on a link with a code. Nothing is started until they approve it.`,
  }
}
