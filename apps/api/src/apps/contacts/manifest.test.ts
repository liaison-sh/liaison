// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { contactsAppManifest } from "~/apps/contacts/manifest-descriptor"
import { validateAppManifest } from "~/modules/apps/contract"
import contactsManifest from "./app.manifest.json"

describe("contacts manifest", () => {
  it("passes manifest validation", () => {
    expect(validateAppManifest(contactsManifest).success).toBe(true)
  })

  it("declares views.tabTypes for contact-list and contact-detail", () => {
    expect(contactsAppManifest.views.tabTypes["contact-list"].component).toBe("ContactList")
    expect(contactsAppManifest.views.tabTypes["contact-list"].singleton).toBe(true)
    expect(contactsAppManifest.views.tabTypes["contact-detail"].component).toBe("ContactDetail")
    expect(contactsAppManifest.views.tabTypes["contact-detail"].resolveLabel).toBe(
      "resolveContactTabLabel",
    )
  })

  it("is version 0.1.1 (the list page carries the groups sidebar)", () => {
    expect(contactsManifest.version).toBe("0.1.1")
  })

  it("gives the contact-list page the groups sidebar, the contact page its picker", () => {
    expect(contactsAppManifest.views.tabTypes["contact-list"].sidebar).toBe("ContactListSidebar")
    expect(contactsAppManifest.views.tabTypes["contact-detail"].sidebar).toBe("ContactsSidebar")
  })

  it("declares views.activityBar with order 20", () => {
    expect(contactsAppManifest.views.activityBar.label).toBe("Contacts")
    expect(contactsAppManifest.views.activityBar.order).toBe(20)
  })

  it("declares wsHandlers for kernel:contact entity", () => {
    expect(contactsAppManifest.views.wsHandlers).toMatchObject({
      contact: { key: "kernel:contact", handler: "handleContactEvent" },
    })
  })

  it("declares no tools", () => {
    expect((contactsAppManifest as any).tools).toBeUndefined()
  })
})

describe("getDefaultApps", () => {
  it("includes the contacts manifest", async () => {
    const { getDefaultApps } = await import("~/modules/apps/init")
    const apps = await getDefaultApps()
    expect(apps.some((app) => app.name === "contacts")).toBe(true)
  })
})
