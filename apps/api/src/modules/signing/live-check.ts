// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One stamp from a real RFC 3161 authority, verified twice: by this module's
// own verifier and by `openssl ts -verify` with only the configured chain.
// A fixture authority runs openssl itself, so it shares openssl's assumptions;
// this check is the one run against someone else's implementation. Run by an
// operator (`scripts/tsa-live-check.ts`), never by the test suite by default.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { computeSeal } from "~/modules/signing/seal"
import { parseCertificatesPem, requestTimestamp } from "~/modules/signing/timestamp"

export interface LiveCheckResult {
  url: string
  outcome: "stamped" | "pending"
  detail?: string
  genTime?: string
  policy?: string
  serialHex?: string
  signerCertSha256?: string
  chainSha256?: string[]
  chainFileSha256: string
  opensslVerify: string
}

/** Stamp a sample seal at `url`, trusting only `chainPem`, and verify it with openssl too. */
export async function runLiveCheck(url: string, chainPem: string): Promise<LiveCheckResult> {
  const sample = computeSeal({
    documentSha256: createHash("sha256").update("live check document").digest("hex"),
    signedPdfSha256: createHash("sha256").update("live check signed").digest("hex"),
    trailSha256: createHash("sha256").update(`live check ${Date.now()}`).digest("hex"),
    level: "simple",
    agreement: "LIVE-CHECK",
    version: 1,
  })
  const chainFileSha256 = createHash("sha256").update(chainPem).digest("hex")
  const out = await requestTimestamp({
    manifestBytes: sample.manifestBytes,
    config: { url, trust: parseCertificatesPem(chainPem), allowPrivate: false },
  })
  if (out.status !== "stamped") {
    return {
      url,
      outcome: "pending",
      detail: `${out.reason}: ${out.detail}`,
      chainFileSha256,
      opensslVerify: "not run (no verified reply)",
    }
  }
  const dir = mkdtempSync(path.join(tmpdir(), "liaison-tsa-live-"))
  let opensslVerify: string
  try {
    writeFileSync(path.join(dir, "manifest.json"), sample.manifestBytes)
    writeFileSync(path.join(dir, "reply.tsr"), out.reply)
    writeFileSync(path.join(dir, "chain.pem"), chainPem)
    const r = spawnSync(
      "openssl",
      ["ts", "-verify", "-data", "manifest.json", "-in", "reply.tsr", "-CAfile", "chain.pem"],
      { cwd: dir, encoding: "utf8" },
    )
    opensslVerify = `${(r.stdout ?? "").trim()} ${(r.stderr ?? "").trim()}`.trim()
    if (r.status !== 0) opensslVerify = `FAILED (exit ${r.status}): ${opensslVerify}`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return {
    url,
    outcome: "stamped",
    genTime: out.genTime.toISOString(),
    policy: out.policy,
    serialHex: out.serialHex,
    signerCertSha256: out.signerCertSha256,
    chainSha256: out.chainSha256,
    chainFileSha256,
    opensslVerify,
  }
}

/** The result as a short Markdown record. */
export function liveCheckMarkdown(r: LiveCheckResult, ranBy: string, ranAt: Date): string {
  const lines = [
    "# Timestamp authority live check",
    "",
    `- Authority: ${r.url}`,
    `- Ran by: ${ranBy}, ${ranAt.toISOString()}`,
    `- Outcome: ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`,
    `- Configured chain file SHA-256: ${r.chainFileSha256}`,
  ]
  if (r.outcome === "stamped") {
    lines.push(
      `- genTime: ${r.genTime}`,
      `- Policy OID: ${r.policy}`,
      `- Serial: ${r.serialHex}`,
      `- Signer certificate SHA-256: ${r.signerCertSha256}`,
      `- Validated path SHA-256 (signer first): ${r.chainSha256?.join(", ")}`,
    )
  }
  lines.push(`- openssl ts -verify: ${r.opensslVerify}`, "")
  return lines.join("\n")
}
