// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "No verified address = no weird business." For ~50 real-shaped orders whose customers have NO
// verified address, every shipment draft must be exactly what it was before the address book
// existed, with one documented exception: the order's own ship-to now beats a DIFFERENT address
// copied onto the contact (before, the copy won and the label went to the copy's site).
//
// The snapshot (`__fixtures__/address-golden.before.json`) was recorded from the draft builder as
// it was before the address book. Each entry holds the recipient address and a hash of the rest of
// the draft, built twice: the label path (reads the order) and the worklist path (orderShipTo
// false, never reads the order). Re-record only on purpose:
//   UPDATE_ADDRESS_GOLDEN=1 bun test src/address-golden.test.ts
// and only from a builder whose behaviour for these customers is meant to change. The test refuses
// a snapshot in which the documented cases already ship to the order's address, so recording it
// from the current builder fails.
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type GoldenCase, goldenCases } from "./__fixtures__/address-golden"
import { goldenCtx } from "./__fixtures__/address-harness"
import { shipmentDraftCreate, type RecipientAddressInput } from "./shipment"

const SNAPSHOT = join(import.meta.dir, "__fixtures__", "address-golden.before.json")

type Mode = "label" | "worklist"
interface Entry {
  recipient_address: RecipientAddressInput | null
  rest: string
}
type Snapshot = Record<string, Record<Mode, Entry>>

async function build(c: GoldenCase, mode: Mode) {
  const { ctx, calls, id } = goldenCtx(c)
  const draft = await shipmentDraftCreate(ctx, { document_ref: id, ...(mode === "worklist" ? { orderShipTo: false } : {}) })
  const { recipient_address, address_check, ...rest } = draft as typeof draft & { address_check?: unknown }
  const entry: Entry = {
    recipient_address,
    rest: createHash("sha256").update(JSON.stringify(rest)).digest("hex"),
  }
  return { entry, address_check, calls }
}

/** The documented change applies on the label path, and on the worklist path when prep_sync
 *  cached the order's ship-to (the worklist never reads the order itself). */
function expectsChange(c: GoldenCase, mode: Mode): boolean {
  return Boolean(c.orderBeatsContactCopy && (mode === "label" || c.cachedShipTo))
}

const MODES: Mode[] = ["label", "worklist"]

describe("address golden: customers with no verified address", () => {
  const cases = goldenCases()

  it("has a real-shaped fixture of about 50 orders", () => {
    expect(cases.length).toBeGreaterThanOrEqual(48)
    expect(cases.filter((c) => c.orderBeatsContactCopy).length).toBeGreaterThanOrEqual(3)
  })

  if (process.env.UPDATE_ADDRESS_GOLDEN === "1") {
    it("records the snapshot", async () => {
      const out: Snapshot = {}
      for (const c of cases) {
        out[c.id] = { label: (await build(c, "label")).entry, worklist: (await build(c, "worklist")).entry }
      }
      writeFileSync(SNAPSHOT, `${JSON.stringify(out, null, 1)}\n`)
    })
    return
  }

  it("changes no draft except the documented case, which now ships to the order's own address", async () => {
    expect(existsSync(SNAPSHOT)).toBe(true)
    const before = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot
    const unexpected: string[] = []
    const documented: string[] = []
    for (const c of cases) {
      for (const mode of MODES) {
        const { entry } = await build(c, mode)
        const was = before[c.id]?.[mode]
        expect(was).toBeDefined()
        // Nothing outside the recipient address ever changes.
        if (entry.rest !== was!.rest) unexpected.push(`${c.id}/${mode}: draft fields other than the address changed`)
        const same = JSON.stringify(entry.recipient_address) === JSON.stringify(was!.recipient_address)
        if (!expectsChange(c, mode)) {
          if (!same)
            unexpected.push(
              `${c.id}/${mode}: ${JSON.stringify(was!.recipient_address)} -> ${JSON.stringify(entry.recipient_address)}`,
            )
          continue
        }
        // The documented case: the snapshot shipped to the contact copy, the draft now ships to
        // the order's own address, every location field from it.
        const o = c.order!.shippingAddress!
        const street = [o.address1, o.address2].filter(Boolean).join(", ")
        expect(was!.recipient_address?.street).not.toBe(street)
        expect(entry.recipient_address).toMatchObject({
          street,
          city: o.city,
          postalCode: o.zip,
          countryIsoCode: o.countryCode,
        })
        // Never the copy's phone on the order's address.
        if (o.phone == null) expect(entry.recipient_address?.phone ?? null).toBeNull()
        else expect(entry.recipient_address?.phone).toBe(o.phone)
        documented.push(`${c.id}/${mode}`)
      }
    }
    expect(unexpected).toEqual([])
    expect(documented.length).toBe(cases.filter((c) => c.orderBeatsContactCopy).length + cases.filter((c) => c.orderBeatsContactCopy && c.cachedShipTo).length)
  })

  it("flags nothing for them: every draft says no verified address", async () => {
    for (const c of cases) {
      for (const mode of MODES) {
        const { address_check } = await build(c, mode)
        expect(address_check).toMatchObject({ state: "no_verified", verified_address: null })
      }
    }
  })
})
