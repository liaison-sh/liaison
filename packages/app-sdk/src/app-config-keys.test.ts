// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { checkAppConfigWrite, configKeysDeclarationErrors } from "./app-config-keys"
import { packageManifestSchema } from "./package-format"

const base = {
  name: "my-app",
  version: "1.0.0",
  packageFormat: 1,
  license: "MIT",
  scopes: ["my-app:items:read"],
}

const connections = {
  webhook: { type: "credentials", webhookSecretConfigKey: "hookSecret" },
  oauth: { type: "oauth2", clientSecretConfigKey: "clientSecret" },
}

describe("manifest configKeys", () => {
  it("accepts declared non-secret keys", () => {
    const r = packageManifestSchema.safeParse({
      ...base,
      connections,
      configKeys: [
        { key: "sources", type: "json" },
        { key: "dashboardUrl", type: "url", label: "Dashboard" },
      ],
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.configKeys?.map((k) => k.key)).toEqual(["sources", "dashboardUrl"])
  })

  it("refuses a key equal to a connection's webhookSecretConfigKey", () => {
    const r = packageManifestSchema.safeParse({
      ...base,
      connections,
      configKeys: [{ key: "hookSecret", type: "string" }],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toContain("connection secret")
  })

  it("refuses a key equal to an OAuth clientSecretConfigKey", () => {
    expect(configKeysDeclarationErrors([{ key: "clientSecret" }], connections)).toHaveLength(1)
  })

  it("refuses an unknown type and a duplicate key", () => {
    expect(
      packageManifestSchema.safeParse({ ...base, configKeys: [{ key: "a", type: "number" }] })
        .success,
    ).toBe(false)
    expect(configKeysDeclarationErrors([{ key: "a" }, { key: "a" }], {})).toEqual([
      'configKeys: key "a" is declared twice',
    ])
  })
})

describe("checkAppConfigWrite", () => {
  const manifest = {
    connections,
    configKeys: [
      { key: "sources", type: "json" as const },
      { key: "dashboardUrl", type: "url" as const },
      { key: "title", type: "string" as const },
    ],
  }

  it("accepts a declared key with a value of its type", () => {
    expect(checkAppConfigWrite(manifest, "sources", [{ id: "a" }]).ok).toBe(true)
    expect(checkAppConfigWrite(manifest, "dashboardUrl", "https://status.example").ok).toBe(true)
    expect(checkAppConfigWrite(manifest, "title", "x").ok).toBe(true)
    expect(checkAppConfigWrite(manifest, "dashboardUrl", null).ok).toBe(true)
  })

  it("refuses an undeclared key, a secret key, and a value of the wrong type", () => {
    const codeOf = (key: string, value: unknown) => {
      const r = checkAppConfigWrite(manifest, key, value)
      return r.ok ? "ok" : r.code
    }
    expect(codeOf("other", "x")).toBe("undeclared")
    expect(codeOf("hookSecret", "x")).toBe("secret")
    expect(codeOf("clientSecret", "x")).toBe("secret")
    expect(codeOf("dashboardUrl", "javascript:alert(1)")).toBe("invalid")
    expect(codeOf("dashboardUrl", "ftp://x.example")).toBe("invalid")
    expect(codeOf("dashboardUrl", "not a url")).toBe("invalid")
    expect(codeOf("title", 3)).toBe("invalid")
    expect(codeOf("sources", undefined)).toBe("invalid")
  })

  it("refuses an extra secret key supplied by the caller even when declared", () => {
    const r = checkAppConfigWrite(manifest, "title", "x", ["title"])
    expect(r.ok ? "ok" : r.code).toBe("secret")
  })
})
