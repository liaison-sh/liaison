// SPDX-License-Identifier: FSL-1.1-ALv2
// Semver precedence for app versions, and the catalog install decision built
// on it: a catalog version that is not newer than the active one is never an
// "upgrade" (installing it would be refused as "not newer").
import { describe, expect, it } from "bun:test"
import { compareVersions, isNewerVersion } from "./activation"
import { catalogInstallAction } from "./catalog"

describe("app version precedence", () => {
  it("orders pre-releases per semver and ignores build metadata", () => {
    expect(isNewerVersion("1.2.0-rc2", "1.2.0-rc1")).toBe(true)
    expect(isNewerVersion("1.2.0-rc1", "1.2.0-rc2")).toBe(false)
    expect(isNewerVersion("1.2.0-rc.10", "1.2.0-rc.2")).toBe(true)
    expect(isNewerVersion("1.2.0", "1.2.0-rc1")).toBe(true)
    expect(isNewerVersion("1.2.0-rc1", "1.2.0")).toBe(false)
    expect(isNewerVersion("1.2.0-rc.1", "1.2.0-rc")).toBe(true)
    expect(isNewerVersion("1.2.0-alpha", "1.2.0-1")).toBe(true)
    expect(isNewerVersion("1.10.0", "1.9.9")).toBe(true)
    expect(compareVersions("1.2.0+b2", "1.2.0+b1")).toBe(0)
    expect(compareVersions("1.2.0-rc1+b2", "1.2.0-rc1")).toBe(0)
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0)
  })

  it("never calls a catalog version that is not newer an upgrade", () => {
    const action = (installedVersion: string, version: string) =>
      catalogInstallAction({ installed: true, installedVersion, version })
    expect(action("1.2.0-rc2", "1.2.0-rc1")).toBe("ahead")
    expect(action("1.2.0", "1.2.0-rc1")).toBe("ahead")
    expect(action("1.2.0-rc1", "1.2.0-rc2")).toBe("upgrade")
    expect(action("1.2.0-rc1", "1.2.0")).toBe("upgrade")
    expect(action("1.2.0+b2", "1.2.0+b1")).toBe("current")
    expect(action("1.2.0", "1.2.0")).toBe("current")
    expect(catalogInstallAction({ installed: false, version: "1.2.0" })).toBe("install")
  })
})
