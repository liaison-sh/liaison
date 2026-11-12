// SPDX-License-Identifier: FSL-1.1-ALv2
// `einvoicing_settings_set` (gated by the kernel): the org's e-invoicing settings, kept in the
// single `einvoicing_settings` row: gate mode, the switch date of the dated legal mentions, and
// the transmission settings: which installed app is the e-invoicing platform (the PA provider
// binding the kernel reads for `einvoicing-pa@1`), the cut-over date, and the send / booking
// switches. A provider change is checked against the kernel (it must resolve to an installed app
// implementing the contract), and every change of provider raises an attention item.

import { resolveGateMode } from "./gate"

type Row = Record<string, unknown>

export interface SettingsToolCtx {
  db: {
    findMany(
      entity: string,
      opts?: { where?: Record<string, unknown>; limit?: number },
    ): Promise<unknown[]>
    insert(entity: string, data: Record<string, unknown>): Promise<unknown>
    update(entity: string, id: string, data: Record<string, unknown>): Promise<unknown>
  }
  getUserId?(): Promise<string>
  contracts?: {
    providers(contract: string): Promise<unknown>
    /** Kernel binding write: accepted only from an organisation administrator acting in person. */
    setBinding?(contract: string, provider: string | null): Promise<unknown>
  }
  emit?(event: { entity: string; action: string; entityId?: string; data?: unknown }): Promise<void>
}

function fail(code: string, message: string) {
  return { status: "error" as const, error: { code, message } }
}

function validDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

const APP_NAME_RE = /^[a-z][a-z0-9-]{0,62}$/

/** A date field of the patch: absent keeps the stored value (`undefined`), an explicit `null` or
 *  an empty string clears it (`null`), any other string is the new value (validated by the caller). */
function clearableField(
  input: Record<string, unknown> | undefined,
  key: string,
): string | null | undefined {
  if (!input || !Object.hasOwn(input, key) || input[key] === undefined) return undefined
  const v = input[key]
  if (v === null) return null
  if (typeof v !== "string") return undefined
  const t = v.trim()
  return t === "" ? null : t
}

export async function einvoicingSettingsSet(
  ctx: SettingsToolCtx,
  input: {
    gate_mode?: string | null
    cibs_switch_date?: string | null
    provider_app?: string | null
    cutover_date?: string | null
    send_enabled?: boolean | null
    book_enabled?: boolean | null
  },
): Promise<Row> {
  const mode = input?.gate_mode ?? null
  if (mode !== null && mode !== "warn" && mode !== "enforce")
    return fail("invalid_input", "gate_mode must be warn or enforce")
  const date = clearableField(input, "cibs_switch_date")
  if (typeof date === "string" && !validDate(date))
    return fail("invalid_input", "cibs_switch_date must be a date YYYY-MM-DD")
  // Absent keeps the binding; null or empty unbinds it.
  const provider = clearableField(input, "provider_app")
  if (typeof provider === "string" && !APP_NAME_RE.test(provider))
    return fail("invalid_input", "provider_app must be an installed app's name")
  const cutover = clearableField(input, "cutover_date")
  if (typeof cutover === "string" && !validDate(cutover))
    return fail("invalid_input", "cutover_date must be a date YYYY-MM-DD")
  const send = typeof input?.send_enabled === "boolean" ? input.send_enabled : null
  const book = typeof input?.book_enabled === "boolean" ? input.book_enabled : null
  if (
    mode === null &&
    date === undefined &&
    provider === undefined &&
    cutover === undefined &&
    send === null &&
    book === null
  ) {
    return fail("invalid_input", "pass at least one setting")
  }

  // The binding must name an app registered here that implements the contract (the kernel
  // refuses anything else at dispatch; checked before writing so a typo never lands).
  if (typeof provider === "string") {
    if (!ctx.contracts)
      return fail("provider_not_available", "Provider contracts are not available in this context.")
    const raw = await ctx.contracts.providers("einvoicing-pa@1")
    const providers = (typeof raw === "string" ? JSON.parse(raw) : raw) as string[]
    if (!Array.isArray(providers) || !providers.includes(provider)) {
      return fail(
        "provider_not_available",
        `${provider} is not an installed app implementing e-invoicing (einvoicing-pa@1). Installed providers: ${Array.isArray(providers) && providers.length ? providers.join(", ") : "none"}.`,
      )
    }
  }

  const changedBy = ctx.getUserId ? await ctx.getUserId() : null
  const rows = (await ctx.db.findMany("einvoicing_settings", { limit: 1 })) as Row[]
  const existing = rows[0]

  // The binding the kernel dispatches by lives in the kernel, where this app cannot write it on
  // its own: the kernel accepts the change only from an organisation administrator acting in
  // person. This row only mirrors it (the kernel refuses to dispatch while the two disagree), so
  // it is written only once the kernel took the change.
  const previous = (existing?.provider_app as string | null | undefined) ?? null
  if (provider !== undefined && provider !== previous) {
    if (!ctx.contracts?.setBinding)
      return fail("provider_not_available", "Provider contracts are not available in this context.")
    const raw = await ctx.contracts.setBinding("einvoicing-pa@1", provider)
    let out: unknown = raw
    if (typeof raw === "string") {
      try {
        out = JSON.parse(raw)
      } catch {
        out = null
      }
    }
    const o = (out ?? {}) as { status?: string; error?: { code?: string; message?: string } }
    if (o.status !== "ok") {
      return fail(
        o.error?.code ?? "contract_binding_forbidden",
        o.error?.message ?? "The platform binding was not changed.",
      )
    }
  }
  const patch: Row = {
    ...(mode ? { gate_mode: mode, gate_mode_source: "tool" } : {}),
    ...(date !== undefined ? { cibs_switch_date: date } : {}),
    ...(provider !== undefined ? { provider_app: provider } : {}),
    ...(cutover !== undefined ? { cutover_date: cutover } : {}),
    ...(send !== null ? { send_enabled: send } : {}),
    ...(book !== null ? { book_enabled: book } : {}),
    changed_by: changedBy,
  }
  let row: Row
  if (existing) {
    await ctx.db.update("einvoicing_settings", String(existing.id), patch)
    row = { ...existing, ...patch }
  } else if (mode) {
    const inserted = (await ctx.db.insert("einvoicing_settings", patch)) as Row
    row = { ...patch, ...(inserted ?? {}) }
  } else {
    // A first write that names no gate mode (the settings page edits the transmission
    // fields only) keeps the org's default mode, written as the default, then applies the change.
    await resolveGateMode(ctx.db, { materialise: true })
    const created = ((await ctx.db.findMany("einvoicing_settings", { limit: 1 })) as Row[])[0]
    if (!created) return fail("invalid_input", "the e-invoicing settings could not be created")
    await ctx.db.update("einvoicing_settings", String(created.id), patch)
    row = { ...created, ...patch }
  }

  if (provider !== undefined && provider !== previous && ctx.emit) {
    await ctx.emit({
      entity: "einvoicing",
      action: "binding_changed",
      entityId: String(row.id),
      data: {
        from: previous ?? "none",
        to: provider ?? "none",
        by: changedBy ?? "unknown",
        source: "tool",
      },
    })
  }
  return { status: "ok", settings: row }
}
