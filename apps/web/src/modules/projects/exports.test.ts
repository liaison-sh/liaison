// SPDX-License-Identifier: FSL-1.1-ALv2
// The projects app registers its bulk "Set labels…" form: without the
// registration the toolbar falls back to a text field for the label map.
import { afterEach, describe, expect, it } from "vitest"
import { getBulkUiCustomForm, resetRegistry } from "~/framework/app-registry"
import { registerAppHooks } from "~/modules/projects/exports"
import { SetTaskLabelsForm } from "~/modules/projects/SetTaskLabelsForm"

describe("projects registerAppHooks", () => {
  afterEach(() => resetRegistry())

  it("registers SetTaskLabelsForm for the setLabels bulk action", () => {
    expect(getBulkUiCustomForm("projects", "setLabels")).toBeUndefined()
    registerAppHooks()
    expect(getBulkUiCustomForm("projects", "setLabels")).toBe(SetTaskLabelsForm)
  })
})
