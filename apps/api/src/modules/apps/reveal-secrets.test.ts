// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tool answer's `{ "$configSecret": key }` marker becomes the secret only for
// a webhook secret the tool declares in `revealsSecrets`, never for a custom
// app, and anything else is refused (reveal-secrets.ts).
import { describe, expect, it } from "bun:test"
import { revealDeclaredSecrets } from "./reveal-secrets"

const CONNECTIONS = {
  source: { webhookSecretConfigKey: "hookSecret" },
  oauth: { clientSecretConfigKey: "clientSecret" } as Record<string, string>,
}
const SECRETS: Record<string, string> = { hookSecret: "minted-hook-secret", clientSecret: "cs" }

const reveal = (result: unknown, over: Partial<Parameters<typeof revealDeclaredSecrets>[1]> = {}) =>
  revealDeclaredSecrets(result, {
    appName: "calls",
    toolName: "webhook_info",
    revealsSecrets: ["hookSecret"],
    connections: CONNECTIONS,
    readSecret: async (k) => SECRETS[k] ?? null,
    ...over,
  })

describe("revealDeclaredSecrets", () => {
  it("writes a declared webhook secret where its marker stands, anywhere in the answer", async () => {
    expect(
      await reveal({ data: { configured: true, secret: { $configSecret: "hookSecret" } } }),
    ).toEqual({ data: { configured: true, secret: "minted-hook-secret" } })
    expect(await reveal([{ $configSecret: "hookSecret" }])).toEqual(["minted-hook-secret"])
  })

  it("an unset secret reads null; an answer without a marker is returned as it is", async () => {
    const plain = { data: { configured: false, secret: null } }
    expect(await reveal(plain)).toBe(plain)
    expect(
      await reveal({ s: { $configSecret: "hookSecret" } }, { readSecret: async () => "" }),
    ).toEqual({ s: null })
  })

  it("refuses an undeclared key, a non-webhook secret and any custom app's marker", async () => {
    const refused = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: { code?: string }) => e.code,
      )
    expect(
      await refused(reveal({ s: { $configSecret: "hookSecret" } }, { revealsSecrets: [] })),
    ).toBe("secret_reveal_refused")
    expect(
      await refused(
        reveal({ s: { $configSecret: "clientSecret" } }, { revealsSecrets: ["clientSecret"] }),
      ),
    ).toBe("secret_reveal_refused")
    expect(
      await refused(reveal({ s: { $configSecret: "hookSecret" } }, { appName: "calls-o1a2b3c4d" })),
    ).toBe("secret_reveal_refused")
  })
})
