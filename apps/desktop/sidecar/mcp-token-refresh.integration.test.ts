// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE REAL CLI, PAST THE TOKEN'S LIFE (2026-09-23). The unit tests prove the
// helper prints a working header; only the Claude CLI bundled with the pinned
// SDK can prove it actually RE-RUNS the helper when a Liaison call comes back
// 401 in the middle of a session. So: a fake Liaison (gateway + token route),
// the sidecar run from source, a real haiku turn that calls the fake's one
// tool, the server's clock moved past the token's life, and a second turn that
// calls it again. Before the fix the second turn's call was a 401 for good
// (the header was the spawn token); after it, the CLI meets the 401, re-runs
// the helper, which renews, and retries.
//
// Live: it needs this machine's Claude Code login and spends two haiku turns,
// so it runs only with LIAISON_SIDECAR_LIVE_CLI=1.
import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { startFakeLiaison } from "./fake-liaison-mcp"
import { jwtExpiryMs } from "./mcp-token"

const live = process.env.LIAISON_SIDECAR_LIVE_CLI === "1"
const TTL_MS = 15 * 60_000

interface Line {
  type: string
  [key: string]: unknown
}

describe.skipIf(!live)("a live local session past its MCP token's life", () => {
  it("still reaches Liaison on the turn after the token expired", async () => {
    const fake = startFakeLiaison({ ttlMs: TTL_MS })
    const dir = mkdtempSync(path.join(tmpdir(), "sidecar-live-refresh "))
    const config = path.join(dir, "liaison-mcp-config.json")
    const spawnToken = fake.mint()
    writeFileSync(
      config,
      JSON.stringify({
        liaisonMcpUrl: fake.mcpUrl,
        agentScopedToken: spawnToken,
        tokenExpiresAtMs: jwtExpiryMs(spawnToken),
        refreshToken: fake.refreshToken,
        tokenUrl: fake.tokenUrl,
        agentDefinition: "",
      }),
      { mode: 0o600 },
    )
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "index.ts"),
        "--mcp-config",
        config,
        "--model",
        "claude-haiku-4-5",
        "--cwd",
        dir,
        "--permission-mode",
        "bypass",
        "--isolate-config",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    )
    const lines: Line[] = []
    let raw = ""
    let turnsDone = 0
    const waiters: Array<() => void> = []
    void (async () => {
      const decoder = new TextDecoder()
      let buffered = ""
      for await (const chunk of child.stdout) {
        const text = decoder.decode(chunk, { stream: true })
        raw += text
        buffered += text
        let cut = buffered.indexOf("\n")
        while (cut >= 0) {
          const line = buffered.slice(0, cut)
          buffered = buffered.slice(cut + 1)
          cut = buffered.indexOf("\n")
          try {
            const parsed = JSON.parse(line) as Line
            lines.push(parsed)
            if (parsed.type === "turn_done" || parsed.type === "done") {
              turnsDone += 1
              waiters.shift()?.()
            }
          } catch {
            // Not a protocol line.
          }
        }
      }
    })()
    const stderr = new Response(child.stderr).text()
    const turn = (prompt: string) => {
      const done = new Promise<void>((resolve) => waiters.push(resolve))
      child.stdin.write(`${JSON.stringify({ type: "turn", prompt })}\n`)
      child.stdin.flush()
      return done
    }
    const prompt =
      "Call the liaison_ping tool of the liaison MCP server (mcp__liaison__liaison_ping) " +
      "exactly once, then reply with the single word it returned."
    const timer = setTimeout(() => child.kill(), 280_000)
    try {
      await turn(prompt)
      const firstTurnCalls = fake.calls.length
      expect(fake.calls.some((call) => call.accepted)).toBe(true)

      // The spawn token is dead on the server's clock (this machine's clock
      // still says it is alive, so nothing renews it ahead of time: only the
      // 401 path can save the next call).
      fake.advance(TTL_MS + 60_000)
      await turn(prompt)
      child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`)
      child.stdin.flush()
      await child.exited

      const secondTurn = fake.calls.slice(firstTurnCalls)
      console.log(
        `[live-refresh] turns=${turnsDone} renewals=${fake.renewals} ` +
          `second-turn calls=${JSON.stringify(secondTurn.map((call) => call.accepted))}`,
      )
      // The CLI presented the dead token, met the 401, and the retry with a
      // renewed one went through.
      expect(secondTurn.length).toBeGreaterThan(0)
      expect(secondTurn.at(-1)?.accepted).toBe(true)
      expect(secondTurn.at(-1)?.token).not.toBe(spawnToken)
      expect(fake.renewals).toBeGreaterThan(0)
      // No token ever reaches the sidecar's own output.
      const everything = raw + (await stderr)
      for (const call of fake.calls) expect(everything).not.toContain(call.token)
      expect(everything).not.toContain(fake.refreshToken)
    } finally {
      clearTimeout(timer)
      child.kill()
      fake.stop()
    }
  }, 300_000)
})
