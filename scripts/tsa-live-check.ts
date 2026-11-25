#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One RFC 3161 stamp from a real timestamp authority, verified by the
// product's verifier and by `openssl ts -verify`, printed as a Markdown record
// (authority, chain hashes, policy OID, who ran it).
//
//   LIAISON_TSA_TEST_URL=https://freetsa.org/tsr \
//   LIAISON_TSA_TEST_CHAIN_FILE=./freetsa-cacert.pem \
//     bun scripts/tsa-live-check.ts [--out <file>]
//
// FreeTSA (https://freetsa.org) is the public test authority named for this
// check until a production provider is chosen. Its chain is its published
// `cacert.pem`; without LIAISON_TSA_TEST_CHAIN_FILE the script downloads it
// from https://freetsa.org/files/cacert.pem for a FreeTSA URL and prints its
// SHA-256 to compare with the fingerprint FreeTSA publishes.
//
// Unset LIAISON_TSA_TEST_URL: prints that it skipped and exits 0. No database,
// no server secret: the throwaway values below only satisfy the env schema.
import { randomBytes } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { userInfo } from "node:os"

const url = process.env.LIAISON_TSA_TEST_URL
if (!url) {
  console.log("tsa-live-check: skipped, LIAISON_TSA_TEST_URL is unset")
  process.exit(0)
}
process.env.JWT_SECRET ??= randomBytes(32).toString("hex")
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("hex")

const outIdx = process.argv.indexOf("--out")
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : undefined

async function chainPem(): Promise<string> {
  const file = process.env.LIAISON_TSA_TEST_CHAIN_FILE
  if (file) return readFileSync(file, "utf8")
  if (new URL(url as string).hostname === "freetsa.org") {
    const res = await fetch("https://freetsa.org/files/cacert.pem")
    if (!res.ok) throw new Error(`could not download FreeTSA's chain: HTTP ${res.status}`)
    console.error("tsa-live-check: chain downloaded from https://freetsa.org/files/cacert.pem")
    return res.text()
  }
  throw new Error("set LIAISON_TSA_TEST_CHAIN_FILE to the authority's PEM chain")
}

const { liveCheckMarkdown, runLiveCheck } = await import(
  "../apps/api/src/modules/signing/live-check"
)
const result = await runLiveCheck(url, await chainPem())
const md = liveCheckMarkdown(
  result,
  process.env.LIAISON_TSA_RAN_BY ?? userInfo().username,
  new Date(),
)
console.log(md)
if (outFile) writeFileSync(outFile, md)
process.exit(result.outcome === "stamped" && !result.opensslVerify.startsWith("FAILED") ? 0 : 1)
