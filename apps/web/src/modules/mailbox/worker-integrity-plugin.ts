// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The BUILD half of the worker integrity check, colocated with the runtime half
// it exists to make true. Nothing in the browser imports this file: `vite.config.ts`
// does, and it runs in Node during `vite build`.
//
// What it does: after the bundle is generated, hash the emitted crypto worker
// and substitute that hash for the placeholder token that `crypto-worker-boot.ts`
// carries. The page then holds the hash of the exact worker bytes this build
// produced, which is what `bootVerifiedWorker` compares against before it will
// run any of them.
//
// What it will NOT do: succeed quietly. A build with no worker bundle, or with
// nothing carrying the token, would produce a page whose integrity check either
// cannot run or compares a placeholder against itself. Both ship a mailbox that
// only looks verified, so both are build failures here.

import { createHash } from "node:crypto"

/**
 * The literal `crypto-worker-boot.ts` carries. It is written out in full in
 * exactly one place per file, because this substitution is textual: a second
 * copy in the boot module would be substituted too, and its own placeholder
 * check would then compare the hash against itself.
 */
export const MAILBOX_WORKER_HASH_TOKEN = "__MAILBOX_WORKER_SHA256__"

/**
 * Vite emits the worker for `?worker&url` as `crypto-worker-<hash>.js`. The boot
 * module is excluded by name: once two chunks import it, the bundler splits it
 * into its own `crypto-worker-boot-<hash>.js`, which is the file that CARRIES
 * the hash token, not the worker, and counting it made every build fail.
 */
const WORKER_FILE = /(^|\/)crypto-worker(?!-boot[-.])[-.][^/]*\.js$/

export interface BundleFile {
  fileName: string
  code: string
}

export interface BakeResult {
  /** Base64 SHA-256 of the worker bundle, the same encoding `sha256Base64` produces. */
  hash: string
  /** Files the token was substituted in. Empty is a build failure, not a result. */
  patched: string[]
}

/**
 * Pure over a list of emitted files, so the build behaviour is testable without
 * running a build. Mutates `code` in place, which is what the rollup hook needs.
 */
export function bakeMailboxWorkerHash(files: BundleFile[]): BakeResult {
  const worker = files.filter((file) => WORKER_FILE.test(file.fileName))
  if (worker.length === 0) {
    throw new Error(
      "mailbox worker integrity: no crypto worker bundle was emitted, so the page has no hash to verify against",
    )
  }
  if (worker.length > 1) {
    // More than one candidate means the worker was code split, and a split
    // worker cannot be booted from a blob URL at all: its sibling chunks would
    // be fetched unverified.
    throw new Error(
      `mailbox worker integrity: expected one crypto worker bundle, found ${worker.length}: ${worker
        .map((file) => file.fileName)
        .join(", ")}`,
    )
  }
  const hash = createHash("sha256").update(worker[0].code, "utf8").digest("base64")

  const patched: string[] = []
  for (const file of files) {
    if (file === worker[0]) continue
    if (!file.code.includes(MAILBOX_WORKER_HASH_TOKEN)) continue
    file.code = file.code.split(MAILBOX_WORKER_HASH_TOKEN).join(hash)
    patched.push(file.fileName)
  }
  if (patched.length === 0) {
    throw new Error(
      "mailbox worker integrity: no chunk carried the worker hash token, so nothing in this build would verify the worker before running it",
    )
  }
  return { hash, patched }
}

/**
 * The rollup `OutputBundle` shape, narrowed to what this needs. Typed locally
 * rather than imported so this module does not pull rollup's types into the
 * app's typecheck.
 */
interface OutputEntry {
  type: "chunk" | "asset"
  fileName: string
  code?: string
  source?: string | Uint8Array
}

interface VitePluginLike {
  name: string
  apply: "build"
  generateBundle(options: unknown, bundle: Record<string, OutputEntry>): void
}

export function mailboxWorkerIntegrity(): VitePluginLike {
  return {
    name: "mailbox-worker-integrity",
    apply: "build",
    generateBundle(_options, bundle) {
      const entries = Object.values(bundle)
      const files: Array<BundleFile & { entry: OutputEntry }> = []
      for (const entry of entries) {
        // BINARY ASSETS ARE NOT TEXT. A `Uint8Array` source is a font, an image
        // or any other byte blob: decoding it as UTF-8 turns every byte that is
        // not valid UTF-8 into U+FFFD, and writing the string back replaces the
        // asset with that lossy transcription. It shipped six unreadable woff2
        // files, so the whole app rendered in fallback fonts. A byte blob can
        // never carry the hash token anyway, so it is simply left alone.
        const text =
          entry.type === "chunk"
            ? (entry.code ?? "")
            : typeof entry.source === "string"
              ? entry.source
              : ""
        if (!text) continue
        files.push({ fileName: entry.fileName, code: text, entry })
      }
      bakeMailboxWorkerHash(files)
      for (const file of files) {
        if (file.entry.type === "chunk") file.entry.code = file.code
        else file.entry.source = file.code
      }
    },
  }
}
