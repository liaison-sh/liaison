#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Does the updater signature beside this artifact actually cover THESE bytes?
//
// The publish job asks the same question at the end of a release, and that is
// the gate. This asks it on the build runner, immediately after the signature
// is produced, and it exists because of one thing the Linux job does that no
// other job does: it REWRITES the artifact after the bundler signed it.
//
// `tauri build` signs the AppImage it produced. The repack then replaces the
// sidecar inside it, so those bytes are a different file and the bundler's own
// .sig no longer describes anything that ships (the repack step deletes it for
// exactly that reason). The signature that matters is the one made afterwards,
// and a step order that quietly drifted back would produce a perfectly formed
// .sig over the pre-repack bytes, which every downloader would then refuse on
// the one path nobody watches: an auto update.
//
// So the check is the real verification, in process, against the file on disk.
//
// Usage:
//   bun apps/desktop/ci/verify-updater-signature.ts <artifact> [--pubkey-file <file>]
//
// With no --pubkey-file the trusted key is the one compiled into the build:
// tauri.conf.json's plugins.updater.pubkey, which is what an installed copy
// verifies against. A dry run signs with a throwaway key instead and passes
// that key's public half by name.

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { verifyMinisign } from "./minisign"

/** The public key an installed copy verifies with. Read from the config
 *  rather than repeated here: two spellings of a key is one release signed
 *  with the wrong half. */
export function configuredPublicKey(root = path.resolve(import.meta.dir, "..")): string {
  const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")) as {
    plugins?: { updater?: { pubkey?: string } }
  }
  const pubkey = config.plugins?.updater?.pubkey
  if (!pubkey) throw new Error("tauri.conf.json declares no updater pubkey")
  return pubkey
}

export function verifyArtifactSignature(artifact: string, publicKeyText: string): string {
  if (!existsSync(artifact)) throw new Error(`no such artifact: ${artifact}`)
  const signature = `${artifact}.sig`
  if (!existsSync(signature)) {
    throw new Error(
      `no updater signature beside ${artifact}: the artifact was rewritten after the bundler signed it, so an unsigned upload here is an update channel with nothing to verify`,
    )
  }
  const outcome = verifyMinisign(
    readFileSync(artifact),
    readFileSync(signature, "utf8"),
    publicKeyText,
  )
  if (!outcome.ok) {
    throw new Error(`${artifact} is not covered by ${path.basename(signature)}: ${outcome.reason}`)
  }
  return outcome.trustedComment
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  let artifact = ""
  let pubkeyFile = ""
  let index = 0
  while (index < argv.length) {
    const argument = argv[index] as string
    index += 1
    if (argument === "--pubkey-file") {
      pubkeyFile = argv[index] ?? ""
      index += 1
    } else if (!artifact) {
      artifact = argument
    }
  }
  if (!artifact) {
    console.error("usage: verify-updater-signature.ts <artifact> [--pubkey-file <file>]")
    process.exit(2)
  }
  try {
    const publicKeyText = pubkeyFile ? readFileSync(pubkeyFile, "utf8") : configuredPublicKey()
    const trustedComment = verifyArtifactSignature(artifact, publicKeyText)
    console.log(`updater signature verifies over ${artifact}`)
    console.log(`  trusted comment: ${trustedComment}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
