// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The updater key is the second of the two signatures a release has to carry,
// and it is the one this project owns: the OS signature says Apple or Azure
// trusts the binary, the updater signature says THIS project built it. A
// deployment cannot mint one, which is the whole of D13.
//
// Two things are pinned here and they pull in opposite directions. The PUBLIC
// half has to be in the tree, byte for byte, or a shipped app has nothing to
// verify an update against. The PRIVATE half must never be: it lives in
// the maintainer's secrets directory and, when the maintainer decides to, in a
// GitHub secret. So the shape of the public key is asserted, and the whole
// repository is read for anything that looks like the private one.
import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

const DESKTOP = import.meta.dir
const REPO_ROOT = path.resolve(DESKTOP, "..", "..")
const config = JSON.parse(
  readFileSync(path.join(DESKTOP, "src-tauri/tauri.conf.json"), "utf8"),
) as {
  bundle?: { createUpdaterArtifacts?: boolean }
  plugins?: { updater?: { pubkey?: string } }
}
const cargo = readFileSync(path.join(DESKTOP, "src-tauri/Cargo.toml"), "utf8")

/** The first line of a minisign secret key file, assembled from pieces so this
 *  file is not itself the thing the sweep below finds. */
const SECRET_KEY_HEADER = ["untrusted", "comment:", "minisign", "encrypted", "secret", "key"].join(
  " ",
)

describe("the updater public key", () => {
  const pubkey = config.plugins?.updater?.pubkey ?? ""

  it("is committed in the tauri config", () => {
    expect(typeof pubkey).toBe("string")
    expect(pubkey.length).toBeGreaterThan(0)
  })

  it("is the minisign public key tauri's updater reads", () => {
    // Tauri wraps the minisign public key in one more base64 layer. Decoded,
    // it is the two line minisign file: an untrusted comment, then the key.
    const decoded = Buffer.from(pubkey, "base64").toString("utf8")
    expect(decoded).toContain("untrusted comment:")
    const keyLine = decoded.trim().split("\n").at(-1) ?? ""
    // Ed25519: 2 byte algorithm + 8 byte key id + 32 byte key = 42 bytes.
    expect(Buffer.from(keyLine, "base64").length).toBe(42)
    expect(keyLine.startsWith("RW")).toBe(true)
  })

  it("is a public key and carries no private key material", () => {
    expect(pubkey).not.toContain(SECRET_KEY_HEADER)
  })
})

describe("the updater plugin", () => {
  it("is a dependency of the shell", () => {
    expect(cargo).toContain("tauri-plugin-updater")
  })

  it("asks the bundler for the updater artifacts", () => {
    // Without this the build produces installers and no `.sig` beside them,
    // and the two signature gate has only one signature to check.
    expect(config.bundle?.createUpdaterArtifacts).toBe(true)
  })
})

describe("the updater private key", () => {
  it("appears nowhere in the repository", () => {
    // Read from git's own index rather than the working tree: a key that is
    // gitignored but present would pass a filesystem walk and still be the
    // thing that ends up in a commit.
    const grep = spawnSync("git", ["grep", "-I", "-l", "-F", SECRET_KEY_HEADER, "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
    expect(grep.stdout.trim()).toBe("")
    // And not in the working tree either, tracked or not.
    const walk = spawnSync(
      "grep",
      [
        "-rIl",
        "--exclude-dir=node_modules",
        "--exclude-dir=target",
        "--exclude-dir=.git",
        // RUN OUTPUT IS NOT A COMMIT (P6d-FX2). `logs/` is gitignored test run
        // output, and the memory guard writes the whole process tree's command
        // lines into it: one of those command lines is THIS grep, header and
        // all, so a box that has ever tripped the guard failed this case from
        // then on over a file that can never reach a commit.
        "--exclude-dir=logs",
        SECRET_KEY_HEADER,
        ".",
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    )
    expect(walk.stdout.trim()).toBe("")
  })
})
