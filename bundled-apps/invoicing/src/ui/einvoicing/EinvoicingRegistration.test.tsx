// SPDX-License-Identifier: FSL-1.1-ALv2
// Settings › E-invoicing: the platform's registration is described in plain words under the
// fields (which save through the gated settings tool, see the manifest test).
import { describe, expect, it } from "bun:test"
import { type EinvoicingSettingsData, registrationLines } from "./EinvoicingRegistration"

const data: EinvoicingSettingsData = {
  status: "ok",
  settings: {
    provider_app: "pennylane",
    cutover_date: "2026-11-01",
    send_enabled: false,
    book_enabled: false,
  },
  providers: ["pennylane"],
  registration: { emission_activated: false, webhook: { configured: false } },
}

describe("EinvoicingRegistration", () => {
  it("describes the platform's registration in plain words", () => {
    expect(registrationLines(data).join(" ")).toContain("not activated")
    expect(registrationLines(data).join(" ")).toContain("every three hours")
    expect(
      registrationLines({
        ...data,
        registration: { emission_activated: true, webhook: { configured: true } },
      }).join(" "),
    ).toContain("by webhook")
    expect(
      registrationLines({ ...data, settings: { ...data.settings, provider_app: null } })[0],
    ).toContain("No e-invoicing platform")
  })

  it("says why when the platform cannot be reached", () => {
    expect(
      registrationLines({
        ...data,
        registration: { status: "error", error: { message: "timeout" } },
      })[0],
    ).toContain("timeout")
  })
})
