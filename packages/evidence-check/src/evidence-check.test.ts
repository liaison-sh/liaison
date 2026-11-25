// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { bundlePageScript, GENERATED, generatedSource } from "../build"
import {
  base64ToBytes,
  canonicalManifestBytes,
  checkFile,
  checkPackage,
  type EvidenceData,
  type Hasher,
  type Manifest,
  parseManifest,
  pickHasher,
  readTimestampReply,
  recomputeSeal,
} from "./check"
import { PAGE_SCRIPT_SHA256_BASE64 } from "./generated/page-script"
import { buildCheckPage, CHECK_PAGE_CSP, PAGE_SCRIPT } from "./index"

const VECTOR = JSON.parse(
  readFileSync(
    path.join(
      import.meta.dir,
      "../../../apps/api/src/modules/signing/test-fixtures/seal-vector.json",
    ),
    "utf8",
  ),
) as {
  input: {
    documentSha256: string
    signedPdfSha256: string
    trailSha256: string
    level: string
    agreement: string
    version: number
  }
  canonicalManifest: string
  seal: string
}

const webcrypto = pickHasher(globalThis.crypto.subtle)
const builtin = pickHasher(undefined)
const HASHERS: Array<[string, Hasher]> = [
  ["the browser's SHA-256", webcrypto],
  ["the bundled SHA-256", builtin],
]

const enc = (s: string) => new TextEncoder().encode(s)
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex")
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")

function vectorManifest(): Manifest {
  const i = VECTOR.input
  return {
    v: 1,
    hash: "sha256",
    document_sha256: i.documentSha256,
    signed_pdf_sha256: i.signedPdfSha256,
    trail_sha256: i.trailSha256,
    level: i.level,
    agreement: i.agreement,
    version: i.version,
  }
}

const frozen = enc("%PDF-1.7 frozen document")
const signed = enc("%PDF-1.7 frozen document plus signature pages")
const trail = {
  v: 1,
  events: [
    {
      client_action_id: "a",
      typed_name: "Paul Morel",
      capacity: "Director",
      signed_at: "2026-11-10",
      ip: "198.51.100.7",
      user_agent: "UA-of-Paul",
    },
  ],
}
const canon = (v: unknown) => enc(JSON.stringify(sortDeep(v)))
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]),
    )
  }
  return v
}

function packageData(over: Partial<EvidenceData> = {}, trailValue: unknown = trail): EvidenceData {
  const manifest: Manifest = {
    v: 1,
    hash: "sha256",
    document_sha256: sha(frozen),
    signed_pdf_sha256: sha(signed),
    trail_sha256: sha(canon(trail)),
    level: "ses",
    agreement: "AG-2026-001",
    version: 1,
  }
  return {
    v: 1,
    lang: "en",
    org: "Maison Example",
    manifest: b64(canonicalManifestBytes(manifest)),
    trail: b64(canon(trailValue)),
    trailKind: "full",
    ...over,
  }
}

describe("offline checker: seal", () => {
  for (const [name, hasher] of HASHERS) {
    it(`recomputes the signing module's fixed seal vector with ${name}`, async () => {
      const m = vectorManifest()
      expect(new TextDecoder().decode(canonicalManifestBytes(m))).toBe(VECTOR.canonicalManifest)
      expect(await recomputeSeal(m, hasher)).toBe(VECTOR.seal)
    })
  }

  it("the bundled SHA-256 agrees with the browser's on empty, short and multi-block inputs", async () => {
    for (const len of [0, 1, 55, 56, 63, 64, 65, 1000, 70_001]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 31 + len) & 0xff)
      expect(await builtin.sha256Hex(bytes)).toBe(await webcrypto.sha256Hex(bytes))
      expect(await builtin.sha256Hex(bytes)).toBe(sha(bytes))
    }
  })

  it("reads only a manifest of exactly the sealed shape", () => {
    const good = canonicalManifestBytes(vectorManifest())
    expect(parseManifest(good)).not.toBeNull()
    const extra = enc(JSON.stringify({ ...vectorManifest(), note: "x" }))
    expect(parseManifest(extra)).toBeNull()
    const otherHash = enc(JSON.stringify({ ...vectorManifest(), hash: "sha1" }))
    expect(parseManifest(otherHash)).toBeNull()
    const shortHash = enc(JSON.stringify({ ...vectorManifest(), document_sha256: "ab" }))
    expect(parseManifest(shortHash)).toBeNull()
    expect(parseManifest(enc("not json"))).toBeNull()
  })
})

describe("offline checker: package and file", () => {
  it("says the full event list is the sealed one, and finds no problem", async () => {
    const r = await checkPackage(packageData(), webcrypto)
    expect(r?.trail).toEqual({ kind: "sealed" })
    expect(r?.manifestCanonical).toBe(true)
    expect(r?.seal).toBe(r?.recomputedSeal as string)
    expect(r?.token).toEqual({ kind: "absent" })
    expect(r?.problems).toEqual([])
    expect(r?.events[0]?.name).toBe("Paul Morel")
  })

  it("flags a full event list that is not the sealed one", async () => {
    const edited = { ...trail, events: [{ ...trail.events[0], typed_name: "Someone Else" }] }
    const r = await checkPackage(packageData({}, edited), webcrypto)
    expect(r?.trail.kind).toBe("mismatch")
    expect(r?.problems).toContain("trail_mismatch")
  })

  it("never checks a signer's copy of the event list against the seal", async () => {
    const copy = { ...trail, events: [{ ...trail.events[0], ip: undefined }] }
    const r = await checkPackage(packageData({ trailKind: "signer_copy" }, copy), webcrypto)
    expect(r?.trail).toEqual({ kind: "copy" })
    expect(r?.problems).toEqual([])
  })

  it("flags a manifest whose bytes are not its canonical form", async () => {
    const d = packageData()
    const pretty = JSON.stringify(
      JSON.parse(new TextDecoder().decode(base64ToBytes(d.manifest))),
      null,
      2,
    )
    const r = await checkPackage({ ...d, manifest: b64(enc(pretty)) }, webcrypto)
    expect(r?.manifestCanonical).toBe(false)
    expect(r?.problems).toContain("manifest_not_canonical")
    expect(r?.seal).not.toBe(r?.recomputedSeal as string)
  })

  it("tells the frozen document, the signed PDF and any other file apart", async () => {
    const m = parseManifest(base64ToBytes(packageData().manifest)) as Manifest
    for (const [name, hasher] of HASHERS) {
      expect((await checkFile(frozen, m, hasher)).match, name).toBe("document")
      expect((await checkFile(signed, m, hasher)).match, name).toBe("signed_pdf")
      const edited = new Uint8Array(frozen)
      edited[edited.length - 1] ^= 1
      const r = await checkFile(edited, m, hasher)
      expect(r.match, name).toBe("other")
      expect(r.sha256).toBe(sha(edited))
    }
  })

  it("cannot read a timestamp reply that is not one DER value", () => {
    expect(readTimestampReply(new Uint8Array([0x30, 0x03, 0x02, 0x01])).kind).toBe("unreadable")
    expect(readTimestampReply(new Uint8Array([0x30, 0x00, 0x00])).kind).toBe("unreadable")
    expect(readTimestampReply(enc("garbage")).kind).toBe("unreadable")
  })

  it("an unreadable timestamp reply is reported as unreadable, never as read", async () => {
    const r = await checkPackage(
      packageData({ token: b64(new Uint8Array([0x30, 0x00])) }),
      webcrypto,
    )
    expect(r?.token.kind).toBe("unreadable")
  })
})

describe("offline checker: the page", () => {
  it("the committed page script is the bundle of its source", async () => {
    const script = await bundlePageScript()
    expect(readFileSync(GENERATED, "utf8")).toBe(generatedSource(script))
    expect(createHash("sha256").update(PAGE_SCRIPT, "utf8").digest("base64")).toBe(
      PAGE_SCRIPT_SHA256_BASE64,
    )
  })

  it("allows its one script by hash, and no network, frame or form", () => {
    const html = new TextDecoder().decode(
      buildCheckPage({
        manifestBytes: base64ToBytes(packageData().manifest),
        trailBytes: canon(trail),
        trailKind: "full",
        orgName: "Maison Example",
        lang: "en",
      }),
    )
    expect(html).toContain(`content="${CHECK_PAGE_CSP}"`)
    expect(CHECK_PAGE_CSP).toContain(`script-src 'sha256-${PAGE_SCRIPT_SHA256_BASE64}'`)
    expect(CHECK_PAGE_CSP).toContain("default-src 'none'")
    expect(CHECK_PAGE_CSP).toContain("connect-src 'none'")
    expect(html).not.toMatch(/\b(?:src|href)=/)
    // Exactly the data element and the inline script.
    expect(html.match(/<script/g)?.length).toBe(2)
  })

  it("its script never turns a string into markup", () => {
    const sinks = [
      /\binnerHTML\b/,
      /\bouterHTML\b/,
      /\binsertAdjacentHTML\b/,
      /\bDOMParser\b/,
      /\bdocument\.write\b/,
      /\bcreateContextualFragment\b/,
      /\beval\s*\(/,
      /\bnew Function\b/,
    ]
    const dir = path.join(import.meta.dir, "page")
    for (const f of readdirSync(dir)) {
      const text = readFileSync(path.join(dir, f), "utf8")
      for (const re of sinks) expect(`${f}: ${re.test(text)}`).toBe(`${f}: false`)
    }
    expect(readFileSync(path.join(import.meta.dir, "check.ts"), "utf8")).not.toMatch(
      /innerHTML|DOMParser/,
    )
  })

  it("its words never call the result valid, qualified or legally binding", async () => {
    const { STRINGS } = await import("./page/strings")
    const all = JSON.stringify(STRINGS)
    for (const word of [
      /\bvalid/i,
      /qualifi/i,
      /legally binding/i,
      /juridiquement/i,
      /équivalent/i,
      /equivalent/i,
      /presum/i,
      /présum/i,
      /eIDAS/i,
      /\bvalide/i,
    ]) {
      expect(all).not.toMatch(word)
    }
  })
})
