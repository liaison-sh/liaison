// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app builder's draft writes declare their readers (`sinkReadScope`): drafts are
// read back only through kernel:apps:build, so on a tainted turn a draft step is judged
// by the holders of that scope (scope-taint.ts, rule 6a) instead of parking every step
// for approval as a write to a table nobody declared the readers of (rule 8b). Only
// publish is gated.
import { afterAll, describe, expect, it } from "bun:test"
import { env } from "~/lib/env"
import { APP_BUILDER_TOOL_NAMES, registerAppBuilderTools } from "~/modules/app-builder/tools"
import { toolRegistry } from "~/modules/apps/app-registries"

const ORG = "00000000-0000-4000-8000-0000000000b1"
const saved = env.LIAISON_CUSTOM_APPS

afterAll(() => {
  for (const name of APP_BUILDER_TOOL_NAMES) toolRegistry.delete([ORG, "kernel", name])
  env.LIAISON_CUSTOM_APPS = saved
})

describe("app builder tools: declared draft readers", () => {
  it("every ungated write to the drafts declares kernel:apps:build as its readers", () => {
    env.LIAISON_CUSTOM_APPS = "on"
    registerAppBuilderTools(ORG)
    const writes = APP_BUILDER_TOOL_NAMES.map((name) => toolRegistry.get([ORG, "kernel", name]))
      .filter((def) => def !== undefined)
      .filter((def) => def.writesToTable === "kernel.app_drafts" && def.gated !== true)
    expect(writes.map((def) => def.name).sort()).toEqual([
      "apps_build_check",
      "apps_build_create",
      "apps_build_discard",
      "apps_build_restore",
      "apps_build_update",
    ])
    for (const def of writes) expect(def.sinkReadScope).toBe("kernel:apps:build")
    const publish = toolRegistry.get([ORG, "kernel", "apps_build_publish"])
    expect(publish?.gated).toBe(true)
  })
})
