// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Once against a real authority: skipped unless LIAISON_TSA_TEST_URL (and its
// chain, LIAISON_TSA_TEST_CHAIN_FILE) are set, so the suite never calls an
// outside service by default. `scripts/tsa-live-check.ts` runs the same check
// and prints the record.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { runLiveCheck } from "~/modules/signing/live-check"

const url = process.env.LIAISON_TSA_TEST_URL
const chainFile = process.env.LIAISON_TSA_TEST_CHAIN_FILE

describe("real timestamp authority", () => {
  it.skipIf(!url || !chainFile)(
    "a real authority's stamp passes this verifier and openssl ts -verify",
    async () => {
      const r = await runLiveCheck(url as string, readFileSync(chainFile as string, "utf8"))
      expect(r.outcome).toBe("stamped")
      expect(r.opensslVerify).toContain("Verification: OK")
      expect(r.policy).toMatch(/^\d+(\.\d+)+$/)
    },
    30_000,
  )
})
