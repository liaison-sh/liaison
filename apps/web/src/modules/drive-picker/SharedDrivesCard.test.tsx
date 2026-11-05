// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
}))
vi.mock("~/modules/shell/toast-store", () => ({ addToast: vi.fn() }))

import { SharedDrivesCard, type SharedDrivesStateView } from "./SharedDrivesCard"

const ACCOUNT = "22222222-2222-4222-8222-222222222222"

function state(over: Partial<SharedDrivesStateView> = {}): SharedDrivesStateView {
  return {
    canManage: true,
    accounts: [
      { id: ACCOUNT, identifier: "ops@acme.example", sharedDrives: [], needsSharedDrives: true },
    ],
    ...over,
  }
}

beforeEach(() => {
  apiMocks.get.mockReset()
  apiMocks.put.mockReset()
})

describe("SharedDrivesCard", () => {
  it("says the org connection reads nothing until shared drives are picked, and saves the pick", async () => {
    apiMocks.get.mockImplementation(async (url: string) =>
      url.startsWith("/google-drive/shared-drives/available")
        ? {
            account: state().accounts[0],
            available: [
              { id: "DRIVE_TEAM", name: "Team", chosen: false },
              { id: "DRIVE_OTHER", name: "Other", chosen: false },
            ],
          }
        : state(),
    )
    apiMocks.put.mockResolvedValue({})
    render(() => <SharedDrivesCard accountId={ACCOUNT} />)
    await waitFor(() => expect(screen.getByTestId("drive-shared-drives-none")).toBeTruthy())
    fireEvent.click(screen.getByTestId("drive-shared-drives-choose"))
    await waitFor(() => expect(screen.getByTestId("drive-shared-drive-DRIVE_TEAM")).toBeTruthy())
    fireEvent.click(screen.getByTestId("drive-shared-drive-DRIVE_TEAM"))
    fireEvent.click(screen.getByTestId("drive-shared-drives-save"))
    await waitFor(() =>
      expect(apiMocks.put).toHaveBeenCalledWith("/google-drive/shared-drives", {
        accountId: ACCOUNT,
        drives: ["DRIVE_TEAM"],
      }),
    )
  })

  it("lists the shared drives shared; a member who cannot manage gets no chooser", async () => {
    apiMocks.get.mockResolvedValue(
      state({
        canManage: false,
        accounts: [
          {
            id: ACCOUNT,
            identifier: "ops@acme.example",
            sharedDrives: [{ id: "DRIVE_TEAM", name: "Team" }],
            needsSharedDrives: false,
          },
        ],
      }),
    )
    render(() => <SharedDrivesCard accountId={ACCOUNT} />)
    await waitFor(() =>
      expect(screen.getByTestId("drive-shared-drives-list").textContent).toContain("Team"),
    )
    expect(screen.queryByTestId("drive-shared-drives-choose")).toBeNull()
  })
})
