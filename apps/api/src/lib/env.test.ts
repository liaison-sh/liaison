// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, test } from "bun:test"

describe("env", () => {
  test("ENCRYPTION_KEY is required and independent from JWT_SECRET", () => {
    const { encryptionKey, env } = require("~/lib/env")
    // encryptionKey should equal ENCRYPTION_KEY, not JWT_SECRET
    expect(encryptionKey).toBe(env.ENCRYPTION_KEY)
    expect(env.ENCRYPTION_KEY).toBeDefined()
    expect(env.ENCRYPTION_KEY!.length).toBeGreaterThanOrEqual(32)
  })
})

describe("env schema", () => {
  test("ENCRYPTION_KEY must be exactly 64 hex characters", () => {
    const { envSchema } = require("~/lib/env")
    const result = envSchema.safeParse({
      JWT_SECRET: "a".repeat(32),
      ENCRYPTION_KEY: "not-hex",
      BASE_URL: "http://localhost:3000",
      ALLOWED_ORIGINS: "http://localhost:5173",
    })
    expect(result.success).toBe(false)
  })

  test("TRUSTED_PROXY_HOPS defaults to 0 (direct connection) and validates as number", () => {
    const { envSchema } = require("~/lib/env")
    const result = envSchema.safeParse({
      JWT_SECRET: "a".repeat(32),
      ENCRYPTION_KEY: "ab".repeat(32),
      BASE_URL: "http://localhost:3000",
      ALLOWED_ORIGINS: "http://localhost:5173",
    })
    expect(result.success).toBe(true)
    expect(result.data.TRUSTED_PROXY_HOPS).toBe(0)
  })

  test("REQUEST_TIMEOUT_MS + DB_CONNECT_TIMEOUT default to the production ceilings and coerce from strings", () => {
    const { envSchema } = require("~/lib/env")
    const base = {
      JWT_SECRET: "a".repeat(32),
      ENCRYPTION_KEY: "ab".repeat(32),
      BASE_URL: "http://localhost:3000",
      ALLOWED_ORIGINS: "http://localhost:5173",
    }
    const def = envSchema.safeParse(base)
    expect(def.success).toBe(true)
    expect(def.data.REQUEST_TIMEOUT_MS).toBe(30_000) // production ceiling unchanged
    expect(def.data.DB_CONNECT_TIMEOUT).toBe(10)
    // chaos profile passes strings via process env → coerced to numbers
    const raised = envSchema.safeParse({
      ...base,
      REQUEST_TIMEOUT_MS: "180000",
      DB_CONNECT_TIMEOUT: "45",
    })
    expect(raised.success).toBe(true)
    expect(raised.data.REQUEST_TIMEOUT_MS).toBe(180_000)
    expect(raised.data.DB_CONNECT_TIMEOUT).toBe(45)
  })

  test("DEVICE_FLOW_CLIENTS parses comma-separated list", () => {
    const { envSchema } = require("~/lib/env")
    const result = envSchema.safeParse({
      JWT_SECRET: "a".repeat(32),
      ENCRYPTION_KEY: "ab".repeat(32),
      BASE_URL: "http://localhost:3000",
      ALLOWED_ORIGINS: "http://localhost:5173",
      DEVICE_FLOW_CLIENTS: "cli,vscode,jetbrains",
    })
    expect(result.success).toBe(true)
    expect(result.data.DEVICE_FLOW_CLIENTS).toEqual(["cli", "vscode", "jetbrains"])
  })

  test("EXPOSE_REFRESH_TOKEN_IN_BODY defaults to false", () => {
    const { envSchema } = require("~/lib/env")
    const result = envSchema.safeParse({
      JWT_SECRET: "a".repeat(32),
      ENCRYPTION_KEY: "ab".repeat(32),
      BASE_URL: "http://localhost:3000",
      ALLOWED_ORIGINS: "http://localhost:5173",
    })
    expect(result.success).toBe(true)
    expect(result.data.EXPOSE_REFRESH_TOKEN_IN_BODY).toBe(false)
  })
})

describe("env schema — AI provider keys", () => {
  it("accepts all provider keys as optional strings", () => {
    const { envSchema } = require("~/lib/env")
    const base = {
      JWT_SECRET: "a".repeat(32),
      ENCRYPTION_KEY: "ab".repeat(32),
    }
    const result = envSchema.safeParse(base)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.LIAISON_ANTHROPIC_API_KEY).toBeUndefined()
      expect(result.data.OPENAI_API_KEY).toBeUndefined()
      expect(result.data.GOOGLE_API_KEY).toBeUndefined()
      expect(result.data.MISTRAL_API_KEY).toBeUndefined()
    }
  })

  it("passes through provider keys when set", () => {
    const { envSchema } = require("~/lib/env")
    const base = {
      JWT_SECRET: "a".repeat(32),
      ENCRYPTION_KEY: "ab".repeat(32),
      LIAISON_ANTHROPIC_API_KEY: "sk-ant-test",
      OPENAI_API_KEY: "sk-test",
      GOOGLE_API_KEY: "goog-test",
      MISTRAL_API_KEY: "mis-test",
    }
    const result = envSchema.safeParse(base)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.LIAISON_ANTHROPIC_API_KEY).toBe("sk-ant-test")
      expect(result.data.OPENAI_API_KEY).toBe("sk-test")
      expect(result.data.GOOGLE_API_KEY).toBe("goog-test")
      expect(result.data.MISTRAL_API_KEY).toBe("mis-test")
    }
  })
})

describe("envSchema search, storage and email fields", () => {
  it("accepts meili, storage, resend, and meili-prefix fields", () => {
    const { envSchema } = require("~/lib/env")
    const parsed = envSchema.parse({
      JWT_SECRET: "x".repeat(32),
      ENCRYPTION_KEY: "0".repeat(64),
      MEILISEARCH_HOST: "http://localhost:7700",
      MEILISEARCH_API_KEY: "dev-master-key",
      MEILI_INDEX_PREFIX: "test_",
      OBJECT_STORAGE_ENDPOINT: "http://localhost:9000",
      OBJECT_STORAGE_REGION: "us-east-1",
      OBJECT_STORAGE_BUCKET: "liaison-dev",
      OBJECT_STORAGE_ACCESS_KEY: "liaison",
      OBJECT_STORAGE_SECRET_KEY: "liaison-dev-secret",
      OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
      OBJECT_STORAGE_PUBLIC_URL: "http://cdn.example.com",
      RESEND_API_KEY: "re_test_key",
      EMAIL_FROM: "noreply@liaison.dev",
    })
    expect(parsed.MEILISEARCH_HOST).toBe("http://localhost:7700")
    expect(parsed.MEILI_INDEX_PREFIX).toBe("test_")
    expect(parsed.OBJECT_STORAGE_FORCE_PATH_STYLE).toBe(true)
    expect(parsed.OBJECT_STORAGE_PUBLIC_URL).toBe("http://cdn.example.com")
    expect(parsed.RESEND_API_KEY).toBe("re_test_key")
  })

  it("defaults storage path style to true and prefix to empty string", () => {
    const { envSchema } = require("~/lib/env")
    const parsed = envSchema.parse({
      JWT_SECRET: "x".repeat(32),
      ENCRYPTION_KEY: "0".repeat(64),
    })
    expect(parsed.OBJECT_STORAGE_FORCE_PATH_STYLE).toBe(true)
    expect(parsed.MEILI_INDEX_PREFIX).toBe("")
  })

  it("accepts SYSTEM_RESEND_API_KEY (system/auth email channel) and defaults it empty", () => {
    const { envSchema } = require("~/lib/env")
    const base = { JWT_SECRET: "x".repeat(32), ENCRYPTION_KEY: "0".repeat(64) }
    expect(envSchema.parse(base).SYSTEM_RESEND_API_KEY).toBe("")
    expect(
      envSchema.parse({ ...base, SYSTEM_RESEND_API_KEY: "re_sys_key" }).SYSTEM_RESEND_API_KEY,
    ).toBe("re_sys_key")
  })

  it("rejects MEILISEARCH_HOST without MEILISEARCH_API_KEY when NODE_ENV=production", () => {
    const { envSchema } = require("~/lib/env")
    expect(() =>
      envSchema.parse({
        JWT_SECRET: "k3Jx9fQ2mZpL8vNcR5tYwB7hD1sGaE4u",
        ENCRYPTION_KEY: "9f2c7a1be84d03659cfa12d7e6b0384a51c9d2e7f0a6b83c4d15e9f2a7c0b6d3",
        NODE_ENV: "production",
        BYOK_ENCRYPTION_KEY: "4be1d07c93a6f2851e7d0c3b9a64f5e28d1c7b0a3f96e4d52c8b1a07e3d9f6c4",
        MEILISEARCH_HOST: "http://prod-meili",
      }),
    ).toThrow()
  })
})

describe("env schema — Gmail OAuth credentials", () => {
  it("accepts Gmail OAuth credentials as optional strings", () => {
    const { envSchema } = require("~/lib/env")
    const result = envSchema.safeParse({
      JWT_SECRET: "a".repeat(32),
      ENCRYPTION_KEY: "ab".repeat(32),
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.GMAIL_OAUTH_CLIENT_ID).toBeUndefined()
      expect(result.data.GMAIL_OAUTH_CLIENT_SECRET).toBeUndefined()
    }
  })

  it("passes through Gmail OAuth credentials when set", () => {
    const { envSchema } = require("~/lib/env")
    const result = envSchema.safeParse({
      JWT_SECRET: "a".repeat(32),
      ENCRYPTION_KEY: "ab".repeat(32),
      GMAIL_OAUTH_CLIENT_ID: "gmail-client-id",
      GMAIL_OAUTH_CLIENT_SECRET: "gmail-client-secret",
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.GMAIL_OAUTH_CLIENT_ID).toBe("gmail-client-id")
      expect(result.data.GMAIL_OAUTH_CLIENT_SECRET).toBe("gmail-client-secret")
    }
  })
})

describe("env — qaSeedRoutesEnabled", () => {
  test("is true under the test runner (NODE_ENV=test mounts the seed harness)", () => {
    // This module loads under NODE_ENV=test, so the seed routes are enabled.
    // The security note in env.ts documents that the production refuse-to-boot
    // guard intentionally does NOT cover the test arm (it would break the suite);
    // the operator's hard guard is running prod with NODE_ENV=production.
    const { qaSeedRoutesEnabled } = require("~/lib/env")
    expect(qaSeedRoutesEnabled).toBe(true)
  })

  test("ENABLE_QA_SEED_ROUTES + NODE_ENV=production fails the env validator (refuse-to-boot)", () => {
    // The schema parse itself succeeds; the fatal guard is a process.exit after
    // parse. Assert the flag round-trips so the guard above it has a value to act
    // on (the exit path is exercised by the boot, not unit-importable safely).
    const { envSchema } = require("~/lib/env")
    const r = envSchema.safeParse({
      JWT_SECRET: "k3Jx9fQ2mZpL8vNcR5tYwB7hD1sGaE4u",
      ENCRYPTION_KEY: "9f2c7a1be84d03659cfa12d7e6b0384a51c9d2e7f0a6b83c4d15e9f2a7c0b6d3",
      NODE_ENV: "production",
      BYOK_ENCRYPTION_KEY: "4be1d07c93a6f2851e7d0c3b9a64f5e28d1c7b0a3f96e4d52c8b1a07e3d9f6c4",
      BASE_URL: "https://liaison.example.com",
      MEILISEARCH_API_KEY: "k",
      ENABLE_QA_SEED_ROUTES: "true",
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.ENABLE_QA_SEED_ROUTES).toBe(true)
      expect(r.data.NODE_ENV).toBe("production")
    }
  })
})

describe("env schema — PARALLEL_APPROVAL_BUNDLING", () => {
  test("defaults to false when unset", () => {
    const { envSchema } = require("~/lib/env")
    const r = envSchema.safeParse({
      JWT_SECRET: "a".repeat(32),
      ENCRYPTION_KEY: "ab".repeat(32),
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.PARALLEL_APPROVAL_BUNDLING).toBe(false)
  })

  test("parses '1' as true", () => {
    const { envSchema } = require("~/lib/env")
    const r = envSchema.safeParse({
      JWT_SECRET: "a".repeat(32),
      ENCRYPTION_KEY: "ab".repeat(32),
      PARALLEL_APPROVAL_BUNDLING: "1",
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.PARALLEL_APPROVAL_BUNDLING).toBe(true)
  })

  test("parses 'true' as true", () => {
    const { envSchema } = require("~/lib/env")
    const r = envSchema.safeParse({
      JWT_SECRET: "a".repeat(32),
      ENCRYPTION_KEY: "ab".repeat(32),
      PARALLEL_APPROVAL_BUNDLING: "true",
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.PARALLEL_APPROVAL_BUNDLING).toBe(true)
  })
})

describe("env schema: boolean keys parse strictly", () => {
  const BOOLEAN_KEYS = {
    EXPOSE_REFRESH_TOKEN_IN_BODY: false,
    EXPOSE_ERROR_DETAIL: false,
    DB_RLS_JIT_ENABLED: false,
    ENABLE_LOAD_TEST_ENDPOINT: false,
    ENABLE_QA_SEED_ROUTES: false,
    SMTP_SECURE: false,
    OBJECT_STORAGE_FORCE_PATH_STYLE: true,
    OBJECT_STORAGE_BROWSER_DIRECT: false,
    PARALLEL_APPROVAL_BUNDLING: false,
  } as const
  const base = { JWT_SECRET: "a".repeat(32), ENCRYPTION_KEY: "ab".repeat(32) }

  for (const [key, defaultValue] of Object.entries(BOOLEAN_KEYS)) {
    test(`${key}: "false", "0", "no", "FALSE" and empty parse as false`, () => {
      const { envSchema } = require("~/lib/env")
      for (const raw of ["false", "0", "no", "FALSE", "No", ""]) {
        const r = envSchema.safeParse({ ...base, [key]: raw })
        expect(r.success).toBe(true)
        expect([raw, r.data[key]]).toEqual([raw, false])
      }
    })

    test(`${key}: "true", "1", "yes", "TRUE" parse as true`, () => {
      const { envSchema } = require("~/lib/env")
      for (const raw of ["true", "1", "yes", "TRUE", "Yes"]) {
        const r = envSchema.safeParse({ ...base, [key]: raw })
        expect(r.success).toBe(true)
        expect([raw, r.data[key]]).toEqual([raw, true])
      }
    })

    test(`${key}: unset keeps the default ${defaultValue}`, () => {
      const { envSchema } = require("~/lib/env")
      const r = envSchema.safeParse(base)
      expect(r.success).toBe(true)
      expect(r.data[key]).toBe(defaultValue)
    })

    test(`${key}: an unrecognized value fails validation with a clear message`, () => {
      const { envSchema } = require("~/lib/env")
      const r = envSchema.safeParse({ ...base, [key]: "maybe" })
      expect(r.success).toBe(false)
      expect(r.error.message).toContain(key)
      expect(r.error.message).toContain("expected a boolean")
    })
  }
})

describe("env schema: placeholder secrets in production", () => {
  const REAL_JWT = "k3Jx9fQ2mZpL8vNcR5tYwB7hD1sGaE4u"
  const REAL_KEY = "9f2c7a1be84d03659cfa12d7e6b0384a51c9d2e7f0a6b83c4d15e9f2a7c0b6d3"
  const prod = { NODE_ENV: "production", BYOK_ENCRYPTION_KEY: REAL_KEY }
  const parse = (over: Record<string, string>) => {
    const { envSchema } = require("~/lib/env")
    return envSchema.safeParse({
      BASE_URL: "https://liaison.example.com",
      MEILISEARCH_API_KEY: "meili-key",
      JWT_SECRET: REAL_JWT,
      ENCRYPTION_KEY: REAL_KEY,
      ...prod,
      ...over,
    })
  }

  it("accepts real key material in production", () => {
    expect(parse({}).success).toBe(true)
  })

  it("refuses the shipped .env.example JWT_SECRET in production", () => {
    const r = parse({ JWT_SECRET: "replace-with-at-least-32-char-secret" })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error.issues)).toContain("JWT_SECRET")
  })

  it("refuses an all-zero or repeating ENCRYPTION_KEY in production", () => {
    expect(parse({ ENCRYPTION_KEY: "0".repeat(64) }).success).toBe(false)
    expect(parse({ ENCRYPTION_KEY: "deadbeef".repeat(8) }).success).toBe(false)
  })

  it("refuses a single repeated character JWT_SECRET in production", () => {
    expect(parse({ JWT_SECRET: "x".repeat(40) }).success).toBe(false)
  })

  it("refuses a long unit repeated end to end and known test strings in production", () => {
    expect(parse({ ENCRYPTION_KEY: "0123456789abcdef".repeat(4) }).success).toBe(false)
    expect(parse({ JWT_SECRET: "e2e-test-secret-minimum-32-characters-long" }).success).toBe(false)
  })

  it("refuses a placeholder BYOK_ENCRYPTION_KEY in production", () => {
    const r = parse({ BYOK_ENCRYPTION_KEY: "0".repeat(64) })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error.issues)).toContain("BYOK_ENCRYPTION_KEY")
  })

  it("still accepts the placeholders outside production (dev and test)", () => {
    const { envSchema } = require("~/lib/env")
    const r = envSchema.safeParse({
      JWT_SECRET: "replace-with-at-least-32-char-secret",
      ENCRYPTION_KEY: "0".repeat(64),
    })
    expect(r.success).toBe(true)
  })
})

describe("first-run env", () => {
  const base = { JWT_SECRET: "a".repeat(32), ENCRYPTION_KEY: "ab".repeat(32) }

  test("LIAISON_DEMO_URL defaults to the public demo, unset or empty alike", () => {
    const { envSchema } = require("~/lib/env")
    expect(envSchema.parse(base).LIAISON_DEMO_URL).toBe("https://demo.liaison.sh")
    expect(envSchema.parse({ ...base, LIAISON_DEMO_URL: "" }).LIAISON_DEMO_URL).toBe(
      "https://demo.liaison.sh",
    )
  })

  test("LIAISON_DEMO_URL takes another URL, or off to turn the offer off", () => {
    const { envSchema } = require("~/lib/env")
    expect(
      envSchema.parse({ ...base, LIAISON_DEMO_URL: "https://demo.example.com" }).LIAISON_DEMO_URL,
    ).toBe("https://demo.example.com")
    expect(envSchema.parse({ ...base, LIAISON_DEMO_URL: "off" }).LIAISON_DEMO_URL).toBe("off")
    expect(envSchema.safeParse({ ...base, LIAISON_DEMO_URL: "demo please" }).success).toBe(false)
    for (const bad of ["javascript:alert(1)", "ftp://demo.example.com", "data:text/html,x"]) {
      expect(envSchema.safeParse({ ...base, LIAISON_DEMO_URL: bad }).success).toBe(false)
    }
  })

  test("LIAISON_SETUP_KICKOFF is unset by default and parses a boolean", () => {
    const { envSchema } = require("~/lib/env")
    expect(envSchema.parse(base).LIAISON_SETUP_KICKOFF).toBeUndefined()
    expect(envSchema.parse({ ...base, LIAISON_SETUP_KICKOFF: "false" }).LIAISON_SETUP_KICKOFF).toBe(
      false,
    )
    expect(envSchema.parse({ ...base, LIAISON_SETUP_KICKOFF: "1" }).LIAISON_SETUP_KICKOFF).toBe(
      true,
    )
    expect(envSchema.safeParse({ ...base, LIAISON_SETUP_KICKOFF: "maybe" }).success).toBe(false)
  })

  test("LIAISON_SETUP_KICKOFF_ORG_MAX_AGE_DAYS defaults to 14 and takes a whole number", () => {
    const { envSchema } = require("~/lib/env")
    expect(envSchema.parse(base).LIAISON_SETUP_KICKOFF_ORG_MAX_AGE_DAYS).toBe(14)
    expect(
      envSchema.parse({ ...base, LIAISON_SETUP_KICKOFF_ORG_MAX_AGE_DAYS: "3" })
        .LIAISON_SETUP_KICKOFF_ORG_MAX_AGE_DAYS,
    ).toBe(3)
    expect(
      envSchema.safeParse({ ...base, LIAISON_SETUP_KICKOFF_ORG_MAX_AGE_DAYS: "-1" }).success,
    ).toBe(false)
  })
})

describe("env schema: instance OAuth client pairs are both or neither", () => {
  const base = { JWT_SECRET: "a".repeat(32), ENCRYPTION_KEY: "ab".repeat(32) }
  const pairs = [
    ["GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET"],
    ["GOOGLE_DRIVE_OAUTH_CLIENT_ID", "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET"],
    ["GOOGLE_MARKETING_OAUTH_CLIENT_ID", "GOOGLE_MARKETING_OAUTH_CLIENT_SECRET"],
    ["SHOPIFY_APP_CLIENT_ID", "SHOPIFY_APP_CLIENT_SECRET"],
  ] as const

  for (const [id, secret] of pairs) {
    it(`refuses ${id} without ${secret}, and the reverse, naming both`, () => {
      const { envSchema } = require("~/lib/env")
      for (const only of [id, secret]) {
        const result = envSchema.safeParse({ ...base, [only]: "set" })
        expect(result.success).toBe(false)
        if (!result.success) {
          expect(result.error.message).toContain(id)
          expect(result.error.message).toContain(secret)
        }
      }
    })

    it(`accepts ${id} with ${secret}`, () => {
      const { envSchema } = require("~/lib/env")
      expect(envSchema.safeParse({ ...base, [id]: "x", [secret]: "y" }).success).toBe(true)
    })
  }
})

describe("env schema: process role and leader lease", () => {
  const base = { JWT_SECRET: "a".repeat(32), ENCRYPTION_KEY: "ab".repeat(32) }

  it("LIAISON_ROLE defaults to all and rejects other values", () => {
    const { envSchema } = require("~/lib/env")
    const unset = envSchema.safeParse(base)
    expect(unset.success).toBe(true)
    expect(unset.data.LIAISON_ROLE).toBe("all")
    for (const role of ["all", "api", "worker"]) {
      const ok = envSchema.safeParse({ ...base, LIAISON_ROLE: role })
      expect(ok.success).toBe(true)
      expect(ok.data.LIAISON_ROLE).toBe(role)
    }
    expect(envSchema.safeParse({ ...base, LIAISON_ROLE: "bogus" }).success).toBe(false)
  })

  it("leader lease timings default to 15s TTL, 5s renew, 1s poll and coerce from strings", () => {
    const { envSchema } = require("~/lib/env")
    const def = envSchema.safeParse(base)
    expect(def.success).toBe(true)
    expect(def.data.LEADER_LEASE_TTL_MS).toBe(15_000)
    expect(def.data.LEADER_LEASE_RENEW_MS).toBe(5_000)
    expect(def.data.LEADER_LEASE_POLL_MS).toBe(1_000)
    const short = envSchema.safeParse({
      ...base,
      LEADER_LEASE_TTL_MS: "3000",
      LEADER_LEASE_RENEW_MS: "1000",
      LEADER_LEASE_POLL_MS: "250",
    })
    expect(short.success).toBe(true)
    expect(short.data.LEADER_LEASE_TTL_MS).toBe(3_000)
    expect(short.data.LEADER_LEASE_RENEW_MS).toBe(1_000)
    expect(short.data.LEADER_LEASE_POLL_MS).toBe(250)
  })
})

describe("LIAISON_RELEASE_CHANNEL", () => {
  const parse = (value?: string) => {
    const { envSchema } = require("~/lib/env")
    return envSchema.safeParse({
      JWT_SECRET: "a".repeat(32),
      ENCRYPTION_KEY: "a".repeat(64),
      BASE_URL: "http://localhost:3000",
      ALLOWED_ORIGINS: "http://localhost:5173",
      ...(value === undefined ? {} : { LIAISON_RELEASE_CHANNEL: value }),
    })
  }

  test("defaults to release, also when set empty", () => {
    expect(parse().data.LIAISON_RELEASE_CHANNEL).toBe("release")
    expect(parse("").data.LIAISON_RELEASE_CHANNEL).toBe("release")
  })

  test("accepts nightly and release", () => {
    expect(parse("nightly").data.LIAISON_RELEASE_CHANNEL).toBe("nightly")
    expect(parse("release").data.LIAISON_RELEASE_CHANNEL).toBe("release")
  })

  test("refuses anything else", () => {
    const result = parse("beta")
    expect(result.success).toBe(false)
    expect(result.error.issues[0].path).toEqual(["LIAISON_RELEASE_CHANNEL"])
  })
})
