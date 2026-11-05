// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "vitest"
import { getTabType } from "~/framework/app-registry"
import { type AppManifest, registerAppFromManifest } from "~/framework/define-app"

// Mock UI module
const MockList = () => null
const MockIcon = () => null

describe("registerAppFromManifest", () => {
  afterEach(() => {
    // Clean up: unregister any registered app (happens via idempotent re-register)
  })

  it("registers tab types from manifest view declarations", () => {
    const manifest: AppManifest = {
      name: "contacts",
      views: {
        tabTypes: {
          list: {
            component: "ContactList",
            icon: "ContactIcon",
            singleton: true,
            urlPattern: "/contacts",
          },
        },
        activityBar: { icon: "ContactIcon", label: "Contacts", order: 30 },
      },
    }

    const uiExports = {
      ContactList: MockList,
      ContactIcon: MockIcon,
    }

    registerAppFromManifest(manifest, uiExports)

    const tabType = getTabType("contacts:list")
    expect(tabType).toBeDefined()
    expect(tabType?.singleton).toBe(true)
  })

  it("throws when manifest references missing UI export", () => {
    const manifest: AppManifest = {
      name: "bad",
      views: {
        tabTypes: {
          list: { component: "NonExistent", icon: "AlsoMissing", urlPattern: "/bad" },
        },
      },
    }

    expect(() => registerAppFromManifest(manifest, {})).toThrow("NonExistent")
  })
})
