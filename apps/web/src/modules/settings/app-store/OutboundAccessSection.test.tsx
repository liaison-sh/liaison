// SPDX-License-Identifier: FSL-1.1-ALv2
// An installed app's "Outbound access": granted and pending hosts, Revoke / Allow
// for an admin who may change them, nothing to press for one who may not.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeApi, type FakeApi } from "../app-page/__fixtures__/fake-api"

const state = vi.hoisted(() => ({ api: null as unknown }))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => state.api,
  useOptionalApi: () => state.api,
}))

import { OutboundAccessSection } from "./OutboundAccessSection"

let api: FakeApi

beforeEach(() => {
  api = createFakeApi()
  state.api = api
})

const access = (over: Record<string, unknown> = {}) => ({
  name: "crm",
  version: "1.1.0",
  declared: ["api.crm.example", "files.crm.example"],
  granted: ["api.crm.example"],
  pending: ["files.crm.example"],
  canManage: true,
  ...over,
})

describe("OutboundAccessSection", () => {
  it("lists granted and pending hosts and revokes one", async () => {
    api.on("get", "/apps/crm/outbound", () => access())
    api.on("post", "/apps/crm/outbound", () =>
      access({ granted: [], pending: ["api.crm.example", "files.crm.example"] }),
    )
    render(() => <OutboundAccessSection appId="crm" />)
    await screen.findByTestId("app-outbound-granted-api.crm.example")
    expect(screen.getByTestId("app-outbound-pending-files.crm.example")).toBeTruthy()
    fireEvent.click(screen.getByTestId("app-outbound-revoke-api.crm.example"))
    await waitFor(() =>
      expect(screen.getByTestId("app-outbound-pending-api.crm.example")).toBeTruthy(),
    )
    expect(api.post).toHaveBeenCalledWith("/apps/crm/outbound", { revoke: ["api.crm.example"] })
  })

  it("allows a pending host", async () => {
    api.on("get", "/apps/crm/outbound", () => access())
    api.on("post", "/apps/crm/outbound", () =>
      access({ granted: ["api.crm.example", "files.crm.example"], pending: [] }),
    )
    render(() => <OutboundAccessSection appId="crm" />)
    fireEvent.click(await screen.findByTestId("app-outbound-grant-files.crm.example"))
    await waitFor(() =>
      expect(screen.getByTestId("app-outbound-granted-files.crm.example")).toBeTruthy(),
    )
    expect(api.post).toHaveBeenCalledWith("/apps/crm/outbound", { grant: ["files.crm.example"] })
  })

  it("shows no button to an admin who may not change it, and a grandfathered grant as every host", async () => {
    api.on("get", "/apps/crm/outbound", () =>
      access({ granted: null, pending: [], canManage: false }),
    )
    render(() => <OutboundAccessSection appId="crm" />)
    await screen.findByTestId("app-outbound-grandfathered")
    expect(screen.getByTestId("app-outbound-granted-files.crm.example")).toBeTruthy()
    expect(screen.queryByTestId("app-outbound-revoke-api.crm.example")).toBeNull()
  })
})
