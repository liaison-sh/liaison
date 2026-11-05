// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The build half of the worker integrity check. The runtime half is only as
// good as this: a page whose baked hash was never substituted verifies nothing,
// and the failure is silent unless the build refuses to produce one.

import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  bakeMailboxWorkerHash,
  MAILBOX_WORKER_HASH_TOKEN,
  mailboxWorkerIntegrity,
} from "~/modules/mailbox/worker-integrity-plugin"

const WORKER_SOURCE = "self.onmessage=()=>{};\n"

function sha256Base64(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("base64")
}

describe("mailbox worker integrity, build side", () => {
  it("bakes the emitted worker's sha256 into every chunk that carries the token", () => {
    const files = [
      { fileName: "assets/crypto-worker-a1b2c3.js", code: WORKER_SOURCE },
      { fileName: "assets/index-d4e5f6.js", code: `const h="${MAILBOX_WORKER_HASH_TOKEN}";` },
    ]

    const result = bakeMailboxWorkerHash(files)

    expect(result.hash).toBe(sha256Base64(WORKER_SOURCE))
    expect(result.patched).toEqual(["assets/index-d4e5f6.js"])
    expect(files[1].code).toBe(`const h="${sha256Base64(WORKER_SOURCE)}";`)
    // The worker's own bytes are never rewritten: they are what was hashed.
    expect(files[0].code).toBe(WORKER_SOURCE)
  })

  it("a boot module split into its own chunk is not counted as a second worker", () => {
    // Two chunks importing crypto-worker-boot made the bundler emit it as
    // crypto-worker-boot-<hash>.js, and the build refused with "found 2".
    const files = [
      { fileName: "assets/crypto-worker-CqWkWQJa.js", code: WORKER_SOURCE },
      {
        fileName: "assets/crypto-worker-boot-DfMv6W3L.js",
        code: `const h="${MAILBOX_WORKER_HASH_TOKEN}";`,
      },
    ]

    const result = bakeMailboxWorkerHash(files)

    expect(result.hash).toBe(sha256Base64(WORKER_SOURCE))
    expect(result.patched).toEqual(["assets/crypto-worker-boot-DfMv6W3L.js"])
  })

  it("leaves a binary asset's bytes untouched", () => {
    // A woff2 header, whose 0x9c byte is not valid UTF-8 on its own: decoding
    // the asset as text turns it into U+FFFD and the font never loads again.
    const font = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00, 0x9c, 0x2c])
    const bundle: Record<string, unknown> = {
      "assets/crypto-worker-a1b2c3.js": {
        type: "chunk",
        fileName: "assets/crypto-worker-a1b2c3.js",
        code: WORKER_SOURCE,
      },
      "assets/index-d4e5f6.js": {
        type: "chunk",
        fileName: "assets/index-d4e5f6.js",
        code: `const h="${MAILBOX_WORKER_HASH_TOKEN}";`,
      },
      "assets/Geist-Regular-w2QFeScy.woff2": {
        type: "asset",
        fileName: "assets/Geist-Regular-w2QFeScy.woff2",
        source: font,
      },
    }

    mailboxWorkerIntegrity().generateBundle({}, bundle as never)

    const emitted = (bundle["assets/Geist-Regular-w2QFeScy.woff2"] as { source: unknown }).source
    expect(emitted).toBeInstanceOf(Uint8Array)
    expect(Array.from(emitted as Uint8Array)).toEqual(Array.from(font))
  })

  it("refuses to build when no worker bundle was emitted", () => {
    const files = [
      { fileName: "assets/index-d4e5f6.js", code: `const h="${MAILBOX_WORKER_HASH_TOKEN}";` },
    ]

    expect(() => bakeMailboxWorkerHash(files)).toThrow(/crypto worker/i)
  })

  it("refuses to build when nothing carries the token, so no page ships unverified", () => {
    const files = [
      { fileName: "assets/crypto-worker-a1b2c3.js", code: WORKER_SOURCE },
      { fileName: "assets/index-d4e5f6.js", code: "const h='already something else';" },
    ]

    expect(() => bakeMailboxWorkerHash(files)).toThrow(/token/i)
  })
})
