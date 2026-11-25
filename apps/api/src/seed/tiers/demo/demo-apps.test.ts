// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo app lists per world: the services world brings agreements and the
// code host; the product and software worlds keep exactly the apps they had,
// whatever joins the demo's own list.
import { describe, expect, it } from "bun:test"
import { DEMO_APPS, DEMO_WORLD_APPS, demoSeedPlan } from "./demo-apps"

const ON = { warehouse: true }

describe("demo apps per world", () => {
  it("the product and software worlds' app lists are unchanged", () => {
    expect([...DEMO_WORLD_APPS.products]).toEqual([
      "tickets",
      "mail",
      "knowledge",
      "projects",
      "calendar",
      "contacts",
      "invoicing",
      "social",
      "pennylane",
      "boxtal",
      "shopify",
      "monitoring",
      "api-connector",
    ])
    expect([...DEMO_WORLD_APPS.saas]).toEqual([
      "tickets",
      "mail",
      "knowledge",
      "projects",
      "calendar",
      "contacts",
      "invoicing",
      "stripe",
    ])
    // The product world governs only its own apps, so the new ones are never turned Off there.
    expect(demoSeedPlan(undefined, ON, "products").offApps).toEqual([])
  })

  it("the services world has its nine apps, and every other demo app is Off there", () => {
    expect(([...DEMO_WORLD_APPS.studio] as string[]).sort()).toEqual(
      [
        "tickets",
        "mail",
        "knowledge",
        "projects",
        "calendar",
        "contacts",
        "invoicing",
        "agreements",
        "github",
      ].sort(),
    )
    const plan = demoSeedPlan(undefined, ON, "studio")
    expect(plan.apps).toEqual(DEMO_WORLD_APPS.studio)
    expect([...plan.offApps].sort()).toEqual(
      ["stripe", "shopify", "boxtal", "pennylane", "monitoring", "social", "api-connector"].sort(),
    )
    for (const app of DEMO_WORLD_APPS.studio) expect(DEMO_APPS as readonly string[]).toContain(app)
  })
})
