// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The compiled sidecar carries the Claude Code CLI the SDK spawns, because
// `require.resolve` does not work inside a compiled binary's `$bunfs` and the
// SDK would otherwise die on its first turn with "Native CLI binary for
// <platform> not found". That is a packaging property, not a source
// property, so it is asserted against a real compiled binary run from a
// directory that has nothing to do with this repo.
//
// FOR THE MACHINE RUNNING THE TEST, not one hard coded triple: this file was
// pinned to darwin-arm64, so the Windows CI job compiled a sidecar with no CLI
// in it (the package there ships `claude.exe`, and `claude` did not resolve),
// every guard stayed green, and the first Windows walk found out in the app.
import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildOne,
  ENTRIES,
  hostTarget,
  platformCliFile,
  platformCliPackage,
  platformCliSpecifier,
  unshippableReason,
  writeEntry,
} from "./build"

const HOST_TARGET = hostTarget()

describe("bunfs CLI resolution", () => {
  it("names the CLI file each platform package actually ships", () => {
    expect(platformCliFile("bun-windows-x64")).toBe("claude.exe")
    expect(platformCliFile("bun-darwin-arm64")).toBe("claude")
    expect(platformCliFile("bun-darwin-x64")).toBe("claude")
    expect(platformCliFile("bun-linux-x64")).toBe("claude")
    expect(platformCliSpecifier("bun-windows-x64")).toBe(
      "@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
    )
  })

  it("refuses a host build without its CLI and lets a cross compile through with a warning", () => {
    expect(unshippableReason("bun-windows-x64", null, "bun-windows-x64")).toContain(
      "claude-agent-sdk-win32-x64/claude.exe did not resolve",
    )
    expect(unshippableReason("bun-windows-x64", null, "bun-darwin-arm64")).toBeNull()
    expect(
      unshippableReason(
        "bun-windows-x64",
        "@anthropic-ai/claude-agent-sdk-win32-x64",
        "bun-windows-x64",
      ),
    ).toBeNull()
  })

  it("embeds the platform CLI package in the generated entry for this host", () => {
    expect(platformCliPackage(HOST_TARGET)).toBe(
      platformCliSpecifier(HOST_TARGET).slice(0, -platformCliFile(HOST_TARGET).length - 1),
    )
    const entry = readFileSync(writeEntry(HOST_TARGET), "utf8")
    expect(entry).toContain(
      `import cli from "${platformCliSpecifier(HOST_TARGET)}" with { type: "file" }`,
    )
    expect(entry).toContain("extractFromBunfs")
    expect(path.dirname(writeEntry(HOST_TARGET))).toBe(ENTRIES)
  })

  it("resolves the CLI to a real path when run from an arbitrary cwd", async () => {
    const binary = buildOne(HOST_TARGET)
    const dir = mkdtempSync(path.join(tmpdir(), "sidecar-bunfs-"))
    const config = path.join(dir, "mcp.json")
    writeFileSync(
      config,
      JSON.stringify({
        liaisonMcpUrl: "http://127.0.0.1:9/mcp",
        agentScopedToken: "unused",
        agentDefinition: "",
      }),
    )

    // The filesystem root is the harshest cwd available: nothing of this repo
    // is reachable from it by a relative path.
    const root = path.parse(process.cwd()).root
    const child = Bun.spawn([binary, "--mcp-config", config, "--model", "claude-haiku-4-5"], {
      cwd: root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write("say nothing\n")
    child.stdin.flush()

    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    while (!buffered.includes("\n")) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
    }
    child.kill()

    const boot = JSON.parse(buffered.split("\n")[0] as string) as {
      type: string
      cwd: string
      cliPath: string | null
    }
    expect(boot.type).toBe("boot")
    expect(boot.cwd).toBe(root)
    expect(boot.cliPath).toBeTruthy()
    expect(boot.cliPath?.includes("$bunfs")).toBe(false)
    expect(boot.cliPath?.includes("~BUN")).toBe(false)
    // Bun names an embedded asset `<stem>-<hash><ext>`, and the extractor keeps
    // that name: the extension is what decides a direct spawn, so it is what
    // is pinned. For a file with no extension Bun writes a lone dot
    // (`claude-<hash>.`), which is still no extension to a spawn, so a lone
    // dot counts as none.
    const extracted = path.extname(boot.cliPath as string).replace(/^\.$/, "")
    expect(extracted).toBe(path.extname(platformCliFile(HOST_TARGET)))
    expect(path.basename(boot.cliPath as string).startsWith("claude")).toBe(true)
    expect(existsSync(boot.cliPath as string)).toBe(true)
    // Exists is not runs: the shipped failure was a first turn that died. The
    // CLI answers its version without a login or a key.
    const version = Bun.spawnSync([boot.cliPath as string, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(version.exitCode).toBe(0)
    expect(version.stdout.toString()).toMatch(/\d+\.\d+/)
  }, 300_000)
})
