// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CLAUDE_CONFIG_DIR_ENV,
  isolationEnv,
  SECURESTORAGE_CONFIG_DIR_ENV,
} from "./config-isolation"
import type { McpConfigFile, PermissionMode, SidecarConfig } from "./index"
import { folderAliases, mapPermissionMode, systemPromptChecksum, turnOptions } from "./sdk-runner"

describe("mapPermissionMode", () => {
  it("maps all five Liaison modes to SDK values, Auto on acceptEdits", () => {
    const modes: PermissionMode[] = ["auto", "manual", "edit", "plan", "bypass"]
    expect(modes.map(mapPermissionMode)).toEqual([
      "acceptEdits",
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ])
  })

  it("throws on an unknown mode", () => {
    expect(() => mapPermissionMode("bogus" as PermissionMode)).toThrow()
  })
})

function config(overrides: Partial<SidecarConfig> = {}): SidecarConfig {
  return {
    mcpConfigPath: "/tmp/mcp.json",
    cwd: "/tmp/work",
    permissionMode: "manual",
    model: "claude-haiku-4-5",
    isolateConfig: false,
    ...overrides,
  }
}

const MCP: McpConfigFile = {
  liaisonMcpUrl: "http://box:3000/mcp",
  agentScopedToken: "tok",
  agentDefinition: "you are @support",
}

describe("the session's Claude Code environment", () => {
  it("inherits the operator's own environment when nothing is isolated", () => {
    expect(turnOptions(config(), MCP).env).toBeUndefined()
  })

  /**
   * An isolated session still has to be able to log in, so the environment is
   * the operator's own PLUS the two variables that move the config directory
   * without moving the credential store.
   */
  it("replaces the config directory and keeps the credential store when it is", () => {
    const dir = mkdtempSync(join(tmpdir(), "liaison-isolated-env-"))
    const env = turnOptions(config({ isolateConfig: true }), MCP, isolationEnv(dir)).env
    expect(env?.[CLAUDE_CONFIG_DIR_ENV]).toBe(dir)
    expect(env?.[SECURESTORAGE_CONFIG_DIR_ENV]).toBe("")
    expect(env?.PATH).toBe(process.env.PATH)
  })
})

/**
 * The Liaison MCP server is the org's whole catalog: 478 tools and 439 KB of
 * JSON Schema measured on the demo org, about 170k prompt tokens. The SDK only
 * defers that behind its own tool search when the server does NOT declare
 * `alwaysLoad`; declaring it pins every schema into the turn-1 prompt and the
 * request dies before the model sees it. Measured against a stub MCP server
 * serving a catalog of that size: with `alwaysLoad`, "Prompt is too long, the
 * request is ~208663 tokens (limit 200000)" and no turn; without it, the turn
 * runs and the same catalog costs about 6k prompt tokens.
 */
describe("the Liaison MCP server's tool loading", () => {
  it("leaves the catalog deferrable so its schemas stay out of the prompt", () => {
    const liaison = turnOptions(config(), MCP).mcpServers?.liaison as Record<string, unknown>
    expect(liaison.type).toBe("http")
    expect(liaison.url).toBe(MCP.liaisonMcpUrl)
    expect("alwaysLoad" in liaison).toBe(false)
  })
})

/**
 * A RUNNING session has to be switchable to Bypass. The SDK refuses
 * `setPermissionMode("bypassPermissions")` on a session launched without
 * `allowDangerouslySkipPermissions` (measured against the pinned SDK: "Cannot
 * set permission mode to bypassPermissions because the session was not
 * launched with --dangerously-skip-permissions"), which is what made the
 * mode menu answer "not applied" after the user confirmed the dialog.
 */
describe("switching a running session's mode", () => {
  it("launches every session able to reach Bypass, while running in its own mode", () => {
    for (const mode of ["auto", "manual", "edit", "plan", "bypass"] as PermissionMode[]) {
      const options = turnOptions(config({ permissionMode: mode }), MCP)
      expect(options.allowDangerouslySkipPermissions).toBe(true)
      expect(options.permissionMode).toBe(mapPermissionMode(mode))
    }
  })
})

/**
 * Liaison skills live on the Liaison MCP. The SDK's own `Skill` tool answered
 * every Liaison skill name with "Unknown skill", and a small model reached for
 * it first on every report, so the session does not carry it at all.
 */
describe("the SDK's own Skill tool", () => {
  it("is not offered in any mode", () => {
    for (const mode of ["auto", "manual", "edit", "plan", "bypass"] as PermissionMode[]) {
      expect(turnOptions(config({ permissionMode: mode }), MCP).disallowedTools).toContain("Skill")
    }
  })

  it("leaves the Liaison skill tools alone", () => {
    const disallowed = turnOptions(config(), MCP).disallowedTools ?? []
    expect(disallowed.some((name) => name.includes("skill_"))).toBe(false)
  })
})

describe("the session folder's other spellings", () => {
  it("hands the CLI the home symlink spelling of a folder given by its real path", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "liaison-aliases-")))
    const documents = join(base, "Volumes", "Disk", "me", "Documents")
    const folder = join(documents, "Rapports Liaison")
    mkdirSync(folder, { recursive: true })
    const home = join(base, "Users", "me")
    mkdirSync(home, { recursive: true })
    symlinkSync(documents, join(home, "Documents"))
    const viaHome = join(home, "Documents", "Rapports Liaison")
    expect(folderAliases(folder, home)).toContain(viaHome)
    // Given by the symlink, the CLI's cwd is the real path; the given one is
    // the spelling it would otherwise refuse.
    expect(folderAliases(viaHome, home)).toContain(viaHome)
    expect(folderAliases(viaHome, home)).not.toContain(folder)
  })

  it("adds only true spellings of the folder, never its real path or another folder", () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "liaison-plain-")))
    const aliases = turnOptions(config({ cwd: folder }), MCP).additionalDirectories ?? []
    expect(aliases).not.toContain(folder)
    for (const alias of aliases) expect(realpathSync(alias)).toBe(folder)
  })
})

describe("the local session's system prompt", () => {
  // A local session read the server-oriented agent definition as running on
  // the server, and told the person to "open a local session" from inside one.
  it("says it runs on this computer, in the session folder, with a shell", () => {
    const prompt = turnOptions(config({ cwd: "/Users/ana/Rapports" }), MCP).systemPrompt
    if (typeof prompt !== "object" || prompt === null || Array.isArray(prompt))
      throw new Error("expected the preset form")
    expect(prompt).toMatchObject({ type: "preset", preset: "claude_code" })
    const append = (prompt as { append?: string }).append ?? ""
    // The agent definition first, the runtime note after it, with the last word.
    expect(append.startsWith(MCP.agentDefinition)).toBe(true)
    expect(append.indexOf("/Users/ana/Rapports")).toBeGreaterThan(
      append.indexOf(MCP.agentDefinition),
    )
    expect(append).toContain("Liaison desktop app's local session")
    expect(append).toContain("in the folder /Users/ana/Rapports")
    expect(append).toMatch(/You have a shell: Bash, Read, Write and Edit act on this computer/)
    expect(append).toContain("runs here, by you, now")
  })

  it("keeps the checksum on the agent definition alone, comparable with the server's", () => {
    const expected = new Bun.CryptoHasher("sha256").update(MCP.agentDefinition).digest("hex")
    expect(systemPromptChecksum(MCP)).toBe(expected)
    const a = turnOptions(config({ cwd: "/a" }), MCP).systemPrompt as { append: string }
    const b = turnOptions(config({ cwd: "/b" }), MCP).systemPrompt as { append: string }
    expect(a.append).not.toBe(b.append)
    expect(systemPromptChecksum(MCP)).toBe(expected)
  })
})
