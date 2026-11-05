// SPDX-License-Identifier: FSL-1.1-ALv2
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these `${VAR}` strings are literal config-file values fed to interpolateEnv under test, not JS template strings.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ConfigError,
  interpolateEnv,
  literalSecretPaths,
  parseConfigFile,
} from "~/cli/config/parse"

function tmpFile(name: string, contents: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "liaison-parse-"))
  const path = join(dir, name)
  writeFileSync(path, contents)
  return { path, dir }
}

describe("parseConfigFile", () => {
  test("valid YAML parses to the expected object", () => {
    const { path, dir } = tmpFile(
      "config.yaml",
      "org:\n  slug: fabrikam\n  name: Fabrikam\n  credits:\n    currency: EUR\n",
    )
    try {
      const res = parseConfigFile(path)
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error("expected ok")
      expect(res.raw).toEqual({
        org: { slug: "fabrikam", name: "Fabrikam", credits: { currency: "EUR" } },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("valid JSON parses identically to the YAML equivalent", () => {
    const { path, dir } = tmpFile(
      "config.json",
      JSON.stringify({ org: { slug: "fabrikam", name: "Fabrikam", credits: { currency: "EUR" } } }),
    )
    try {
      const res = parseConfigFile(path)
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error("expected ok")
      expect(res.raw).toEqual({
        org: { slug: "fabrikam", name: "Fabrikam", credits: { currency: "EUR" } },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test(".yml extension is treated as YAML", () => {
    const { path, dir } = tmpFile("config.yml", "org:\n  slug: a\n")
    try {
      const res = parseConfigFile(path)
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error("expected ok")
      expect(res.raw).toEqual({ org: { slug: "a" } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("malformed YAML returns ok:false with code 2", () => {
    const { path, dir } = tmpFile("config.yaml", "org:\n  slug: a\n bad: : indent: :\n")
    try {
      const res = parseConfigFile(path)
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error("expected failure")
      expect(res.code).toBe(2)
      expect(typeof res.message).toBe("string")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("malformed JSON returns ok:false with code 2", () => {
    const { path, dir } = tmpFile("config.json", "{ not valid json ")
    try {
      const res = parseConfigFile(path)
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error("expected failure")
      expect(res.code).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("missing file returns ok:false with code 2", () => {
    const res = parseConfigFile(join(tmpdir(), "does-not-exist-xyz.yaml"))
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.code).toBe(2)
  })
})

describe("interpolateEnv", () => {
  test("substitutes ${VAR} present in env with the actual value", () => {
    const out = interpolateEnv({ key: "${MY_VAR}" }, { MY_VAR: "resolved-value" })
    expect(out).toEqual({ key: "resolved-value" })
  })

  test("${VAR:-fallback} with unset env yields the fallback value", () => {
    const out = interpolateEnv({ key: "${UNSET_VAR:-the-fallback}" }, {})
    expect(out).toEqual({ key: "the-fallback" })
  })

  test("${VAR:-fallback} with set env prefers the env value over the fallback", () => {
    const out = interpolateEnv({ key: "${SET_VAR:-the-fallback}" }, { SET_VAR: "from-env" })
    expect(out).toEqual({ key: "from-env" })
  })

  test("unset ${VAR} with no default throws ConfigError(exitCode 2) naming the var", () => {
    let threw: unknown
    try {
      interpolateEnv({ key: "${MISSING_THING}" }, {})
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(ConfigError)
    if (!(threw instanceof ConfigError)) throw new Error("expected ConfigError")
    expect(threw.exitCode).toBe(2)
    expect(threw.message).toContain("MISSING_THING")
  })

  test("recursively interpolates nested arrays and objects", () => {
    const out = interpolateEnv({ a: ["${X}", { b: "${Y}" }], c: "static" }, { X: "ex", Y: "why" })
    expect(out).toEqual({ a: ["ex", { b: "why" }], c: "static" })
  })

  test("leaves numbers, booleans, and null untouched (no coercion)", () => {
    const out = interpolateEnv({ n: 993, b: true, z: null }, {})
    expect(out).toEqual({ n: 993, b: true, z: null })
  })

  test("substitutes a var embedded inside a larger string, keeping surrounding text", () => {
    const out = interpolateEnv({ s: "prefix-${V}-suffix" }, { V: "mid" })
    expect(out).toEqual({ s: "prefix-mid-suffix" })
  })

  test("interpolates multiple vars in one string", () => {
    const out = interpolateEnv({ s: "${A}/${B}" }, { A: "x", B: "y" })
    expect(out).toEqual({ s: "x/y" })
  })

  test("substitutes the falsifiable exact value (not merely defined)", () => {
    const out = interpolateEnv("${TOKEN}", { TOKEN: "sk-12345" })
    expect(out).toBe("sk-12345")
    expect(out).not.toBe("${TOKEN}")
  })
})

describe("literalSecretPaths (the file-permission warning)", () => {
  test("a config of ${VAR} references only holds no secret", () => {
    expect(
      literalSecretPaths({
        org: { name: "Acme" },
        apiConnectors: [
          {
            identifier: "crm",
            adapter: { auth: { type: "oauth2ClientCredentials", tokenUrl: "https://x.example/t" } },
            credentials: { token: "${CRM_TOKEN}", clientId: "${ID:-}" },
          },
        ],
        byok: { providers: [{ provider: "openrouter", apiKey: "${OPENROUTER_KEY}" }] },
      }),
    ).toEqual([])
  })

  test("names each literal secret: a credential, a key, a non-empty default", () => {
    expect(
      literalSecretPaths({
        apiConnectors: [{ credentials: { clientId: "abc", clientSecret: "${S}" } }],
        admin: { password: "hunter2" },
        byok: { providers: [{ apiKey: "${KEY:-sk-live-123}" }] },
      }),
    ).toEqual(["apiConnectors.0.credentials.clientId", "admin.password", "byok.providers.0.apiKey"])
  })
})
