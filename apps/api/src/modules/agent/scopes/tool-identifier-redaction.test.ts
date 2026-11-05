// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-FX2: a machine name written into one agent's system prompt comes back
// out of it, and a relayed decline then carries that name to a person. The
// answer an ask hands back to its caller is scrubbed of the identifiers the
// tool projection itself registered, and of nothing else: the scrub is driven
// by the registry's own name list, never by a pattern over arbitrary text.
import { afterAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import {
  redactAgentsAskResult,
  redactToolIdentifiers,
  registeredToolIdentifiers,
} from "~/modules/agent/scopes/tool-identifier-redaction"
import { toolRegistry } from "~/modules/apps/app-registries"

const ORG = crypto.randomUUID()
const OTHER_ORG = crypto.randomUUID()

function register(orgId: string, appName: string, toolName: string): void {
  toolRegistry.set([orgId, appName, toolName], {
    appName,
    name: toolName,
    description: "a fixture tool",
    requiredScopes: ["kernel"],
    params: z.object({}),
    handler: async () => ({}),
    readOnly: true,
  })
}

register(ORG, "ledger", "invoice_total")
register(ORG, "courier", "shipment_status")
// A kernel tool is registered under the same registry with the app name
// "kernel", so `kernel__agents_ask` is an identifier exactly as
// `ledger__invoice_total` is, and a decline that names one leaks the same way.
register(ORG, "kernel", "agents_ask")
register(OTHER_ORG, "secretapp", "secret_read")

afterAll(() => {
  toolRegistry.deleteByPrefix([ORG])
  toolRegistry.deleteByPrefix([OTHER_ORG])
})

describe("tool identifier redaction", () => {
  it("lists this org's registered identifiers in the projection's own form", () => {
    const names = registeredToolIdentifiers(ORG)
    expect(names).toContain("ledger__invoice_total")
    expect(names).toContain("courier__shipment_status")
    expect(names).not.toContain("secretapp__secret_read")
  })

  it("replaces a registered identifier a relayed decline carried to the caller", () => {
    const leaked = "@finance does not have the ledger__invoice_total tool available either"
    expect(redactToolIdentifiers(leaked, ORG)).toBe(
      "@finance does not have the a tool tool available either",
    )
  })

  it("replaces an identifier the model wrapped in backticks, backticks included", () => {
    expect(redactToolIdentifiers("I tried `courier__shipment_status` and it failed.", ORG)).toBe(
      "I tried a tool and it failed.",
    )
  })

  it("replaces every occurrence, whatever case the model wrote", () => {
    const text = "ledger__invoice_total then LEDGER__INVOICE_TOTAL again"
    expect(redactToolIdentifiers(text, ORG)).toBe("a tool then a tool again")
  })

  it("leaves an identifier that is not registered in this org alone", () => {
    // Never a pattern over arbitrary text: only what the registry holds for
    // THIS org is a tool identifier, so another org's name and an ordinary
    // double underscore word both survive untouched.
    const text = "secretapp__secret_read and my_snake__case_variable stay as they are"
    expect(redactToolIdentifiers(text, ORG)).toBe(text)
  })

  it("lists the kernel tool identifiers this org carries", () => {
    const names = registeredToolIdentifiers(ORG)
    expect(names).toContain("kernel__agents_ask")
  })

  it("replaces a kernel identifier a relayed decline carried to the caller", () => {
    expect(redactToolIdentifiers("I tried kernel__agents_ask and it refused.", ORG)).toBe(
      "I tried a tool and it refused.",
    )
  })

  it("scrubs the reason and the note of an ask result, not only its answer", () => {
    // Every string an ask result hands back reaches the model and, through it,
    // a person. The answer was the one observed leak; the reason and the note
    // are the same surface and are scrubbed by the same name list.
    const refused = {
      asked: false,
      reason: "ledger__invoice_total is not available to that agent",
      note: "asked through courier__shipment_status, answer pending",
      answer: "kernel__agents_ask declined",
    }
    const result = redactAgentsAskResult(refused, ORG)
    expect(result.reason).toBe("a tool is not available to that agent")
    expect(result.note).toBe("asked through a tool, answer pending")
    expect(result.answer).toBe("a tool declined")
  })

  it("leaves an ask result carrying no text at all untouched", () => {
    const bare = { asked: true }
    expect(redactAgentsAskResult(bare, ORG)).toEqual(bare)
  })

  it("returns an empty or absent answer unchanged", () => {
    expect(redactToolIdentifiers("", ORG)).toBe("")
    expect(redactToolIdentifiers(null, ORG)).toBeNull()
  })
})
