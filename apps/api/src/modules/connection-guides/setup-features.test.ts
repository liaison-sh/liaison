// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What is left is what the person chose; alternatives done by a sibling are not
 * left; everything else is a menu with its time. Found on a real install: setup
 * state listed every connection (gitlab, database, an IMAP mailbox next to a
 * connected Gmail, the old Instagram login next to Unified login) as left and
 * summed them into "about 88 to 165 min left".
 */
import { describe, expect, test } from "bun:test"
import {
  buildFeaturePlan,
  type FeatureFacts,
  SETUP_FEATURES,
  unknownSetupFeatures,
} from "~/modules/connection-guides/setup-features"
import { CONNECTION_ESTIMATES } from "~/modules/connection-guides/setup-timings"

const ALL_REFS = CONNECTION_ESTIMATES.flatMap((e) => e.refs)

function facts(connected: string[], done: Array<"import" | "connector"> = []): FeatureFacts {
  return {
    available: (r) => ALL_REFS.includes(r),
    connected: (r) => connected.includes(r),
    itemDone: (k) => done.includes(k),
  }
}

describe("setup features", () => {
  test("unanswered: only the basics are left, a connected Gmail does the IMAP alternative, the rest is a menu", () => {
    const plan = buildFeaturePlan(null, facts(["mail/gmail", "tickets/gmail"]))
    expect(plan.chosen).toBeNull()
    expect(plan.counted).toEqual(["email", "support"])
    expect(plan.left).toEqual([])
    expect(plan.leftMinutes).toEqual([0, 0])
    const menu = plan.menu.map((m) => m.feature)
    expect(menu).toContain("gitlab")
    expect(menu).toContain("database")
    expect(menu).not.toContain("email")
    expect(plan.menu.find((m) => m.feature === "gitlab")?.minutes).toEqual([2, 4])
  })

  test("chosen features only are left; Instagram with Unified login does the Instagram step", () => {
    const plan = buildFeaturePlan(
      ["email", "social", "gitlab"],
      facts(["mail/imap", "social/instagram_unified"]),
    )
    const refs = plan.left.map((s) => `${s.feature}:${s.refs.join("|")}`)
    expect(refs).toEqual(["social:social/facebook", "gitlab:gitlab/gitlab"])
    expect(plan.done).toEqual(["email"])
    // Facebook and Instagram (12-20) + GitLab (2-4); nothing unchosen is summed.
    expect(plan.leftMinutes).toEqual([14, 24])
    expect(plan.menu.map((m) => m.feature)).not.toContain("gitlab")
    expect(plan.menu.map((m) => m.feature)).toContain("support")
  })

  test("an optional step is never left; an item feature is left until its item is done", () => {
    const ads = buildFeaturePlan(["google-ads"], facts(["ads/google"]))
    expect(ads.left).toEqual([])
    const imp = buildFeaturePlan(["import"], facts([]))
    expect(imp.left).toEqual([{ feature: "import", refs: [], item: "import" }])
    expect(buildFeaturePlan(["import"], facts([], ["import"])).left).toEqual([])
  })

  test("a chosen feature whose app is off says so", () => {
    const plan = buildFeaturePlan(["shopify"], {
      ...facts([]),
      available: () => false,
    })
    expect(plan.left).toEqual([{ feature: "shopify", refs: ["shopify/shop"], unavailable: true }])
    // Only the import (a workspace item, no app) is still offered.
    expect(plan.menu.map((m) => m.feature)).toEqual(["import"])
  })

  test("a partly done feature says what is connected and what is left, chosen or offered", () => {
    const chosen = buildFeaturePlan(["social"], facts(["social/facebook"]))
    expect(chosen.left).toEqual([
      {
        feature: "social",
        refs: ["social/instagram", "social/instagram_unified"],
        done: ["social/facebook"],
      },
    ])
    const offered = buildFeaturePlan(["email"], facts(["social/facebook"]))
    expect(offered.menu.find((m) => m.feature === "social")).toMatchObject({
      done: ["social/facebook"],
      open: [["social/instagram", "social/instagram_unified"]],
    })
    // Untouched features carry neither.
    expect(offered.menu.find((m) => m.feature === "gitlab")).not.toHaveProperty("done")
  })

  test("every timed connection belongs to a feature, and ids are checked", () => {
    const inFeatures = new Set(SETUP_FEATURES.flatMap((f) => f.steps.flatMap((s) => s.refs)))
    expect(ALL_REFS.filter((r) => !inFeatures.has(r))).toEqual([])
    expect(unknownSetupFeatures(["email", "nope"])).toEqual(["nope"])
  })
})
