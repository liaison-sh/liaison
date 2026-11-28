#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test fixtures the iOS served shell's XCTest suite (ios/LiaisonShell/Tests)
// checks its Swift ports against, produced by the TypeScript originals:
//
//  - PageFixtures.swift: index.html samples and what build-mobile.ts makes of
//    them (boot-injection.ts). Deterministic; shell-page-parity.test.ts fails
//    when the committed file is not what this script writes now.
//  - SignedFixtures.swift (`--signed`): a shell statement, a revocation list
//    and fleet flags canonicalised and signed by a throwaway test key with the
//    shared package's own code, so the Swift parser and verifier are proven on
//    bytes TypeScript produced. The key is fresh each run, so this file is
//    written once and only re-written on purpose.

import { writeFileSync } from "node:fs"
import path from "node:path"
import { canonicalJson } from "../../../packages/shared/src/app-signing/statement"
import { createTestSigningKey } from "../../../packages/shared/src/app-signing/testing"
import { makeMobilePage } from "./boot-injection"

const TESTS = path.resolve(import.meta.dir, "../ios/LiaisonShell/Tests/LiaisonShellTests")
export const PAGE_FIXTURES = path.join(TESTS, "PageFixtures.swift")
const SIGNED_FIXTURES = path.join(TESTS, "SignedFixtures.swift")

/** Base64 of the UTF-8 bytes: the safest way to carry any text into Swift. */
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64")

export const PAGE_SAMPLES: string[] = [
  // Nested comment pieces: one removal pass would leave a new "<!--" (CodeQL js/incomplete-multi-character-sanitization).
  '<!doctype html><html><!<!---->--<script>x()</script>--><head><meta name="viewport" content="width=device-width"></head><body></body></html>',
  '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><!-- open</body></html>',
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="liaison-web-build" content="0123456789abcdef" />
    <meta http-equiv="Content-Security-Policy" content="default-src *">
    <title>Liaison</title>
    <script>document.documentElement.dataset.theme = localStorage.getItem("theme") || "light"</script>
    <script type="importmap">{"imports":{"solid-js":"/assets/solid.js"}}</script>
    <script type="module">import "/assets/pre.js"; window.__é = "café 🚀"</script>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-abc.css">
  </head>
  <body><div id="root"></div></body>
</html>
`,
  `<html><HEAD data-x="1"><meta name='viewport' content='width=device-width,user-scalable=no,maximum-scale=5'><SCRIPT>a<b</SCRIPT ></HEAD><body></body></html>`,
  // Data blocks stay inline and keep their type; nomodule survives the move; a <header> is not a <head>.
  `<!doctype html><html><head><meta name="viewport" content="width=device-width"><script type="application/json" id="cfg">{"a":1}</script><script type='text/template'><b>x</b></script><script nomodule>legacy()</script><script type="text/javascript">run()</script></head><body><header>top</header></body></html>`,
  // Refused: a <head> inside a comment before the real one.
  `<!doctype html><!-- <head> --><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>`,
  // Refused: a <header> before the head would take the injection.
  `<html><header></header><head><meta name="viewport" content="width=device-width"></head><body></body></html>`,
  // Refused: a script before <head> runs before the policy and the boot bundle.
  `<!doctype html><script src="https://evil.example/x.js"></script><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>`,
  // Refused: the boot tag already elsewhere (end of body) skips the injection.
  `<html><head><meta name="viewport" content="width=device-width"></head><body><script src="/liaison-mobile-boot.js"></script></body></html>`,
  // Refused: the boot tag only inside a comment.
  `<html><head><!-- <script src="/liaison-mobile-boot.js"></script> --><meta name="viewport" content="width=device-width"></head><body></body></html>`,
  // Refused: two heads.
  `<html><head><meta name="viewport" content="width=device-width"></head><head></head><body></body></html>`,
]

/** The page boot-injection.ts makes of `html`, or null when it refuses it. */
export function makePage(html: string): {
  html: string
  files: Array<{ name: string; content: string }>
} | null {
  try {
    return makeMobilePage(html)
  } catch {
    return null
  }
}

export function renderPageFixtures(): string {
  const cases = PAGE_SAMPLES.map((input) => {
    const out = makePage(input)
    const files = (out?.files ?? [])
      .map((f) => `            ${JSON.stringify(f.name)}: ${JSON.stringify(b64(f.content))},`)
      .join("\n")
    return `    PageCase(
        input: ${JSON.stringify(b64(input))},
        refused: ${out === null},
        html: ${JSON.stringify(b64(out?.html ?? ""))},
        files: [
${files.length > 0 ? files : "            :"}
        ]
    ),`
  }).join("\n")
  return `// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GENERATED by apps/mobile/scripts/gen-shell-fixtures.ts from
// apps/mobile/scripts/boot-injection.ts (all text base64 of its UTF-8 bytes).
// Do not edit; apps/mobile/shell-page-parity.test.ts fails when stale.

struct PageCase {
    let input: String
    /// boot-injection.ts refuses this page (checkMobilePage): the Swift port must too.
    let refused: Bool
    let html: String
    let files: [String: String]
}

let pageCases: [PageCase] = [
${cases}
]
`
}

async function renderSignedFixtures(): Promise<string> {
  const key = await createTestSigningKey("test-key")
  const statement = {
    v: 1,
    kind: "shell",
    keyId: "test-key",
    mode: "native",
    buildId: "0123456789abcdef",
    commit: "0123456789abcdef0123456789abcdef01234567",
    seq: 1764320000,
    liaisonVersion: "nightly-20261128",
    bridge: { desktop: "^1", ios: "^1", android: "^1" },
    settingsSchema: 3,
    files: {
      "index.html": "a".repeat(64),
      "assets/é b.js": "b".repeat(64),
    },
    issuedAt: "2026-11-28T12:00:00.000Z",
  }
  const list = {
    v: 1,
    seq: 7,
    issuedAt: "2026-11-28T12:00:00.000Z",
    entries: [
      { name: "shell:native", below: "1764310000" },
      { name: "shell:watch", below: 5 },
      { name: "invoicing", versions: ["0.1.0"] },
    ],
  }
  const flags = {
    v: 1,
    seq: 2,
    issuedAt: "2026-11-28T12:00:00.000Z",
    servedShell: { desktop: true, native: false },
  }
  const enc = new TextEncoder()
  const docs = { statement, list, flags }
  const lines: string[] = []
  for (const [name, value] of Object.entries(docs)) {
    const text = canonicalJson(value)
    lines.push(`    static let ${name} = ${JSON.stringify(b64(text))}`)
    lines.push(`    static let ${name}Sig = ${JSON.stringify(await key.sign(enc.encode(text)))}`)
  }
  return `// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GENERATED ONCE by apps/mobile/scripts/gen-shell-fixtures.ts --signed: canonical
// JSON (base64) signed by a throwaway TEST key with packages/shared's own code.

enum SignedFixtures {
    static let keyId = ${JSON.stringify(key.key.keyId)}
    static let publicKey = ${JSON.stringify(key.key.publicKey)}
${lines.join("\n")}
}
`
}

if (import.meta.main) {
  writeFileSync(PAGE_FIXTURES, renderPageFixtures())
  console.log(`wrote ${path.basename(PAGE_FIXTURES)}`)
  if (process.argv.includes("--signed")) {
    writeFileSync(SIGNED_FIXTURES, await renderSignedFixtures())
    console.log(`wrote ${path.basename(SIGNED_FIXTURES)}`)
  }
}
