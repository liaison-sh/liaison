// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The signing bridge serves the agreements app only, and touches no database.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { RlsClient } from "~/db"
import { env } from "~/lib/env"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const poisonTx = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined
      throw new Error(`the signing bridge touched txDb.${String(prop)}`)
    },
  },
) as unknown as RlsClient

const ORG = "00000000-0000-0000-0000-00000000c0b1"
const USER = "00000000-0000-0000-0000-00000000c0b2"
const VECTOR = JSON.parse(
  readFileSync(path.join(import.meta.dir, "test-fixtures/seal-vector.json"), "utf8"),
)

function bridgeFor(app: string) {
  return createRpcBridge(app, USER, ORG, poisonTx, { name: app })
}

describe("signing bridge callers", () => {
  it("another app calling the signing bridge is refused", async () => {
    for (const app of ["invoicing", "projects", "agreements-o12345678", "agreement"]) {
      const bridge = bridgeFor(app)
      await expect(bridge.signing_seal(JSON.stringify(VECTOR.input))).rejects.toThrow(
        "only available to the agreements app",
      )
      await expect(bridge.signing_timestamp(JSON.stringify({ manifest: {} }))).rejects.toThrow(
        "only available to the agreements app",
      )
    }
  })

  it("the agreements app gets the seal of the fixed vector", async () => {
    const out = JSON.parse(await bridgeFor("agreements").signing_seal(JSON.stringify(VECTOR.input)))
    expect(out.seal).toBe(VECTOR.seal)
    expect(out.manifestJson).toBe(VECTOR.canonicalManifest)
    expect({ hashAlg: out.hashAlg, sealVersion: out.sealVersion }).toEqual({
      hashAlg: "sha256",
      sealVersion: 1,
    })
  })

  it("the seal computes the trail hash itself when handed the trail", async () => {
    const out = JSON.parse(
      await bridgeFor("agreements").signing_seal(
        JSON.stringify({ ...VECTOR.input, trailSha256: undefined, trail: [{ b: 1, a: 2 }] }),
      ),
    )
    expect(out.trailSha256).toBe(
      new Bun.CryptoHasher("sha256").update('[{"a":2,"b":1}]').digest("hex"),
    )
  })

  it("with no authority configured the stamp answers TIMESTAMP_NOT_CONFIGURED and stamps nothing", async () => {
    expect(env.LIAISON_TSA_URL).toBeUndefined()
    const sealed = JSON.parse(
      await bridgeFor("agreements").signing_seal(JSON.stringify(VECTOR.input)),
    )
    const out = JSON.parse(
      await bridgeFor("agreements").signing_timestamp(
        JSON.stringify({ manifest: sealed.manifest }),
      ),
    )
    expect(out).toMatchObject({
      status: "not_configured",
      code: "TIMESTAMP_NOT_CONFIGURED",
      seal: VECTOR.seal,
    })
    expect(out.message).toContain("Nothing was stamped")
  })

  it("the stamp refuses a manifest that is not exactly a seal manifest", async () => {
    const bridge = bridgeFor("agreements")
    await expect(
      bridge.signing_timestamp(JSON.stringify({ manifest: { v: 1, hash: "sha256" } })),
    ).rejects.toThrow("manifest fields must be exactly")
  })
})
