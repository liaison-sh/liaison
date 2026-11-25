// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The offline checker against real evidence files: each zip's check.html
// carries that zip's own manifest, event list and timestamp reply, the
// checker reads a timestamp an openssl authority issued, and the openssl
// script checks a zip with nothing but the files inside it and the
// authority's chain, the signer's copy included.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { checkPackage, type EvidenceData, pickHasher } from "@liaison/evidence-check/check"
import { unzipSync, zipSync } from "fflate"
import { EVIDENCE_ZIP_ENTRIES } from "~/modules/signing/constants"
import { computeSeal, sha256Hex, trailSha256 } from "~/modules/signing/seal"
import {
  createFixtureAuthority,
  type FixtureAuthority,
} from "~/modules/signing/test-fixtures/tsa/authority"
import { buildTimestampRequest } from "~/modules/signing/timestamp"
import { buildPackageFiles, type Trail } from "./package-files"

const SCRIPT = path.resolve(
  import.meta.dir,
  "../../../../../packages/evidence-check/verify-with-openssl.sh",
)
const enc = (s: string) => new TextEncoder().encode(s)
const frozenPdf = enc("%PDF-1.7 frozen")
const signedPdf = enc("%PDF-1.7 frozen + signature pages")
const A = "aaaaaaaa-0000-4000-8000-00000000000a"
const B = "bbbbbbbb-0000-4000-8000-00000000000b"
const trail: Trail = {
  v: 1,
  agreement: "AG-2026-001",
  version: 1,
  events: [
    {
      client_action_id: A,
      typed_name: "Paul Morel",
      capacity: "Gérant",
      ip: "198.51.100.7",
      user_agent: "UA-of-Paul",
    },
    {
      client_action_id: B,
      typed_name: "Anne Morel",
      capacity: "Associée",
      ip: "203.0.113.9",
      user_agent: "UA-of-Anne",
    },
  ],
}
const sealed = computeSeal({
  documentSha256: sha256Hex(frozenPdf),
  signedPdfSha256: sha256Hex(signedPdf),
  trailSha256: trailSha256(trail),
  level: "ses",
  agreement: "AG-2026-001",
  version: 1,
})

let authority: FixtureAuthority
let work: string
let chainFile: string
let reply: Uint8Array

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "liaison-evidence-check-"))
  authority = createFixtureAuthority({ root: work })
  chainFile = path.join(work, "tsa-chain.pem")
  writeFileSync(chainFile, authority.chainPem)
  reply = authority.reply(buildTimestampRequest(Buffer.from(sealed.seal, "hex"), 0x1234n))
})

afterAll(() => {
  authority?.cleanup()
  if (work) rmSync(work, { recursive: true, force: true })
})

function build(timestampReply?: Uint8Array) {
  return buildPackageFiles({
    signedPdf,
    frozenPdf,
    trail,
    manifestBytes: sealed.manifestBytes,
    seal: sealed.seal,
    ...(timestampReply ? { timestampReply } : {}),
    certificatePdf: enc("%PDF certificate"),
    sealedAt: new Date(Date.UTC(2026, 10, 10)),
    orgName: "Maison Example",
    lang: "en",
    signerActionIds: [A, B],
  })
}

function pageData(zip: Uint8Array): EvidenceData {
  const html = new TextDecoder().decode(unzipSync(zip)[EVIDENCE_ZIP_ENTRIES.checkHtml])
  const m = html.match(/<script type="application\/json" id="evidence-data">([^<]*)<\/script>/)
  expect(m).not.toBeNull()
  return JSON.parse(m?.[1] ?? "") as EvidenceData
}

function runScript(zip: Uint8Array, name: string, chain?: string) {
  const file = path.join(work, name)
  writeFileSync(file, zip)
  const r = spawnSync("sh", [SCRIPT, file, ...(chain ? [chain] : [])], { encoding: "utf8" })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe("check.html inside each evidence zip", () => {
  it("the staff file's page carries its full event list and checks it against the seal", async () => {
    const files = build(reply)
    const data = pageData(files.evidence)
    expect(data.trailKind).toBe("full")
    const r = await checkPackage(data, pickHasher())
    expect(r?.seal).toBe(sealed.seal)
    expect(r?.trail).toEqual({ kind: "sealed" })
    expect(r?.problems).toEqual([])
  })

  it("a signer's copy's page holds only that signer's device and says the list is not checked", async () => {
    const files = build(reply)
    const paul = files.signerCopies[A] as Uint8Array
    const html = new TextDecoder().decode(unzipSync(paul)[EVIDENCE_ZIP_ENTRIES.checkHtml])
    const data = pageData(paul)
    expect(data.trailKind).toBe("signer_copy")
    const trailText = Buffer.from(data.trail, "base64").toString("utf8")
    expect(trailText).toContain("UA-of-Paul")
    expect(trailText).not.toContain("UA-of-Anne")
    expect(trailText).not.toContain("203.0.113.9")
    expect(html).not.toContain("UA-of-Anne")
    const r = await checkPackage(data, pickHasher())
    expect(r?.trail).toEqual({ kind: "copy" })
    expect(r?.seal).toBe(sealed.seal)
  })

  it("reads an authority's timestamp: it names this seal, with the authority's time and policy", async () => {
    const r = await checkPackage(pageData(build(reply).evidence), pickHasher())
    expect(r?.token.kind).toBe("read")
    if (r?.token.kind !== "read") return
    expect(r.token.namesSeal).toBe(true)
    expect(r.token.imprintHex).toBe(sealed.seal)
    expect(r.token.policy).toBe("1.3.6.1.4.1.55555.1.1")
    expect(Math.abs(r.token.genTime.getTime() - Date.now())).toBeLessThan(5 * 60 * 1000)
  })

  it("a timestamp over another seal is a problem the page reports", async () => {
    const other = authority.reply(buildTimestampRequest(new Uint8Array(32).fill(7), 1n))
    const data = {
      ...pageData(build(reply).evidence),
      token: Buffer.from(other).toString("base64"),
    }
    const r = await checkPackage(data, pickHasher())
    expect(r?.token.kind === "read" && r.token.namesSeal).toBe(false)
    expect(r?.problems).toContain("token_not_this_seal")
  })

  it("a package not stamped yet says so, and its page has no timestamp", async () => {
    const r = await checkPackage(pageData(build().evidence), pickHasher())
    expect(r?.token).toEqual({ kind: "absent" })
  })
})

describe("verify-with-openssl.sh", () => {
  it("checks the staff file and every signer's copy with only the zip's files and the authority's chain", () => {
    const files = build(reply)
    const staff = runScript(files.evidence, "staff.zip", chainFile)
    expect(staff.out).toContain("OK: trail.json is the sealed event list")
    expect(staff.out).toContain("OK: the timestamp is over manifest.json")
    expect(staff.status).toBe(0)
    for (const [i, zip] of [
      files.signerCopies[A],
      files.signerCopies[B],
      files.colleagueCopy,
    ].entries()) {
      const r = runScript(zip as Uint8Array, `copy-${i}.zip`, chainFile)
      expect(r.out).toContain("OK: document.pdf has the fingerprint in the manifest")
      expect(r.out).toContain("OK: signed.pdf has the fingerprint in the manifest")
      expect(r.out).toContain("NOTE: trail.json is a signer's copy")
      expect(r.out).toContain("OK: the timestamp is over manifest.json")
      expect(r.status).toBe(0)
    }
  })

  it("fails on an edited document, and on a chain the authority does not chain to", () => {
    const files = build(reply)
    const entries = unzipSync(files.evidence)
    const edited = zipSync({ ...entries, "document.pdf": enc("%PDF-1.7 edited") })
    const r = runScript(edited, "edited.zip", chainFile)
    expect(r.out).toContain("FAIL: document.pdf")
    expect(r.status).toBe(1)
    const foreign = path.join(work, "foreign.pem")
    writeFileSync(foreign, authority.foreignCa().ca.root.pem)
    const wrongChain = runScript(files.evidence, "staff2.zip", foreign)
    expect(wrongChain.out).toContain("FAIL: the timestamp does not verify")
    expect(wrongChain.status).toBe(1)
  })

  it("refuses to pass a stamped zip silently when no chain is given", () => {
    const r = runScript(build(reply).evidence, "nochain.zip")
    expect(r.status).toBe(2)
    expect(r.out).toContain("certificate chain")
  })

  it("says a package not stamped yet has no timestamp", () => {
    const r = runScript(build().evidence, "pending.zip")
    expect(r.out).toContain("NOTE: no timestamp yet")
    expect(r.status).toBe(0)
  })
})
