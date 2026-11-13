// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Google config is the `google-config` connection's READABLE settings
// (getSettings), and the Google credential is a host-side `ctx.fetch` auth of
// a connected OAuth2 account (getAccounts): no token or developer token ever
// reaches the app.
import { describe, expect, it } from "bun:test"
import { oneAccount, settingsFor } from "../test-connections.testutil"
import {
  GoogleConfigError,
  getGoogleAuth,
  getGoogleClient,
  getGoogleConfig,
  getMerchantAuth,
} from "./google-config"

const STORED = {
  loginCustomerId: "999-888-7777",
  customerId: "123-456-7890",
  merchantId: "mc-12-34",
  developerToken: "legacy_dev_tok",
}

describe("getGoogleConfig", () => {
  it("reads the FLAT shape's JSON answer and strips dashes from the customer ids, not the merchant id", async () => {
    const seen: string[] = []
    const ctx = {
      connections: {
        getSettings: async (name: string) => {
          seen.push(name)
          return JSON.stringify(settingsFor("google-config", STORED))
        },
      },
    }
    expect(await getGoogleConfig(ctx)).toEqual({
      loginCustomerId: "9998887777",
      customerId: "1234567890",
      merchantId: "mc-12-34",
    })
    expect(seen).toEqual(["google-config"])
  })

  it("reads the RECORD shape; a legacy developer token is never surfaced", async () => {
    const ctx = {
      connections: {
        "google-config": { getSettings: async () => settingsFor("google-config", STORED) },
      },
    }
    const config = await getGoogleConfig(ctx)
    expect(JSON.stringify(config)).not.toContain("legacy_dev_tok")
    expect(config.customerId).toBe("1234567890")
  })

  it("accepts a config without a merchant id or developer token", async () => {
    const ctx = {
      connections: {
        "google-config": {
          getSettings: async () =>
            settingsFor("google-config", { loginCustomerId: "1", customerId: "2" }),
        },
      },
    }
    expect(await getGoogleConfig(ctx)).toEqual({
      loginCustomerId: "1",
      customerId: "2",
      merchantId: "",
    })
  })

  it("throws GoogleConfigError when not connected, unreadable, empty or incomplete", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{}, /Google not configured/],
      [{ getSettings: async () => null }, /Google not configured/],
      [
        {
          getSettings: async () => {
            throw new Error("boom")
          },
        },
        /could not be read/,
      ],
      [{ getSettings: async () => settingsFor("google-config", {}) }, /config is empty/],
      [
        { getSettings: async () => settingsFor("google-config", { loginCustomerId: "1" }) },
        /incomplete, missing: customerId/,
      ],
    ]
    for (const [connections, message] of cases) {
      const err = await getGoogleConfig({ connections }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(GoogleConfigError)
      expect((err as Error).message).toMatch(message)
      expect((err as Error).message).not.toContain("developer")
    }
  })
})

describe("getGoogleAuth", () => {
  it("names the google connection when it has an active account (both shapes)", async () => {
    const flat = { connections: { getAccounts: async () => JSON.stringify(oneAccount()) } }
    expect(await getGoogleAuth(flat)).toEqual({ connection: "google", scheme: "bearer" })
    const record = { connections: { google: { getAccounts: async () => oneAccount() } } }
    expect(await getGoogleAuth(record)).toEqual({ connection: "google", scheme: "bearer" })
  })

  it("returns null with no account, a throwing host or no accessor", async () => {
    expect(await getGoogleAuth({ connections: { getAccounts: async () => [] } })).toBeNull()
    expect(
      await getGoogleAuth({
        connections: {
          getAccounts: async () => {
            throw new Error("No connected account")
          },
        },
      }),
    ).toBeNull()
    expect(await getGoogleAuth({ connections: {} })).toBeNull()
  })
})

describe("getGoogleClient", () => {
  it("returns the credential and the config together", async () => {
    const ctx = {
      connections: {
        google: { getAccounts: async () => oneAccount() },
        "google-config": { getSettings: async () => settingsFor("google-config", STORED) },
      },
    }
    const client = await getGoogleClient(ctx)
    expect(client.auth).toEqual({ connection: "google", scheme: "bearer" })
    expect(client.config.customerId).toBe("1234567890")
  })

  it("throws GoogleConfigError when the OAuth account or the config is absent", async () => {
    await expect(
      getGoogleClient({
        connections: {
          "google-config": { getSettings: async () => settingsFor("google-config", STORED) },
        },
      }),
    ).rejects.toBeInstanceOf(GoogleConfigError)
    await expect(
      getGoogleClient({ connections: { google: { getAccounts: async () => oneAccount() } } }),
    ).rejects.toBeInstanceOf(GoogleConfigError)
  })
})

describe("getMerchantAuth — dedicated merchant connection with google fallback", () => {
  it("prefers a connected merchant account, else falls back to google, else null", async () => {
    const both = {
      connections: {
        merchant: { getAccounts: async () => oneAccount() },
        google: { getAccounts: async () => oneAccount() },
      },
    }
    expect(await getMerchantAuth(both)).toEqual({ connection: "merchant", scheme: "bearer" })
    const googleOnly = {
      connections: {
        merchant: {
          getAccounts: async () => {
            throw new Error("stale")
          },
        },
        google: { getAccounts: async () => oneAccount() },
      },
    }
    expect(await getMerchantAuth(googleOnly)).toEqual({ connection: "google", scheme: "bearer" })
    expect(await getMerchantAuth({ connections: {} })).toBeNull()
  })
})
