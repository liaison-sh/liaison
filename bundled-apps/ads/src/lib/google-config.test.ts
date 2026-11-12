// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  GoogleConfigError,
  getGoogleClient,
  getGoogleConfig,
  getGoogleToken,
  getMerchantToken,
} from "./google-config"

// ─── FLAT shape (sandbox bridge group) ───────────────────────────────────────

describe("getGoogleConfig — FLAT shape (getCredentials(name))", () => {
  it("resolves when flat.getCredentials returns a JSON STRING", async () => {
    const ctx = {
      connections: {
        getCredentials: async (name: string) => {
          if (name === "google-config") {
            return JSON.stringify({
              developerToken: "dev_tok_123",
              loginCustomerId: "123-456-7890",
              customerId: "111-222-3333",
              merchantId: "mc_999",
            })
          }
          return null
        },
      },
    }
    const cfg = await getGoogleConfig(ctx)
    expect(cfg).not.toHaveProperty("developerToken")
    // Dashes stripped from customer ids
    expect(cfg.loginCustomerId).toBe("1234567890")
    expect(cfg.customerId).toBe("1112223333")
    expect(cfg.merchantId).toBe("mc_999")
  })

  it("resolves when flat.getCredentials returns an OBJECT (not a string)", async () => {
    const ctx = {
      connections: {
        getCredentials: async (name: string) => {
          if (name === "google-config") {
            return {
              developerToken: "dev_tok_obj",
              loginCustomerId: "1112223333",
              customerId: "4445556666",
              merchantId: "mc_1",
            }
          }
          return null
        },
      },
    }
    const cfg = await getGoogleConfig(ctx)
    expect(cfg).not.toHaveProperty("developerToken")
    expect(cfg.loginCustomerId).toBe("1112223333")
  })
})

// ─── RECORD shape (SDK type / unit-test mock) ─────────────────────────────────

describe("getGoogleConfig — RECORD shape (google-config.getCredentials())", () => {
  it("resolves when record['google-config'].getCredentials returns an OBJECT", async () => {
    const ctx = {
      connections: {
        "google-config": {
          getCredentials: async () => ({
            developerToken: "dev_tok_rec",
            loginCustomerId: "9998887777",
            customerId: "1231231234",
            merchantId: "mc_2",
          }),
        },
      },
    }
    const cfg = await getGoogleConfig(ctx)
    expect(cfg).not.toHaveProperty("developerToken")
    expect(cfg.merchantId).toBe("mc_2")
  })

  it("resolves when record['google-config'].getCredentials returns a JSON STRING", async () => {
    const ctx = {
      connections: {
        "google-config": {
          getCredentials: async () =>
            JSON.stringify({
              developerToken: "dev_tok_str",
              loginCustomerId: "5556667777",
              customerId: "8889990000",
              merchantId: "mc_3",
            }),
        },
      },
    }
    const cfg = await getGoogleConfig(ctx)
    expect(cfg).not.toHaveProperty("developerToken")
  })
})

// ─── Missing connection — actionable connect-error ────────────────────────────

describe("getGoogleConfig — missing connection", () => {
  it("throws GoogleConfigError when connections has neither flat nor record shape", async () => {
    const ctx = { connections: {} }
    await expect(getGoogleConfig(ctx)).rejects.toBeInstanceOf(GoogleConfigError)
  })

  it("throws GoogleConfigError when flat.getCredentials returns null", async () => {
    const ctx = { connections: { getCredentials: async () => null } }
    const err = await getGoogleConfig(ctx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleConfigError)
    expect((err as Error).message).toContain("Google not configured")
  })

  it("throws GoogleConfigError when credentials are empty object", async () => {
    const ctx = {
      connections: { "google-config": { getCredentials: async () => ({}) } },
    }
    await expect(getGoogleConfig(ctx)).rejects.toBeInstanceOf(GoogleConfigError)
  })

  it("accepts a config WITHOUT developerToken (Google retired developer tokens on 2026-09-09)", async () => {
    const ctx = {
      connections: {
        "google-config": {
          getCredentials: async () => ({
            loginCustomerId: "111-222-3333",
            customerId: "4445556666",
          }),
        },
      },
    }
    const cfg = await getGoogleConfig(ctx)
    expect(cfg).not.toHaveProperty("developerToken")
    expect(cfg.loginCustomerId).toBe("1112223333")
    expect(cfg.customerId).toBe("4445556666")
  })

  it("keeps accepting an existing config that still carries a legacy developerToken (read without error, never surfaced)", async () => {
    const ctx = {
      connections: {
        "google-config": {
          getCredentials: async () => ({
            developerToken: "old_tok",
            loginCustomerId: "1112223333",
            customerId: "4445556666",
          }),
        },
      },
    }
    const cfg = await getGoogleConfig(ctx)
    expect(cfg).not.toHaveProperty("developerToken")
  })

  it("throws GoogleConfigError with 'incomplete' + field name when customerId is missing, never asking for a developer token", async () => {
    const ctx = {
      connections: {
        "google-config": {
          getCredentials: async () => ({ loginCustomerId: "1112223333" }),
        },
      },
    }
    const err = await getGoogleConfig(ctx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleConfigError)
    expect((err as Error).message).toContain("incomplete")
    expect((err as Error).message).toContain("customerId")
    expect((err as Error).message).not.toContain("developerToken")
  })
})

// ─── Dash stripping ────────────────────────────────────────────────────────────

describe("getGoogleConfig — dash stripping on customer ids", () => {
  it("strips dashes from loginCustomerId and customerId but NOT merchantId", async () => {
    const ctx = {
      connections: {
        "google-config": {
          getCredentials: async () => ({
            developerToken: "tok",
            loginCustomerId: "123-456-7890",
            customerId: "999-888-7777",
            merchantId: "mc-alpha-1",
          }),
        },
      },
    }
    const cfg = await getGoogleConfig(ctx)
    expect(cfg.loginCustomerId).toBe("1234567890")
    expect(cfg.customerId).toBe("9998887777")
    // merchantId is a Merchant Center account id, not a dashed Google Ads
    // customer id — never mangle it.
    expect(cfg.merchantId).toBe("mc-alpha-1")
  })
})

// ─── getGoogleToken — dual shape (FLAT / RECORD) ───────────────────────────────

describe("getGoogleToken", () => {
  it("resolves via FLAT shape connections.getToken('google')", async () => {
    const ctx = {
      connections: {
        getToken: async (name: string) => (name === "google" ? "oauth_flat_tok" : ""),
      },
    }
    expect(await getGoogleToken(ctx)).toBe("oauth_flat_tok")
  })

  it("resolves via RECORD shape connections.google.getToken()", async () => {
    const ctx = { connections: { google: { getToken: async () => "oauth_rec_tok" } } }
    expect(await getGoogleToken(ctx)).toBe("oauth_rec_tok")
  })

  it("returns null when the connection throws (no connected account)", async () => {
    const ctx = {
      connections: {
        google: {
          getToken: async () => {
            throw new Error("No connected account")
          },
        },
      },
    }
    expect(await getGoogleToken(ctx)).toBeNull()
  })

  it("returns null when neither shape is present", async () => {
    expect(await getGoogleToken({ connections: {} })).toBeNull()
  })
})

// ─── getGoogleClient — combined token + config resolver ───────────────────────

describe("getGoogleClient", () => {
  it("returns both token and config when both connections are present", async () => {
    const ctx = {
      connections: {
        google: { getToken: async () => "oauth_tok" },
        "google-config": {
          getCredentials: async () => ({
            developerToken: "dev",
            loginCustomerId: "1112223333",
            customerId: "4445556666",
            merchantId: "mc_1",
          }),
        },
      },
    }
    const { token, config } = await getGoogleClient(ctx)
    expect(token).toBe("oauth_tok")
    expect(config.customerId).toBe("4445556666")
    expect(config).not.toHaveProperty("developerToken")
  })

  it("throws GoogleConfigError when the google OAuth connection is absent (never a crash)", async () => {
    const ctx = { connections: {} }
    await expect(getGoogleClient(ctx)).rejects.toBeInstanceOf(GoogleConfigError)
  })

  it("throws GoogleConfigError when the token resolves but google-config is absent", async () => {
    const ctx = { connections: { google: { getToken: async () => "oauth_tok" } } }
    await expect(getGoogleClient(ctx)).rejects.toBeInstanceOf(GoogleConfigError)
  })
})

describe("getMerchantToken — dedicated merchant connection with google fallback", () => {
  it("prefers the dedicated merchant connection's token when connected", async () => {
    const ctx = {
      connections: {
        google: { getToken: async () => "ads_tok" },
        merchant: { getToken: async () => "merchant_tok" },
      },
    }
    expect(await getMerchantToken(ctx)).toBe("merchant_tok")
  })

  it("falls back to the main google connection when merchant is absent (single-account orgs consent once)", async () => {
    const ctx = { connections: { google: { getToken: async () => "ads_tok" } } }
    expect(await getMerchantToken(ctx)).toBe("ads_tok")
  })

  it("falls back to google when the merchant connection getToken throws (stale/disconnected)", async () => {
    const ctx = {
      connections: {
        google: { getToken: async () => "ads_tok" },
        merchant: {
          getToken: async () => {
            throw new Error("No connected account")
          },
        },
      },
    }
    expect(await getMerchantToken(ctx)).toBe("ads_tok")
  })

  it("returns null when neither connection has a token", async () => {
    const ctx = { connections: {} }
    expect(await getMerchantToken(ctx)).toBeNull()
  })
})
