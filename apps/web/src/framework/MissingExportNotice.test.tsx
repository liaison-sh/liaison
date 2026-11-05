// SPDX-License-Identifier: FSL-1.1-ALv2
// The missing-export card (P2-20): an apps admin sees what is wrong, anyone
// else sees nothing at all.
import { render } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ scopes: [] as string[] }))

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return { ...actual, canAccessScope: (s?: string | null) => !s || state.scopes.includes(s) }
})

import { MissingExportNotice } from "./MissingExportNotice"

describe("MissingExportNotice", () => {
  it("shows an apps admin the card naming the export", () => {
    state.scopes = ["kernel:apps:admin"]
    const r = render(() => <MissingExportNotice name="AcmePanel" />)
    expect(r.getByTestId("settings-custom-missing-AcmePanel").textContent).toContain("AcmePanel")
  })

  it("renders nothing for a member without kernel:apps:admin", () => {
    state.scopes = ["acme:records:read"]
    const r = render(() => <MissingExportNotice name="AcmePanel" />)
    expect(r.queryByTestId("settings-custom-missing-AcmePanel")).toBeNull()
    expect(r.container.textContent).toBe("")
  })
})
