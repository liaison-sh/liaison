// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Agreement templates: a meta row (kind, fit, language, current version) and one immutable row
// per saved version. Saving raises the version; an agreement copies the text of the version it
// was made from, so a later save never moves it. Conditions on an agreement template take one
// field's equality only (`equals`); the other condition forms of rich text are refused here.

import { type AgreementsCtx, actingAgentId, callerUserId, type ErrorEnvelope, refusal } from "./ctx"

interface MetaRow {
  id: string
  template_id: string
  name: string
  kind: string
  fit_tag: string
  language: string
  version: number
  archived?: boolean
  corporate?: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The first condition form other than `equals` in a body, or null. */
export function unsupportedCondition(body: unknown): string | null {
  let found: string | null = null
  const visit = (cond: unknown) => {
    for (const c of Array.isArray(cond) ? cond : [cond]) {
      if (!c || typeof c !== "object") continue
      for (const k of ["is", "in", "atLeast", "atMost"])
        if (k in (c as Record<string, unknown>) && found === null) found = k
      if (!("equals" in (c as Record<string, unknown>)) && found === null) found = "present"
    }
  }
  const walk = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue
      const block = b as Record<string, unknown>
      if (block.when !== undefined) visit(block.when)
      if (block.where !== undefined) visit(block.where)
      if (Array.isArray(block.blocks)) walk(block.blocks)
    }
  }
  walk((body as { blocks?: unknown } | null)?.blocks)
  return found
}

export async function templatesList(
  ctx: AgreementsCtx,
  p: { kind?: string; include_archived?: boolean },
) {
  const rows = (await ctx.db.findMany("agreement_template_meta", {
    where: p.kind ? { kind: p.kind } : {},
    limit: 500,
  })) as MetaRow[]
  const items = rows
    .filter((r) => p.include_archived || !r.archived)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => ({
      template_id: r.template_id,
      name: r.name,
      kind: r.kind,
      fit_tag: r.fit_tag,
      language: r.language,
      version: r.version,
      archived: !!r.archived,
    }))
  return {
    status: "ok",
    items,
    message: items.length
      ? `${items.length} template(s). Read one with template_get.`
      : "No agreement template yet. Save one with template_save.",
  }
}

async function metaOf(ctx: AgreementsCtx, templateId: string): Promise<MetaRow | null> {
  const rows = (await ctx.db.findMany("agreement_template_meta", {
    where: { template_id: templateId },
    limit: 1,
  })) as MetaRow[]
  return rows[0] ?? null
}

export async function templateGet(
  ctx: AgreementsCtx,
  p: { template_id: string; version?: number },
) {
  const meta = UUID.test(p.template_id ?? "") ? await metaOf(ctx, p.template_id) : null
  if (!meta)
    return refusal(
      "TEMPLATE_NOT_FOUND",
      `No template ${p.template_id}. List them with templates_list.`,
    )
  const version = p.version ?? meta.version
  const rows = (await ctx.db.findMany("agreement_template_versions", {
    where: { template_id: meta.template_id, version },
    limit: 1,
  })) as Array<{ body: unknown; saved_at: string }>
  if (!rows[0])
    return refusal(
      "TEMPLATE_NOT_FOUND",
      `Template "${meta.name}" has no version ${version}; its current version is ${meta.version}.`,
    )
  return {
    status: "ok",
    template: {
      template_id: meta.template_id,
      name: meta.name,
      kind: meta.kind,
      fit_tag: meta.fit_tag,
      language: meta.language,
      version,
      current_version: meta.version,
      body: rows[0].body,
    },
    message: `Template "${meta.name}" version ${version} of ${meta.version}.`,
  }
}

export interface SaveParams {
  template_id?: string
  name?: string
  kind?: string
  language?: "en" | "fr"
  fit_tag?: string
  body: unknown
}

export async function templateSave(
  ctx: AgreementsCtx,
  p: SaveParams,
): Promise<Record<string, unknown> | ErrorEnvelope> {
  if (
    !p.body ||
    typeof p.body !== "object" ||
    !Array.isArray((p.body as { blocks?: unknown }).blocks)
  )
    return refusal(
      "TEMPLATE_INVALID",
      "A template body is an object with a list of blocks. Nothing was saved.",
    )
  const cond = unsupportedCondition(p.body)
  if (cond)
    return refusal(
      "TEMPLATE_INVALID",
      `An agreement template shows or hides a block on one field's equality only (equals); "${cond}" is not taken. Nothing was saved.`,
    )
  const agent = await actingAgentId(ctx)
  if (agent !== null && !ctx.approval) {
    if (!ctx.requestApproval)
      return refusal(
        "APPROVAL_REQUIRED",
        "Saving a template needs a person's decision. Nothing was saved.",
      )
    const approval = await ctx.requestApproval({
      tool_name: "agreements:template_save",
      summary: `Save agreement template ${p.name ?? p.template_id ?? ""}`.trim(),
      summary_detail: {
        subtitle: "A new template version",
        lines: [
          `Template: ${p.name ?? p.template_id ?? "(new)"}`,
          `Blocks: ${(p.body as { blocks: unknown[] }).blocks.length}`,
        ],
      },
      current_payload: p,
      editable_fields: [],
    })
    if (!approval.auto_approved)
      return {
        status: "pending_approval",
        approval_id: approval.approval_id,
        message: `Nothing was saved yet: the template is saved when a person approves card ${approval.approval_id}.`,
      }
  }
  const user = await callerUserId(ctx)
  const now = new Date().toISOString()
  if (p.template_id) {
    const meta = UUID.test(p.template_id) ? await metaOf(ctx, p.template_id) : null
    if (!meta)
      return refusal("TEMPLATE_NOT_FOUND", `No template ${p.template_id}. Nothing was saved.`)
    const next = meta.version + 1
    await ctx.db.batch({
      ops: [
        {
          insert: "agreement_template_versions",
          data: {
            template_id: meta.template_id,
            version: next,
            body: p.body,
            saved_by_user_id: user,
            saved_at: now,
          },
        },
        {
          updateMany: "agreement_template_meta",
          where: { id: meta.id, version: meta.version },
          data: {
            version: next,
            ...(p.name ? { name: p.name } : {}),
            ...(p.fit_tag ? { fit_tag: p.fit_tag } : {}),
          },
          expect: { minRows: 1, maxRows: 1 },
        },
      ],
    })
    return {
      status: "ok",
      template_id: meta.template_id,
      version: next,
      message: `Template "${p.name ?? meta.name}" is now version ${next}; agreements made from version ${meta.version} keep their text.`,
    }
  }
  if (!p.name || !p.kind)
    return refusal("TEMPLATE_INVALID", "A new template needs a name and a kind. Nothing was saved.")
  // The template's id is its meta row's own id, set in the same commit (a replayed run makes
  // the same calls: no id is drawn in the app).
  const result = await ctx.db.batch({
    ops: [
      {
        insert: "agreement_template_meta",
        as: "meta",
        data: {
          name: p.name,
          kind: p.kind,
          fit_tag: p.fit_tag ?? "commercial",
          language: p.language ?? "en",
          version: 1,
          archived: false,
        },
      },
      {
        update: "agreement_template_meta",
        id: { $ref: "meta" },
        data: { template_id: { $ref: "meta" } },
      },
      {
        insert: "agreement_template_versions",
        data: {
          template_id: { $ref: "meta" },
          version: 1,
          body: p.body,
          saved_by_user_id: user,
          saved_at: now,
        },
      },
    ],
  })
  const templateId = String(result.rows.meta?.id ?? "")
  return {
    status: "ok",
    template_id: templateId,
    version: 1,
    message: `Template "${p.name}" was saved as version 1. Use it with agreement_create and template_id.`,
  }
}
