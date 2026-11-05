// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { ToolError } from "@liaison/app-sdk"
import { getMetaClient, MetaConnectionError } from "./lib/get-client"

// ─── Not connected must reach the caller (sandbox boundary) ─────────────────
//
// The ads app runs untrusted. Across the sandbox only a ToolError keeps its
// message and code (the worker keys on own fields name === "ToolError", safe,
// code); any other throw is redacted to "Tool execution failed", so the
// dashboard read a fresh install as a Meta outage.

describe("MetaConnectionError crosses the sandbox as a safe ToolError", () => {
  it("not connected rejects with a safe ToolError coded meta_not_connected", async () => {
    const err = await getMetaClient({ connections: {} }).catch((e) => e)
    expect(err).toBeInstanceOf(MetaConnectionError)
    expect(err).toBeInstanceOf(ToolError)
    expect(err.name).toBe("ToolError")
    expect(err.safe).toBe(true)
    expect(err.code).toBe("meta_not_connected")
  })

  it("surfaced messages carry no dash punctuation and no inner exception text", async () => {
    const unreadable = await getMetaClient({
      connections: { meta: { getCredentials: async () => { throw new Error("pg: relation secret_store missing") } } },
    }).catch((e) => e)
    expect(unreadable).toBeInstanceOf(MetaConnectionError)
    expect(unreadable.message).not.toContain("secret_store")
    for (const ctx of [{ connections: {} }, { connections: { meta: { getCredentials: async () => ({}) } } }]) {
      const err = await getMetaClient(ctx).catch((e) => e)
      expect(err.message).not.toMatch(/[–—]|--/)
    }
    expect(unreadable.message).not.toMatch(/[–—]|--/)
  })
})

// ─── FLAT shape (sandbox bridge group) ───────────────────────────────────────

describe("getMetaClient — FLAT shape (getCredentials(name))", () => {
  it("resolves when flat.getCredentials returns a JSON STRING", async () => {
    const ctx = {
      connections: {
        getCredentials: async (name: string) => {
          if (name === "meta") {
            return JSON.stringify({
              accessToken: "flat_token_123",
              adAccountId: "act_999888777",
              defaultPageId: "page_42",
            })
          }
          return null
        },
      },
    }
    const creds = await getMetaClient(ctx)
    expect(creds.accessToken).toBe("flat_token_123")
    expect(creds.adAccountId).toBe("act_999888777")
    expect(creds.defaultPageId).toBe("page_42")
  })

  it("resolves when flat.getCredentials returns an OBJECT (not a string)", async () => {
    const ctx = {
      connections: {
        getCredentials: async (name: string) => {
          if (name === "meta") {
            return {
              accessToken: "flat_obj_token",
              adAccountId: "act_111222333",
            }
          }
          return null
        },
      },
    }
    const creds = await getMetaClient(ctx)
    expect(creds.accessToken).toBe("flat_obj_token")
    expect(creds.adAccountId).toBe("act_111222333")
  })
})

// ─── RECORD shape (SDK type / unit-test mock) ─────────────────────────────────

describe("getMetaClient — RECORD shape (meta.getCredentials())", () => {
  it("resolves when record.meta.getCredentials returns an OBJECT", async () => {
    const ctx = {
      connections: {
        meta: {
          getCredentials: async () => ({
            accessToken: "record_token_xyz",
            adAccountId: "act_444555666",
          }),
        },
      },
    }
    const creds = await getMetaClient(ctx)
    expect(creds.accessToken).toBe("record_token_xyz")
    expect(creds.adAccountId).toBe("act_444555666")
  })

  it("resolves when record.meta.getCredentials returns a JSON STRING", async () => {
    const ctx = {
      connections: {
        meta: {
          getCredentials: async () =>
            JSON.stringify({ accessToken: "record_str_token", adAccountId: "act_777888999" }),
        },
      },
    }
    const creds = await getMetaClient(ctx)
    expect(creds.accessToken).toBe("record_str_token")
    expect(creds.adAccountId).toBe("act_777888999")
  })
})

// ─── Missing connection ────────────────────────────────────────────────────────

describe("getMetaClient — missing connection", () => {
  it("throws MetaConnectionError when connections has neither flat nor record shape", async () => {
    const ctx = { connections: {} }
    await expect(getMetaClient(ctx)).rejects.toBeInstanceOf(MetaConnectionError)
  })

  it("throws MetaConnectionError when flat.getCredentials returns null", async () => {
    const ctx = {
      connections: {
        getCredentials: async () => null,
      },
    }
    await expect(getMetaClient(ctx)).rejects.toBeInstanceOf(MetaConnectionError)
  })

  it("throws MetaConnectionError when credentials are empty object", async () => {
    const ctx = {
      connections: {
        meta: {
          getCredentials: async () => ({}),
        },
      },
    }
    await expect(getMetaClient(ctx)).rejects.toBeInstanceOf(MetaConnectionError)
  })

  it("throws MetaConnectionError with 'incomplete' message when accessToken is missing", async () => {
    const ctx = {
      connections: {
        meta: {
          getCredentials: async () => ({ adAccountId: "act_123" }),
        },
      },
    }
    const err = await getMetaClient(ctx).catch((e) => e)
    expect(err).toBeInstanceOf(MetaConnectionError)
    expect(err.message).toContain("incomplete")
    expect(err.message).toContain("accessToken")
  })
})

// ─── adAccountId normalization ─────────────────────────────────────────────────

describe("getMetaClient — adAccountId normalization", () => {
  it("accepts a bare numeric id and prefixes act_", async () => {
    const ctx = {
      connections: {
        meta: {
          getCredentials: async () => ({
            accessToken: "tok",
            adAccountId: "123456789",   // bare numeric, no act_ prefix
          }),
        },
      },
    }
    const creds = await getMetaClient(ctx)
    expect(creds.adAccountId).toBe("act_123456789")
  })

  it("passes through an already-prefixed act_<id> unchanged", async () => {
    const ctx = {
      connections: {
        meta: {
          getCredentials: async () => ({
            accessToken: "tok",
            adAccountId: "act_987654321",
          }),
        },
      },
    }
    const creds = await getMetaClient(ctx)
    expect(creds.adAccountId).toBe("act_987654321")
  })
})
