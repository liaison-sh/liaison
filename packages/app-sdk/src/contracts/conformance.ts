// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Conformance kit for `einvoicing-pa@1`: the same cases for every provider, run against the
// provider's own HTTP fake (and, opt-in, its sandbox). Framework-agnostic: each case throws on
// failure; a provider's test file wraps them (`for (const c of cases) it(c.name, () => c.run(h))`).
// The harness supplies how to call an op, fresh inputs, and a view of the provider side (how many
// creates reached it, how to move a deposit along its lifecycle).

import { AFNOR_REASON_CODES, type LifecycleState } from "./einvoicing-pa"

type Result = Record<string, unknown> & { status?: string; error?: { code?: string } }

export interface EinvoicingPaHarness {
  call(op: string, params: Record<string, unknown>): Promise<Result>
  inputs: {
    /** A fresh eligible domestic B2B e-invoice (new number each call). */
    eligible(): Record<string, unknown>
    /** Same shape, but the CII says B2C. */
    b2c(): Record<string, unknown>
    /** Eligible, but the file is not the claimed legal original (fingerprint differs). */
    wrongFile(): Record<string, unknown>
    /** A fresh reportable sale to book. */
    booking(): Record<string, unknown>
    /** A booking with a line whose tax treatment has no provider rate. */
    unmappableBooking(): Record<string, unknown>
  }
  provider: {
    creates(kind: "einvoice_import" | "send_to_pa" | "booking"): number
    setEmission(on: boolean): void
    /** Move a transmitted deposit to `state` on the provider side and record a change for it. */
    setLifecycle(providerRef: string, state: LifecycleState, reason?: string): Promise<void>
  }
}

export interface ConformanceCase {
  name: string
  run(h: EinvoicingPaHarness): Promise<void>
}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`conformance: ${message}`)
}

function errCode(r: Result): string | undefined {
  return r.status === "error" ? r.error?.code : undefined
}

async function submitEligible(h: EinvoicingPaHarness) {
  const input = h.inputs.eligible()
  const r = await h.call("submit_einvoice", input)
  check(!errCode(r), `submit_einvoice failed: ${JSON.stringify(r)}`)
  check(
    typeof r.provider_ref === "string" && r.provider_ref !== "",
    "submit_einvoice returns a provider_ref",
  )
  return { input, ref: r.provider_ref as string, r }
}

async function advanceUntil(
  h: EinvoicingPaHarness,
  input: Record<string, unknown>,
  ref: string,
  want: string[],
) {
  let last: Result = {}
  for (let i = 0; i < 5; i++) {
    last = await h.call("advance_einvoice", {
      provider_ref: ref,
      invoice_number: input.invoice_number,
      issue_date: input.issue_date,
    })
    check(!errCode(last), `advance_einvoice failed: ${JSON.stringify(last)}`)
    if (want.includes(String(last.state))) return last
  }
  throw new Error(
    `conformance: advance_einvoice never reached ${want.join("/")} (last ${JSON.stringify(last)})`,
  )
}

export const einvoicingPaConformance: ConformanceCase[] = [
  {
    name: "registration_status reports emission and registrations",
    async run(h) {
      const r = await h.call("registration_status", {})
      check(typeof r.emission_activated === "boolean", "emission_activated is a boolean")
      check(Array.isArray(r.registrations), "registrations is a list")
    },
  },
  {
    name: "submit_einvoice deposits once; a replay adopts the same deposit; find_einvoice sees it",
    async run(h) {
      const before = h.provider.creates("einvoice_import")
      const { input, ref, r } = await submitEligible(h)
      check(
        ["imported", "validation_pending"].includes(String(r.state)),
        `deposit state ${r.state}`,
      )
      const again = await h.call("submit_einvoice", input)
      check(again.provider_ref === ref, "a replayed submit adopts the existing deposit")
      check(
        h.provider.creates("einvoice_import") === before + 1,
        "exactly one import reached the provider",
      )
      const found = await h.call("find_einvoice", {
        invoice_number: input.invoice_number,
        issue_date: input.issue_date,
      })
      check(found.found === true && found.provider_ref === ref, "find_einvoice finds the deposit")
      const none = await h.call("find_einvoice", {
        invoice_number: `${input.invoice_number}-NONE`,
        issue_date: input.issue_date,
      })
      check(none.found === false, "find_einvoice says not found for an unknown number")
    },
  },
  {
    name: "a B2C document is refused before anything reaches the provider",
    async run(h) {
      const before = h.provider.creates("einvoice_import")
      const r = await h.call("submit_einvoice", h.inputs.b2c())
      check(
        errCode(r) === "einvoice_not_eligible",
        `expected einvoice_not_eligible, got ${JSON.stringify(r)}`,
      )
      check(h.provider.creates("einvoice_import") === before, "zero imports")
    },
  },
  {
    name: "a file that is not the claimed legal original is refused before upload",
    async run(h) {
      const before = h.provider.creates("einvoice_import")
      const r = await h.call("submit_einvoice", h.inputs.wrongFile())
      check(
        errCode(r) === "legal_original_mismatch",
        `expected legal_original_mismatch, got ${JSON.stringify(r)}`,
      )
      check(h.provider.creates("einvoice_import") === before, "zero imports")
    },
  },
  {
    name: "emission not activated: refused with no provider write",
    async run(h) {
      h.provider.setEmission(false)
      try {
        const before = h.provider.creates("einvoice_import")
        const r = await h.call("submit_einvoice", h.inputs.eligible())
        check(
          errCode(r) === "pa_emission_not_activated",
          `expected pa_emission_not_activated, got ${JSON.stringify(r)}`,
        )
        check(h.provider.creates("einvoice_import") === before, "zero imports")
      } finally {
        h.provider.setEmission(true)
      }
    },
  },
  {
    name: "advance_einvoice requests the transmission once and then reports it sent",
    async run(h) {
      const { input, ref } = await submitEligible(h)
      const before = h.provider.creates("send_to_pa")
      await advanceUntil(h, input, ref, ["send_requested", "sent"])
      const again = await advanceUntil(h, input, ref, ["sent"])
      check(again.state === "sent", "a transmitted deposit is reported sent")
      check(h.provider.creates("send_to_pa") === before + 1, "exactly one transmission request")
    },
  },
  {
    name: "get_einvoice_status maps the provider's words onto lifecycle states with codes and reason",
    async run(h) {
      const { input, ref } = await submitEligible(h)
      await advanceUntil(h, input, ref, ["send_requested", "sent"])
      await h.provider.setLifecycle(ref, "accepted")
      const a = await h.call("get_einvoice_status", { provider_ref: ref })
      check(a.mapped === "accepted" && a.code === 204, `accepted → 204, got ${JSON.stringify(a)}`)
      check(typeof a.raw === "string", "the raw provider value is returned")
      await h.provider.setLifecycle(ref, "refused", "Montant erroné")
      const r = await h.call("get_einvoice_status", { provider_ref: ref })
      check(r.mapped === "refused" && r.code === 210, `refused → 210, got ${JSON.stringify(r)}`)
      check(r.reason_text === "Montant erroné", "the provider's reason text is returned")
    },
  },
  {
    name: "list_status_changes delivers each changed ref until the caller acknowledges that item",
    async run(h) {
      const { input, ref } = await submitEligible(h)
      await advanceUntil(h, input, ref, ["send_requested", "sent"])
      await h.provider.setLifecycle(ref, "approved")
      type Item = { provider_ref: string; ack?: string }
      const first = await h.call("list_status_changes", { cursor: null })
      const items = first.items as Item[]
      check(
        items.some((i) => i.provider_ref === ref),
        "the changed ref is listed",
      )
      check(
        items.every((i) => typeof i.ack === "string" && i.ack !== ""),
        "every item carries its ack",
      )
      const again = await h.call("list_status_changes", { cursor: null })
      check(
        (again.items as Item[]).some((i) => i.provider_ref === ref),
        "unacknowledged refs are delivered again",
      )
      // Acknowledging nothing (the caller handled none) leaves it pending.
      const none = await h.call("list_status_changes", { cursor: "" })
      check(
        (none.items as Item[]).some((i) => i.provider_ref === ref),
        "an item not acknowledged stays pending",
      )
      const mine = (again.items as Item[]).find((i) => i.provider_ref === ref)!
      const acked = await h.call("list_status_changes", { cursor: mine.ack as string })
      check(
        !(acked.items as Item[]).some((i) => i.provider_ref === ref),
        "an acknowledged ref is not delivered again",
      )
    },
  },
  {
    name: "book_sale books once (a replay adopts it), never as an e-invoice; find_booking sees it",
    async run(h) {
      const before = h.provider.creates("booking")
      const input = h.inputs.booking()
      const r = await h.call("book_sale", input)
      check(!errCode(r) && r.state === "booked", `book_sale failed: ${JSON.stringify(r)}`)
      const again = await h.call("book_sale", input)
      check(again.provider_ref === r.provider_ref, "a replayed booking adopts the first")
      check(
        h.provider.creates("booking") === before + 1,
        "exactly one booking reached the provider",
      )
      const found = await h.call("find_booking", { idempotency_key: input.idempotency_key })
      check(found.found === true && found.provider_ref === r.provider_ref, "find_booking finds it")
      check(found.e_invoicing === false, "a booking carries no e-invoicing status")
    },
  },
  {
    name: "a booking line with no provider VAT rate is refused before anything is booked",
    async run(h) {
      const before = h.provider.creates("booking")
      const r = await h.call("book_sale", h.inputs.unmappableBooking())
      check(
        errCode(r) === "vat_rate_unmappable",
        `expected vat_rate_unmappable, got ${JSON.stringify(r)}`,
      )
      check(h.provider.creates("booking") === before, "zero bookings")
    },
  },
]

// ---------------------------------------------------------------------------------------------
// Reception (optional ops): run by providers implementing list_received / get_received /
// fetch_received_file / set_received_status.

export interface ReceptionHarness {
  call(op: string, params: Record<string, unknown>): Promise<Result>
  provider: {
    /** A supplier e-invoice arrives at the provider; answers its provider_ref. */
    receive(opts?: { paid?: boolean }): Promise<string>
    /** The bytes the provider holds as that invoice's original, by sha256. */
    originalSha256(providerRef: string): string
    /** Status-setting requests that reached the provider so far. */
    statusWrites(): number
  }
  /** A caller-side parent the provider may store a fetched file onto. */
  target(): { app: string; entity_type: string; entity_id: string }
}

export interface ReceptionCase {
  name: string
  run(h: ReceptionHarness): Promise<void>
}

const ACTION_STATUS: Record<string, string> = {
  refuse: "refused",
  dispute: "in_dispute",
  undispute: "approved",
}

async function listAll(
  h: ReceptionHarness,
  cursor: string | null,
): Promise<{ refs: string[]; cursor: string | null }> {
  const refs: string[] = []
  for (let i = 0; i < 10; i++) {
    const r = await h.call("list_received", { cursor })
    check(!errCode(r), `list_received failed: ${JSON.stringify(r)}`)
    for (const it of (r.items ?? []) as Array<{ provider_ref: string }>)
      refs.push(String(it.provider_ref))
    cursor = (r.cursor as string | null) ?? cursor
    if (r.has_more !== true) break
  }
  return { refs, cursor }
}

export const einvoicingPaReceptionConformance: ReceptionCase[] = [
  {
    name: "list_received lists a newly received invoice once; the cursor moves past it",
    async run(h) {
      const start = await listAll(h, null)
      const ref = await h.provider.receive()
      const next = await listAll(h, start.cursor)
      check(next.refs.includes(ref), "the new invoice is listed after the previous cursor")
      const again = await listAll(h, next.cursor)
      check(!again.refs.includes(ref), "it is not listed again after the new cursor")
    },
  },
  {
    name: "get_received normalises the invoice: supplier, number, dates, totals, received status, files, actions with mapped reasons",
    async run(h) {
      const ref = await h.provider.receive()
      const r = await h.call("get_received", { provider_ref: ref })
      check(!errCode(r), `get_received failed: ${JSON.stringify(r)}`)
      check(r.provider_ref === ref, "provider_ref echoed")
      const supplier = r.supplier as { name?: unknown }
      check(typeof supplier?.name === "string" && supplier.name !== "", "supplier name")
      check(typeof r.invoice_number === "string", "invoice number")
      check(typeof r.issue_date === "string", "issue date")
      const totals = r.totals as { total?: unknown }
      check(typeof totals?.total === "string", "totals as decimal strings")
      const status = r.status as { mapped?: unknown; code?: unknown }
      check(
        status?.mapped === "received" && status.code === null,
        `a new invoice is received, got ${JSON.stringify(status)}`,
      )
      const files = r.files as Array<{ file: string }>
      check(
        files.some((f) => f.file === "original"),
        "the original file is offered",
      )
      const actions = r.actions as Array<{
        action: string
        reasons: Array<{ reason: string; afnor_code: string; label_en: string; label_fr: string }>
      }>
      for (const want of ["refuse", "dispute"]) {
        const a = actions.find((x) => x.action === want)
        check(a && a.reasons.length > 0, `${want} is offered with reasons`)
        for (const reason of a!.reasons) {
          check(
            (AFNOR_REASON_CODES as readonly string[]).includes(reason.afnor_code),
            `${reason.reason} maps to a known code`,
          )
          check(
            reason.label_en !== "" && reason.label_fr !== "",
            `${reason.reason} has plain-word labels`,
          )
        }
      }
      check(
        !actions.some((x) => x.action === "undispute"),
        "nothing to withdraw on an undisputed invoice",
      )
    },
  },
  {
    name: "a paid invoice offers neither refuse nor dispute",
    async run(h) {
      const ref = await h.provider.receive({ paid: true })
      const r = await h.call("get_received", { provider_ref: ref })
      check(r.payment_linked === true, "payment_linked")
      check(
        ((r.actions ?? []) as unknown[]).length === 0,
        `no action offered, got ${JSON.stringify(r.actions)}`,
      )
    },
  },
  {
    name: "fetch_received_file stores the original's exact bytes onto the caller's parent",
    async run(h) {
      const ref = await h.provider.receive()
      const r = await h.call("fetch_received_file", {
        provider_ref: ref,
        file: "original",
        target: h.target(),
      })
      check(!errCode(r), `fetch_received_file failed: ${JSON.stringify(r)}`)
      check(typeof r.file_id === "string" && r.file_id !== "", "file_id")
      check(
        r.sha256 === h.provider.originalSha256(ref),
        "sha256 of the stored bytes equals the provider's original",
      )
    },
  },
  {
    name: "set_received_status refuses with an offered reason, then nothing more is offered; an unoffered reason is refused before any provider write",
    async run(h) {
      const ref = await h.provider.receive()
      const before = h.provider.statusWrites()
      const bad = await h.call("set_received_status", {
        provider_ref: ref,
        status: "refused",
        reason: "not-a-reason",
      })
      check(
        errCode(bad) === "received_reason_invalid",
        `expected received_reason_invalid, got ${JSON.stringify(bad)}`,
      )
      check(h.provider.statusWrites() === before, "zero writes for an unoffered reason")
      const got = await h.call("get_received", { provider_ref: ref })
      const offer = (
        got.actions as Array<{ action: string; reasons: Array<{ reason: string }> }>
      ).find((a) => a.action === "refuse")!
      const r = await h.call("set_received_status", {
        provider_ref: ref,
        status: ACTION_STATUS.refuse,
        reason: offer.reasons[0]!.reason,
        comment: "Wrong rate",
      })
      check(!errCode(r), `refuse failed: ${JSON.stringify(r)}`)
      const status = r.status as { mapped?: unknown; code?: unknown }
      check(
        status?.mapped === "refused" && status.code === 210,
        `refused (210), got ${JSON.stringify(status)}`,
      )
      check(((r.actions ?? []) as unknown[]).length === 0, "nothing offered on a refused invoice")
      check(h.provider.statusWrites() === before + 1, "exactly one write")
      const again = await h.call("set_received_status", {
        provider_ref: ref,
        status: "in_dispute",
        reason: offer.reasons[0]!.reason,
      })
      check(
        errCode(again) === "received_action_not_allowed",
        `expected received_action_not_allowed, got ${JSON.stringify(again)}`,
      )
      check(h.provider.statusWrites() === before + 1, "no write for an action no longer offered")
    },
  },
  {
    name: "a dispute can be withdrawn",
    async run(h) {
      const ref = await h.provider.receive()
      const got = await h.call("get_received", { provider_ref: ref })
      const offer = (
        got.actions as Array<{ action: string; reasons: Array<{ reason: string }> }>
      ).find((a) => a.action === "dispute")!
      const d = await h.call("set_received_status", {
        provider_ref: ref,
        status: "in_dispute",
        reason: offer.reasons[0]!.reason,
      })
      check(
        (d.status as { mapped?: unknown })?.mapped === "in_dispute",
        `in_dispute, got ${JSON.stringify(d.status)}`,
      )
      check(
        (d.actions as Array<{ action: string }>).some((a) => a.action === "undispute"),
        "undispute offered on a disputed invoice",
      )
      const u = await h.call("set_received_status", {
        provider_ref: ref,
        status: "approved",
        reason: null,
      })
      check(
        (u.status as { mapped?: unknown })?.mapped === "approved",
        `approved, got ${JSON.stringify(u.status)}`,
      )
    },
  },
]
