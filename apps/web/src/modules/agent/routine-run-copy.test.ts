// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import en from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"
import fr from "../../../../../packages/shared/src/i18n/locales/fr/kernel.json"
import { runTriggerLabel } from "./routine-run-copy"

const translate =
  (dict: { agentForms: Record<string, string> }) =>
  (key: string): string =>
    dict.agentForms[key.replace("kernel.agentForms.", "")] ?? key

describe("routine run trigger label", () => {
  it("a run the event reconciler fired again reads Retry, Nouvelle tentative in French", () => {
    expect(runTriggerLabel(translate(en), { trigger: "retry" }, "event")).toBe("Retry")
    expect(runTriggerLabel(translate(fr), { trigger: "retry" }, "event")).toBe("Nouvelle tentative")
  })
})
