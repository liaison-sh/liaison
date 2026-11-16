// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The RFC 3161 exchange against a local authority (openssl `ts -reply`, CA made
// at test start). Each refusal changes one thing against a reply the verifier
// otherwise accepts, so a refusal proves that one check.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { computeSeal } from "~/modules/signing/seal"
import {
  createFixtureAuthority,
  FIXTURE_POLICY_OID,
  type FixtureAuthority,
} from "~/modules/signing/test-fixtures/tsa/authority"
import { forgeReply } from "~/modules/signing/test-fixtures/tsa/forge"
import {
  buildTimestampRequest,
  certificateSha256,
  parseCertificatesPem,
  requestTimestamp,
  type TimestampRefusal,
  TimestampRefusedError,
  type TsaConfig,
  verifyTimestampReply,
} from "~/modules/signing/timestamp"

const H = (c: string) => c.repeat(64)
const sealed = computeSeal({
  documentSha256: H("a"),
  signedPdfSha256: H("b"),
  trailSha256: H("c"),
  level: "simple",
  agreement: "AGR-0001",
  version: 1,
})
const manifestBytes = sealed.manifestBytes
const seal = new Uint8Array(Buffer.from(sealed.seal, "hex"))
const NONCE = 0xfedcba9876543210n

let authority: FixtureAuthority
let server: Awaited<ReturnType<FixtureAuthority["serve"]>>

beforeAll(async () => {
  authority = createFixtureAuthority()
  server = await authority.serve()
})

afterAll(() => {
  server?.stop()
  authority?.cleanup()
})

function trust() {
  return parseCertificatesPem(authority.chainPem)
}

function config(over: Partial<TsaConfig> = {}): TsaConfig {
  return { url: server.url, trust: trust(), allowPrivate: true, ...over }
}

async function refusalOf(
  reply: Uint8Array,
  over: Partial<Parameters<typeof verifyTimestampReply>[1]> = {},
): Promise<TimestampRefusal | "accepted"> {
  try {
    await verifyTimestampReply(reply, {
      seal,
      manifestBytes,
      nonce: NONCE,
      trust: trust(),
      now: Date.now(),
      ...over,
    })
    return "accepted"
  } catch (err) {
    if (err instanceof TimestampRefusedError) return err.refusal
    throw err
  }
}

const query = () => buildTimestampRequest(seal, NONCE)

describe("timestamp request", () => {
  it("is a v1 request with a SHA-256 imprint of the seal, a 64-bit nonce and certReq", () => {
    const bytes = buildTimestampRequest(seal, NONCE)
    const der = Buffer.from(bytes).toString("hex")
    expect(der.startsWith("30")).toBe(true)
    // version INTEGER 1, then the SHA-256 OID, then the seal as the hashed message
    expect(der).toContain("020101")
    expect(der).toContain("0609608648016503040201")
    expect(der).toContain(`0420${sealed.seal}`)
    // nonce: 8 bytes with a leading zero because the top bit is set, then certReq TRUE
    expect(der).toContain("020900fedcba9876543210")
    expect(der.endsWith("0101ff")).toBe(true)
  })
})

describe("timestamp verify against the local authority", () => {
  it("a granted response is accepted and its genTime read", async () => {
    const before = Date.now()
    const out = await requestTimestamp({ manifestBytes, config: config() })
    expect(out.status).toBe("stamped")
    if (out.status !== "stamped") return
    expect(Math.abs(out.genTime.getTime() - before)).toBeLessThan(60_000)
    expect(out.policy).toBe(FIXTURE_POLICY_OID)
    expect(out.signerCertSha256).toBe(certificateSha256(authority.tsa.cert))
    expect(out.chainSha256.at(-1)).toBe(certificateSha256(trust()[0]!))
    expect(out.reply.byteLength).toBeGreaterThan(500)
  })

  it("a forged imprint, a wrong nonce, a bad signature, a rejection status and a certificate without the critical time-stamping usage are each refused against the local authority", async () => {
    const cases: Array<[Parameters<typeof server.setMode>[0], TimestampRefusal]> = [
      ["other-imprint", "imprint_mismatch"],
      ["other-nonce", "nonce_mismatch"],
      ["bad-signature", "signature"],
      ["rejection", "rejected_status"],
      ["garbage", "malformed"],
    ]
    for (const [mode, refusal] of cases) {
      server.setMode(mode)
      const out = await requestTimestamp({ manifestBytes, config: config() })
      expect({ mode, status: out.status, refused: out.status === "pending" && out.reason }).toEqual(
        { mode, status: "pending", refused: "refused" },
      )
      expect(out.status === "pending" && out.detail).toContain(`(${refusal})`)
    }
    server.setMode("ok")

    const nonCritical = authority.ca.issueTsa("noncritical", { criticalEku: false })
    const forged = await forgeReply({
      signer: nonCritical,
      seal,
      nonce: NONCE,
      genTime: new Date(),
    })
    expect(await refusalOf(forged)).toBe("eku")
  })

  it("an accepted reply also passes openssl ts -verify over the manifest with only the configured chain", async () => {
    const out = await requestTimestamp({ manifestBytes, config: config() })
    expect(out.status).toBe("stamped")
    if (out.status !== "stamped") return
    const dir = authority.ca.dir
    writeFileSync(path.join(dir, "check-manifest.json"), manifestBytes)
    writeFileSync(path.join(dir, "check-reply.tsr"), out.reply)
    const r = spawnSync(
      "openssl",
      [
        "ts",
        "-verify",
        "-data",
        "check-manifest.json",
        "-in",
        "check-reply.tsr",
        "-CAfile",
        "root.pem",
      ],
      { cwd: dir, encoding: "utf8" },
    )
    expect(`${r.stdout}${r.stderr}`).toContain("Verification: OK")
  })

  it("the forged control reply is accepted, so each forged refusal is its one change", async () => {
    const forged = await forgeReply({
      signer: authority.tsa,
      seal,
      nonce: NONCE,
      genTime: new Date(),
    })
    expect(await refusalOf(forged)).toBe("accepted")
  })

  it("a reply from openssl for our own query is accepted, and the same reply checked for another seal or nonce is refused", async () => {
    const reply = authority.reply(query())
    expect(await refusalOf(reply)).toBe("accepted")
    expect(await refusalOf(reply, { nonce: NONCE + 1n })).toBe("nonce_mismatch")
    expect(await refusalOf(reply, { seal: new Uint8Array(32) })).toBe("imprint_mismatch")
  })

  it("a token from a CA outside the configured chain, with that CA embedded in the token, is refused", async () => {
    const foreign = authority.foreignCa()
    const reply = authority.reply(query(), {
      signer: foreign.tsa,
      chainFile: foreign.ca.root.certPath,
    })
    expect(await refusalOf(reply)).toBe("chain")
    // The same token is good under its own root: only the trust decides.
    expect(await refusalOf(reply, { trust: [foreign.ca.root.cert] })).toBe("accepted")
  })

  it("a signer certificate expired or not yet valid at genTime is refused", async () => {
    const day = 24 * 3600 * 1000
    const expired = authority.ca.issueTsa("expired", {
      notBefore: new Date(Date.now() - 30 * day),
      notAfter: new Date(Date.now() - 2 * day),
    })
    const future = authority.ca.issueTsa("future", {
      notBefore: new Date(Date.now() + 2 * day),
      notAfter: new Date(Date.now() + 30 * day),
    })
    expect(await refusalOf(authority.reply(query(), { signer: expired }))).toBe(
      "signer_not_valid_at_gen_time",
    )
    expect(await refusalOf(authority.reply(query(), { signer: future }))).toBe(
      "signer_not_valid_at_gen_time",
    )
  })

  it("a token whose imprint uses another hash algorithm with the same bytes is refused", async () => {
    const sha3_256 = "2.16.840.1.101.3.4.2.8"
    const forged = await forgeReply({
      signer: authority.tsa,
      seal,
      nonce: NONCE,
      genTime: new Date(),
      imprintAlgorithm: sha3_256,
    })
    expect(await refusalOf(forged)).toBe("imprint_algorithm")
  })

  it("a SignedData whose content type is not TSTInfo is refused", async () => {
    const idData = "1.2.840.113549.1.7.1"
    const forged = await forgeReply({
      signer: authority.tsa,
      seal,
      nonce: NONCE,
      genTime: new Date(),
      eContentType: idData,
    })
    expect(await refusalOf(forged)).toBe("not_tstinfo")
  })

  it("a signing-certificate attribute naming another certificate, or a signed content type other than TSTInfo, is refused", async () => {
    const base = { signer: authority.tsa, seal, nonce: NONCE, genTime: new Date() }
    const other = authority.ca.issueTsa("other")
    expect(await refusalOf(await forgeReply({ ...base, essNames: other.cert }))).toBe("ess_cert_id")
    expect(
      await refusalOf(await forgeReply({ ...base, contentTypeAttribute: "1.2.840.113549.1.7.1" })),
    ).toBe("content_type_attribute")
  })

  it("a genTime more than 5 minutes from the product clock is refused, within it accepted", async () => {
    const reply = authority.reply(query())
    expect(await refusalOf(reply, { now: Date.now() + 6 * 60_000 })).toBe("gen_time_skew")
    expect(await refusalOf(reply, { now: Date.now() - 6 * 60_000 })).toBe("gen_time_skew")
    expect(await refusalOf(reply, { now: Date.now() + 4 * 60_000 })).toBe("accepted")
  })

  it("the stamp compares genTime with the product clock it is given, not the host clock", async () => {
    const out = await requestTimestamp({
      manifestBytes,
      config: config(),
      now: () => Date.now() + 24 * 3600 * 1000,
    })
    expect(out.status === "pending" && out.detail).toContain("(gen_time_skew)")
  })

  it("a reply with trailing bytes after its DER value is refused", async () => {
    const reply = authority.reply(query())
    const padded = new Uint8Array(reply.byteLength + 1)
    padded.set(reply)
    expect(await refusalOf(padded)).toBe("malformed")
  })

  it("no configured anchor refuses every reply", async () => {
    expect(await refusalOf(authority.reply(query()), { trust: [] })).toBe("chain")
  })

  it("a private TSA URL is refused without the switch", async () => {
    const out = await requestTimestamp({ manifestBytes, config: config({ allowPrivate: false }) })
    expect(out.status).toBe("pending")
    expect(out.status === "pending" && out.reason).toBe("unreachable")
    expect(out.status === "pending" && out.detail).toContain("private")
  })

  it("an HTTP error from the authority leaves the stamp pending", async () => {
    server.setMode("http-500")
    const out = await requestTimestamp({ manifestBytes, config: config() })
    server.setMode("ok")
    expect(out.status === "pending" && out.reason).toBe("http_error")
  })

  it("an authority slower than 10 seconds leaves the stamp pending", async () => {
    server.setMode("slow")
    const out = await requestTimestamp({ manifestBytes, config: config() })
    server.setMode("ok")
    expect(out.status === "pending" && out.reason).toBe("timeout")
  }, 20_000)

  it("the stamped message is the canonical manifest: its SHA-256 is the seal", () => {
    expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(sealed.seal)
  })
})
