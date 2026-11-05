// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How the updater signer is invoked, which is a secret handling question.
//
// The private key and its password reach the tauri signer as ARGUMENTS if
// nobody stops it, and a process's arguments are readable by every other
// process on the machine (`ps`, /proc, the runner's own diagnostics). On a self
// hosted runner that is a second job reading the project's signing key, and the
// updater key is the one credential in this pipeline that cannot be rotated:
// every installed copy verifies against the public half compiled into the build
// it is already running.
//
// So both halves travel in the child's environment, and the command line says
// only which file is being signed.
import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  makeUpdaterArchive,
  redactSecrets,
  signerFailureMessage,
  signerInvocation,
} from "./sign-updater-artifact"

const KEY_PATH = "/Users/somebody/.config/fabrikam-deploy/liaison-updater.key"
// Deliberately NOT shaped like a real private key: updater-key.test.ts sweeps
// the whole repository for that file's first line, and a test fixture spelling
// it out would make the sweep fire on this file forever after.
const KEY_BODY = "a key body rather than a path to one"
const PASSWORD = "correct horse battery staple"

describe("the updater signer invocation", () => {
  it("keeps the key path and the password off the command line", () => {
    const invocation = signerInvocation("Liaison_9.9.9_aarch64.app.tar.gz", {
      TAURI_SIGNING_PRIVATE_KEY: KEY_PATH,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: PASSWORD,
      exists: () => true,
    })
    expect(invocation.args).toEqual([
      "tauri",
      "signer",
      "sign",
      path.resolve("Liaison_9.9.9_aarch64.app.tar.gz"),
    ])
    expect(invocation.args.join(" ")).not.toContain(PASSWORD)
    expect(invocation.args.join(" ")).not.toContain(KEY_PATH)
  })

  it("hands the key to the child as a PATH when the value is one", () => {
    const invocation = signerInvocation("archive.tar.gz", {
      TAURI_SIGNING_PRIVATE_KEY: KEY_PATH,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: PASSWORD,
      exists: () => true,
    })
    expect(invocation.env.TAURI_PRIVATE_KEY_PATH).toBe(KEY_PATH)
    expect(invocation.env.TAURI_PRIVATE_KEY).toBeUndefined()
    expect(invocation.env.TAURI_PRIVATE_KEY_PASSWORD).toBe(PASSWORD)
  })

  it("hands the key to the child as a VALUE when it is the key itself", () => {
    // A GitHub secret holds the key, not a path to one.
    const invocation = signerInvocation("archive.tar.gz", {
      TAURI_SIGNING_PRIVATE_KEY: KEY_BODY,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: PASSWORD,
      exists: () => false,
    })
    expect(invocation.env.TAURI_PRIVATE_KEY).toBe(KEY_BODY)
    expect(invocation.env.TAURI_PRIVATE_KEY_PATH).toBeUndefined()
  })

  it("takes a path from the dedicated variable too", () => {
    const invocation = signerInvocation("archive.tar.gz", {
      TAURI_SIGNING_PRIVATE_KEY_PATH: KEY_PATH,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: PASSWORD,
      exists: () => true,
    })
    expect(invocation.env.TAURI_PRIVATE_KEY_PATH).toBe(KEY_PATH)
  })

  it("refuses to sign with no key at all", () => {
    // A release signed by nothing is a release the gate refuses, and the
    // message has to say which variable is missing rather than let the signer
    // sit waiting on a prompt.
    expect(() => signerInvocation("archive.tar.gz", { exists: () => false })).toThrow(
      "TAURI_SIGNING_PRIVATE_KEY",
    )
  })

  it("passes an empty password rather than leaving the signer to prompt", () => {
    const invocation = signerInvocation("archive.tar.gz", {
      TAURI_SIGNING_PRIVATE_KEY: KEY_BODY,
      exists: () => false,
    })
    expect(invocation.env.TAURI_PRIVATE_KEY_PASSWORD).toBe("")
  })

  it("names the artifact by an absolute path, since the signer runs elsewhere", () => {
    // The signer runs from the desktop package, where its CLI is installed,
    // and every caller names the artifact from the repository root. Handed on
    // as it arrived, the relative path is resolved against the CHILD's
    // directory and the signer opens nothing: that is the whole of dry run 6's
    // Linux failure, on an AppImage that was perfectly fine.
    const relative =
      "apps/desktop/src-tauri/target/release/bundle/appimage/Liaison_0.1.0_x86_64.AppImage"
    const invocation = signerInvocation(relative, {
      TAURI_SIGNING_PRIVATE_KEY: KEY_BODY,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: PASSWORD,
      exists: () => false,
    })
    const named = invocation.args[3] as string
    expect(path.isAbsolute(named)).toBe(true)
    expect(named).toBe(path.resolve(relative))
    // The point of the absolute path: it still names the same file from the
    // directory the child is actually started in.
    expect(path.resolve(invocation.cwd, named)).toBe(path.resolve(relative))
    expect(path.resolve("/somewhere/else", named)).toBe(path.resolve(relative))
  })
})

describe("what the job's log learns from a refusal", () => {
  it("carries the signer's own stderr and its exit code", () => {
    // Without this, dry run 6 printed "tauri signer refused <file> (exit 1)"
    // and nothing else, and the reason was thrown away at the one moment it
    // was worth having.
    const message = signerFailureMessage(
      "bundle/Liaison_0.1.0_x86_64.AppImage",
      {
        status: 1,
        stdout: "",
        stderr:
          "failed to sign file: failed to open data file x.AppImage: No such file or directory",
      },
      { TAURI_SIGNING_PRIVATE_KEY: KEY_BODY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: PASSWORD },
    )
    expect(message).toContain("exit 1")
    expect(message).toContain("No such file or directory")
  })

  it("says so plainly when the signer said nothing at all", () => {
    const message = signerFailureMessage(
      "archive.tar.gz",
      { status: 2, stdout: "", stderr: "" },
      {},
    )
    expect(message).toContain("exit 2")
    expect(message).toContain("said nothing")
  })

  it("never lets the key or the password ride out in that text", () => {
    const message = signerFailureMessage(
      "archive.tar.gz",
      { status: 1, stderr: `read ${KEY_BODY} with ${PASSWORD}` },
      { TAURI_SIGNING_PRIVATE_KEY: KEY_BODY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: PASSWORD },
    )
    expect(message).not.toContain(KEY_BODY)
    expect(message).not.toContain(PASSWORD)
    expect(message).toContain("[redacted]")
  })

  it("redacts a multi line key line by line", () => {
    const key = "untrusted comment: a test key\nAAAAAAAAAAAAAAAAAAAAAAAA"
    const text = redactSecrets("the signer echoed AAAAAAAAAAAAAAAAAAAAAAAA back", {
      TAURI_SIGNING_PRIVATE_KEY: key,
    })
    expect(text).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAA")
  })
})

// macOS tar stores extended attributes (quarantine, provenance, the code
// signature's own) as AppleDouble `._<name>` entries. The updater unpacks every
// entry, so 0.1.12 failed on every Mac with "failed to unpack
// `._Liaison_0.1.12_universal.app`". Only a Mac has the attributes to leak.
describe.skipIf(process.platform !== "darwin")("the macOS updater archive", () => {
  it("carries no AppleDouble `._` entries, even for an app with extended attributes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "updater-archive-"))
    const app = path.join(dir, "Liaison.app")
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true })
    writeFileSync(path.join(app, "Contents", "Info.plist"), "<plist/>")
    for (const target of [app, path.join(app, "Contents", "Info.plist")]) {
      expect(spawnSync("xattr", ["-w", "com.liaison.test", "1", target]).status).toBe(0)
    }

    const archive = makeUpdaterArchive(app)

    const listing = spawnSync(
      "python3",
      [
        "-c",
        "import sys,tarfile; print('\\n'.join(tarfile.open(sys.argv[1]).getnames()))",
        archive,
      ],
      { encoding: "utf8" },
    )
    expect(listing.status).toBe(0)
    const names = listing.stdout.trim().split("\n")
    expect(names).toContain("Liaison.app/Contents/Info.plist")
    expect(names.filter((n) => path.basename(n).startsWith("._"))).toEqual([])
  })
})
