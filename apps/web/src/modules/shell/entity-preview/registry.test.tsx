// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "vitest"
import { entityPreviewRegistry, getEntityPreviewRenderer, registerEntityPreview } from "./registry"

beforeEach(() => entityPreviewRegistry.clear())

describe("entityPreviewRegistry", () => {
  it("registers and retrieves a renderer by app and entity type", () => {
    const fetch = async () => ({ id: "x" })
    const render = (data: any) => <div>{data.id}</div>

    registerEntityPreview({ app: "kernel", entityType: "contact", fetch, render })
    const registered = getEntityPreviewRenderer("kernel", "contact")

    expect(registered?.fetch).toBe(fetch)
    expect(registered?.render).toBe(render)
  })

  it("returns undefined for unregistered app and entity type pairs", () => {
    expect(getEntityPreviewRenderer("unknown", "contact")).toBeUndefined()
  })

  it("real contact and mail modules register their entity preview renderers", async () => {
    const contacts = await import("~/modules/contacts/entity-preview-renderers")
    const mail = await import("~/modules/mail/entity-preview-renderers")

    contacts.registerEntityPreviews()
    mail.registerEntityPreviews()

    expect(getEntityPreviewRenderer("kernel", "contact")).toBeDefined()
    expect(getEntityPreviewRenderer("mail", "conversation")).toBeDefined()
  })
})
