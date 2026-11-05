// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CLAUDE_CONFIG_DIR_ENV,
  CREDENTIAL_FILE,
  isolationEnv,
  prepareIsolatedConfig,
  realClaudeConfigDir,
  SECURESTORAGE_CONFIG_DIR_ENV,
} from "./config-isolation"

function fakeOperatorConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "liaison-real-claude-"))
  writeFileSync(join(dir, CREDENTIAL_FILE), '{"claudeAiOauth":{"accessToken":"secret"}}')
  writeFileSync(join(dir, "settings.json"), '{"mcpServers":{"gmail":{}}}')
  writeFileSync(join(dir, ".claude.json"), '{"projects":{}}')
  mkdirSync(join(dir, "projects"))
  return dir
}

describe("prepareIsolatedConfig", () => {
  it("carries the credential across and NOTHING else", () => {
    const isolatedDir = join(mkdtempSync(join(tmpdir(), "liaison-isolated-")), "claude-config")
    const { dir, copied } = prepareIsolatedConfig({
      realConfigDir: fakeOperatorConfig(),
      isolatedDir,
    })
    expect(dir).toBe(isolatedDir)
    expect(copied).toEqual([CREDENTIAL_FILE])
    // The operator's settings, their MCP servers and their connectors are the
    // whole reason this directory exists: one file, and it is the credential.
    expect(readdirSync(isolatedDir)).toEqual([CREDENTIAL_FILE])
  })

  it("makes the directory owner only, because it holds a credential", () => {
    const isolatedDir = join(mkdtempSync(join(tmpdir(), "liaison-isolated-")), "claude-config")
    prepareIsolatedConfig({ realConfigDir: fakeOperatorConfig(), isolatedDir })
    expect(statSync(isolatedDir).mode & 0o777).toBe(0o700)
    expect(statSync(join(isolatedDir, CREDENTIAL_FILE)).mode & 0o777).toBe(0o600)
  })

  it("is happy when the operator has no plaintext credential file at all", () => {
    // The macOS case: the credential is a keychain item, not a file.
    const realConfigDir = mkdtempSync(join(tmpdir(), "liaison-real-claude-"))
    const isolatedDir = join(mkdtempSync(join(tmpdir(), "liaison-isolated-")), "claude-config")
    const { copied } = prepareIsolatedConfig({ realConfigDir, isolatedDir })
    expect(copied).toEqual([])
    expect(readdirSync(isolatedDir)).toEqual([])
  })
})

describe("isolationEnv", () => {
  /**
   * The one line that separates isolation from losing the login. The CLI
   * derives its keychain service name from `CLAUDE_CONFIG_DIR` unless
   * `CLAUDE_SECURESTORAGE_CONFIG_DIR` is defined and empty, in which case the
   * credential store stays the default one and only everything else moves.
   */
  it("moves the config directory and pins the credential store to the default", () => {
    const env = isolationEnv("/data/liaison-desktop/claude-config")
    expect(env[CLAUDE_CONFIG_DIR_ENV]).toBe("/data/liaison-desktop/claude-config")
    expect(env[SECURESTORAGE_CONFIG_DIR_ENV]).toBe("")
    expect(Object.hasOwn(env, SECURESTORAGE_CONFIG_DIR_ENV)).toBe(true)
  })
})

describe("realClaudeConfigDir", () => {
  it("is the operator's own CLAUDE_CONFIG_DIR when they set one", () => {
    expect(realClaudeConfigDir({ [CLAUDE_CONFIG_DIR_ENV]: "/opt/claude" }, "/home/a")).toBe(
      "/opt/claude",
    )
  })

  it("is ~/.claude otherwise", () => {
    expect(realClaudeConfigDir({}, "/home/a")).toBe("/home/a/.claude")
  })
})
