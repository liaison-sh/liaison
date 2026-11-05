// SPDX-License-Identifier: FSL-1.1-ALv2
// Add source on the Knowledge settings page opens the dedicated add tab, never
// an inline form (F1).
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ openTab: vi.fn() }))
vi.mock("~/modules/shell/tab-store", () => ({ openTab: state.openTab }))

import { SyncedSourceAdd } from "./SyncedSourceAdd"

describe("SyncedSourceAdd", () => {
  it("opens the synced source add tab", () => {
    render(() => <SyncedSourceAdd />)
    fireEvent.click(screen.getByTestId("synced-sources-add-button"))
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "knowledge:synced-source-add", entityId: "new" }),
    )
  })
})
