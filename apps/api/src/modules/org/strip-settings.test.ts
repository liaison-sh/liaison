// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { stripSensitiveSettings } from "~/modules/org/routes"

describe("non-admin org settings view", () => {
  it("drops the known secret blocks and any key that names secret material", () => {
    const out = stripSensitiveSettings({
      rateLimitPerMinute: 100,
      providerKeys: { openai: { ciphertext: "x" } },
      integrations: { google: { clientSecretEncrypted: "y" } },
      taintSources: {},
      futureFeature: {
        enabled: true,
        apiKey: "k",
        webhookSecret: "s",
        nested: { accessToken: "t" },
      },
      ai: { creditCap: 5, maxTokensPerTurn: 1000 },
    }) as Record<string, unknown>
    expect(out).toEqual({
      rateLimitPerMinute: 100,
      futureFeature: { enabled: true, nested: {} },
      ai: { creditCap: 5, maxTokensPerTurn: 1000 },
    })
  })
})
