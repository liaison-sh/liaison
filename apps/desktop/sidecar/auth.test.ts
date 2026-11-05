// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Local models run on the user's own Claude Code login, never on a Liaison
// key: no org BYOK key may ever reach a client process. So the shipping
// assertion is that a turn completes with no Anthropic key anywhere in the
// environment, and that losing the login is a loud non-zero exit rather than a
// hang or a silent empty answer.
import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildOne } from "./build"
import { runSidecar, sidecarEnvironment } from "./integration-harness"

const env = sidecarEnvironment()

const CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const

function environmentWithoutKeys(extra: Record<string, string> = {}) {
  const copy = { ...process.env } as Record<string, string | undefined>
  for (const name of CREDENTIAL_VARS) delete copy[name]
  return { ...copy, ...extra }
}

describe.skipIf(!env)("sidecar auth", () => {
  const live = env as NonNullable<typeof env>

  function configFile(): string {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "sidecar-auth-")), "mcp.json")
    writeFileSync(
      file,
      JSON.stringify({
        liaisonMcpUrl: live.mcpUrl,
        agentScopedToken: live.mcpToken,
        agentDefinition: "",
      }),
    )
    return file
  }

  it("completes a turn on the user's own login with no Anthropic key in the environment", async () => {
    const run = await runSidecar({
      binary: buildOne("bun-darwin-arm64"),
      args: ["--mcp-config", configFile(), "--model", live.model, "--permission-mode", "bypass"],
      prompt: "Reply with the single word ready and call no tools.",
      timeoutMs: 180_000,
      env: environmentWithoutKeys(),
    })

    for (const name of CREDENTIAL_VARS) {
      expect(run.events.some((event) => JSON.stringify(event).includes(name))).toBe(false)
    }
    const result = run.events.find((event) => event.event === "result")?.payload as {
      subtype: string
      is_error?: boolean
    }
    expect(result?.subtype).toBe("success")
    expect(result?.is_error ?? false).toBe(false)
    expect(run.exitCode).toBe(0)

    // The model that answered is part of the record, not an implementation
    // detail: D12 says a Local turn is the user's own account, so which model
    // their login resolves to is what actually ran.
    const init = run.events.find((event) => event.event === "init")?.payload as { model: string }
    expect(init.model).toBe(live.model)
  }, 240_000)

  it("exits non zero and names the missing credential when the login is gone", async () => {
    // An empty config directory is a machine with no Claude Code login on it.
    const run = await runSidecar({
      binary: buildOne("bun-darwin-arm64"),
      args: ["--mcp-config", configFile(), "--model", live.model, "--permission-mode", "bypass"],
      prompt: "Reply with the single word ready and call no tools.",
      timeoutMs: 180_000,
      env: environmentWithoutKeys({
        CLAUDE_CONFIG_DIR: mkdtempSync(path.join(tmpdir(), "sidecar-nologin-")),
      }),
    })

    expect(run.exitCode).not.toBe(0)
    const said = JSON.stringify(run.events)
    expect(said).toMatch(/logged in|login|credential/i)
    // And it said so rather than hanging: the stream was terminated properly.
    expect(run.events.at(-1)).toEqual({ type: "done" })
  }, 240_000)
})
