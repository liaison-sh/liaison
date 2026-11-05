// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { getClient } from "./get-client"

const fullMap = {
  v1Key: "u1",
  v1Secret: "s1",
  v3Key: "k3",
  v3Secret: "s3",
  environment: "sandbox",
}

const fetchStub = async () => ({ status: 200, headers: {}, body: "" })

/** RECORD shape: `ctx.connections.boxtal.getCredentials(id?)` (SDK type / mock). */
function recordCtx(map: Record<string, string> | null) {
  return {
    fetch: fetchStub,
    connections: {
      boxtal: {
        getCredentials: async () => (map === null ? {} : map),
        getToken: async () => {
          throw new Error("No access token stored")
        },
        getAccounts: async () => [],
      },
    },
  } as any
}

/** FLAT shape: `ctx.connections.getCredentials(name, id?)` (sandbox bridge). */
function flatCtx(map: Record<string, string> | null) {
  return {
    fetch: fetchStub,
    connections: {
      getCredentials: async (_name: string) => (map === null ? {} : map),
      getToken: async () => {
        throw new Error("No access token stored")
      },
      getAccounts: async () => [],
    },
  } as any
}

describe("getClient (Boxtal facade)", () => {
  it("builds both clients from the RECORD-shape connection", async () => {
    const { v1, v3, environment } = await getClient(recordCtx(fullMap))
    expect(environment).toBe("sandbox")
    expect(v1).toBeDefined()
    expect(v3).toBeDefined()
  })

  it("builds both clients from the FLAT-shape connection", async () => {
    const { environment } = await getClient(flatCtx(fullMap))
    expect(environment).toBe("sandbox")
  })

  it("reads the production environment from the credential map", async () => {
    const { environment } = await getClient(
      recordCtx({ ...fullMap, environment: "production" }),
    )
    expect(environment).toBe("production")
  })

  it("throws 'Boxtal not connected' when the credential map is empty", async () => {
    await expect(getClient(recordCtx({}))).rejects.toThrow("Boxtal not connected")
  })

  it("throws 'Boxtal not connected' when the connection accessor is absent", async () => {
    const ctx = { fetch: fetchStub, connections: {} } as any
    await expect(getClient(ctx)).rejects.toThrow("Boxtal not connected")
  })

  it("throws 'Boxtal credentials incomplete' when a required key is missing", async () => {
    const partial = { v1Key: "u1", v3Key: "k3", environment: "sandbox" }
    await expect(getClient(recordCtx(partial))).rejects.toThrow(
      "Boxtal credentials incomplete",
    )
  })

  it("rejects an invalid environment value", async () => {
    await expect(
      getClient(recordCtx({ ...fullMap, environment: "staging" })),
    ).rejects.toThrow()
  })
})
