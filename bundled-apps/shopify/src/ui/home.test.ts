// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ShopifyHome revalidation invariant (Task A4). The bundled-app bun runner
// transpiles JSX to the React runtime and cannot render the solid `.tsx` view,
// so the behavioral proof that `app.createResource` revalidates on a resync bump
// lives in apps/web's host-services.test (the factory refetches on bump). Here
// we pin the SOURCE invariant that ShopifyHome consumes `app.createResource`
// (not a frozen source-less `createResource`), so a Monday-data-on-Wednesday
// regression would be caught.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const source = readFileSync(join(import.meta.dir, "home.tsx"), "utf-8")

describe("ShopifyHome revalidation", () => {
  it("loads its bundle through app.createResource so the tab revalidates on resync", () => {
    expect(source).toContain("app.createResource<HomeBundle>")
    // Must not fall back to a plain source-less createResource (the frozen form).
    expect(source).not.toMatch(/[^.]createResource<HomeBundle>/)
  })
})
