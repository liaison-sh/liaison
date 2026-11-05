// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S51 (owner D13, OPEN-3): who else drives an in-place owner session. Scratch
// config dirs only, never the owner's real ~/.claude.
import { afterAll, describe, expect, it } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  DRIVER_RECENT_WRITE_MS,
  type DriverProbe,
  drivenElsewhere,
  liveRegistry,
  ownClaudeChildren,
  systemDriverProbe,
} from "./session-driver"

const ID = "41173e76-dc0a-4f5f-8c7a-fde5d5329047"
const OTHER = "3ee6dad9-9757-49f0-9538-aa032be9b1af"
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function scratch(): { config: string; jsonl: string } {
  const config = mkdtempSync(path.join(tmpdir(), "driver-cfg-"))
  roots.push(config)
  const dir = path.join(config, "projects", "-tmp-repo")
  mkdirSync(dir, { recursive: true })
  const jsonl = path.join(dir, `${ID}.jsonl`)
  writeFileSync(jsonl, '{"type":"user"}\n')
  return { config, jsonl }
}

function registryEntry(config: string, pid: number, sessionId: string, entrypoint: string): void {
  mkdirSync(path.join(config, "sessions"), { recursive: true })
  writeFileSync(
    path.join(config, "sessions", `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: "/tmp/repo", kind: "interactive", entrypoint }),
  )
}

/** A probe over a fixed process table and the real file system (the scratch dir). */
function probe(
  processes: Array<{ pid: number; ppid?: number; args: string }> | null,
  platform = "darwin",
) {
  const sys = systemDriverProbe()
  const p: DriverProbe = { ...sys, processes: () => processes, platform }
  return p
}

const NOW = Date.parse("2026-10-15T15:00:00Z")
function setMtime(file: string, at: number): void {
  utimesSync(file, at / 1000, at / 1000)
}

describe("drivenElsewhere", () => {
  it("a session id's pattern characters match only themselves in another claude's argv", () => {
    const { config, jsonl } = scratch()
    setMtime(jsonl, NOW - 3_600_000)
    const check = (sessionId: string) => ({
      jsonl,
      sessionId,
      configDir: config,
      ownPids: new Set<number>(),
      ownLastWriteMs: null,
      now: NOW,
    })
    const table = [{ pid: 5151, args: "claude --resume axb-c" }]
    expect(drivenElsewhere(check("a.b-c"), probe(table)).elsewhere).toBe(false)
    expect(drivenElsewhere(check("axb-c"), probe(table))).toEqual({
      elsewhere: true,
      signal: "argv",
      via: "cli",
    })
  })

  it("S51: a recent foreign write marks the session driven elsewhere; the node's own write does not", () => {
    const { config, jsonl } = scratch()
    setMtime(jsonl, NOW - 5_000)
    const foreign = drivenElsewhere(
      {
        jsonl,
        sessionId: ID,
        configDir: config,
        ownPids: new Set(),
        ownLastWriteMs: NOW - 120_000,
        now: NOW,
      },
      probe([]),
    )
    expect(foreign).toEqual({ elsewhere: true, signal: "recent_write", via: null })

    // The node's own CLI wrote it last (its last write is at or after the mtime).
    const own = drivenElsewhere(
      {
        jsonl,
        sessionId: ID,
        configDir: config,
        ownPids: new Set(),
        ownLastWriteMs: NOW - 5_000,
        now: NOW,
      },
      probe([]),
    )
    expect(own).toEqual({ elsewhere: false, signal: null, via: null })

    // An old write is nobody's drive.
    setMtime(jsonl, NOW - DRIVER_RECENT_WRITE_MS - 1_000)
    const old = drivenElsewhere(
      {
        jsonl,
        sessionId: ID,
        configDir: config,
        ownPids: new Set(),
        ownLastWriteMs: null,
        now: NOW,
      },
      probe([]),
    )
    expect(old.elsewhere).toBe(false)
  })

  it("S51: a recent write is read from the transcript's last entrypoint: the node's own is not a driver even with no record of it (F3)", () => {
    const { config, jsonl } = scratch()
    const line = (entrypoint: string) =>
      JSON.stringify({ type: "assistant", entrypoint, sessionId: ID, message: { content: [] } })
    const base = {
      jsonl,
      sessionId: ID,
      configDir: config,
      ownPids: new Set<number>(),
      // The node died mid-run: it never recorded its own last write.
      ownLastWriteMs: null,
      now: NOW,
    }
    // The node's CLI wrote last; the CLI's bookkeeping lines carry no entrypoint.
    writeFileSync(
      jsonl,
      `${line("claude-vscode")}\n${line("liaison-node")}\n{"type":"last-prompt"}\n{"type":"cost-state"}\n`,
    )
    setMtime(jsonl, NOW - 5_000)
    expect(drivenElsewhere(base, probe([]))).toEqual({ elsewhere: false, signal: null, via: null })
    // VS Code or a terminal wrote last: driven elsewhere, and by whom.
    for (const [entrypoint, via] of [
      ["claude-vscode", "vscode"],
      ["cli", "cli"],
      ["sdk-ts", null],
    ] as const) {
      writeFileSync(jsonl, `${line("liaison-node")}\n${line(entrypoint)}\n{"type":"last-prompt"}\n`)
      setMtime(jsonl, NOW - 5_000)
      expect({ entrypoint, verdict: drivenElsewhere(base, probe([])) }).toEqual({
        entrypoint,
        verdict: { elsewhere: true, signal: "recent_write", via },
      })
    }
    // The registry still comes first: a live VS Code on the id drives it whoever wrote last.
    writeFileSync(jsonl, `${line("liaison-node")}\n`)
    setMtime(jsonl, NOW - 5_000)
    registryEntry(config, 4242, ID, "claude-vscode")
    expect(drivenElsewhere(base, probe([{ pid: 4242, args: "claude" }]))).toEqual({
      elsewhere: true,
      signal: "registry",
      via: "vscode",
    })
  })

  it("S51: a live Claude Code registered on the session id drives it (macOS), whatever the write time", () => {
    const { config, jsonl } = scratch()
    setMtime(jsonl, NOW - 3_600_000)
    registryEntry(config, 4242, ID, "claude-vscode")
    registryEntry(config, 4343, OTHER, "cli")
    const live = drivenElsewhere(
      {
        jsonl,
        sessionId: ID,
        configDir: config,
        ownPids: new Set(),
        ownLastWriteMs: null,
        now: NOW,
      },
      probe([
        { pid: 4242, args: "/x/native-binary/claude --output-format stream-json" },
        { pid: 4343, args: "claude" },
      ]),
    )
    expect(live).toEqual({ elsewhere: true, signal: "registry", via: "vscode" })

    // Its process exited (or crashed and the pid is not a claude any more): stale entry.
    const exited = drivenElsewhere(
      {
        jsonl,
        sessionId: ID,
        configDir: config,
        ownPids: new Set(),
        ownLastWriteMs: null,
        now: NOW,
      },
      probe([{ pid: 4242, args: "/usr/bin/vim notes.txt" }]),
    )
    expect(exited.elsewhere).toBe(false)

    // The node's own process never counts.
    const mine = drivenElsewhere(
      {
        jsonl,
        sessionId: ID,
        configDir: config,
        ownPids: new Set([4242]),
        ownLastWriteMs: null,
        now: NOW,
      },
      probe([{ pid: 4242, args: "claude" }]),
    )
    expect(mine.elsewhere).toBe(false)
  })

  it("D33 (batch-4 F3): an orphaned claude (parent launchd) holding the session still drives it, quiet or not, and is named by its pid", () => {
    // An extension host restart leaves the old VS Code child running with
    // parent pid 1: it holds the registry entry and the --resume argument
    // with no editor behind it, and may still be mid-turn (a long tool call
    // writes nothing). Liaison never resumes over it silently.
    const { config, jsonl } = scratch()
    setMtime(jsonl, NOW - 3_600_000)
    registryEntry(config, 5093, ID, "claude-vscode")
    const base = {
      jsonl,
      sessionId: ID,
      configDir: config,
      ownPids: new Set<number>(),
      ownLastWriteMs: null,
      now: NOW,
    }
    const vscodeArgs = `/Users/x/.vscode/extensions/anthropic.claude-code-2.1.296-darwin-arm64/resources/native-binary/claude --resume=${ID}`
    const orphan = drivenElsewhere(base, probe([{ pid: 5093, ppid: 1, args: vscodeArgs }]))
    expect(orphan).toEqual({ elsewhere: true, signal: "registry", via: null, orphanPid: 5093 })
    // Five minutes quiet: still held.
    setMtime(jsonl, NOW - 300_000)
    expect(drivenElsewhere(base, probe([{ pid: 5093, ppid: 1, args: vscodeArgs }]))).toEqual({
      elsewhere: true,
      signal: "registry",
      via: null,
      orphanPid: 5093,
    })
    // The same process under its extension host is VS Code driving it.
    const live = drivenElsewhere(base, probe([{ pid: 5093, ppid: 4100, args: vscodeArgs }]))
    expect(live).toEqual({ elsewhere: true, signal: "registry", via: "vscode" })
  })

  it("D33 (batch-4 F3): an orphaned claude resuming the id by its arguments alone (no registry entry) still drives it", () => {
    const { config, jsonl } = scratch()
    setMtime(jsonl, NOW - 3_600_000)
    const base = { jsonl, sessionId: ID, configDir: config, ownLastWriteMs: null, now: NOW }
    expect(
      drivenElsewhere(
        { ...base, ownPids: new Set() },
        probe([{ pid: 77, ppid: 1, args: `claude -p --resume ${ID}` }]),
      ),
    ).toEqual({ elsewhere: true, signal: "argv", via: null, orphanPid: 77 })
  })

  it("S51: a claude process resuming the id by its arguments drives it; another id does not", () => {
    const { config, jsonl } = scratch()
    setMtime(jsonl, NOW - 3_600_000)
    const base = { jsonl, sessionId: ID, configDir: config, ownLastWriteMs: null, now: NOW }
    for (const args of [`claude --resume=${ID}`, `claude -p --resume ${ID}`, `claude -r ${ID}`]) {
      expect(drivenElsewhere({ ...base, ownPids: new Set() }, probe([{ pid: 9, args }]))).toEqual({
        elsewhere: true,
        signal: "argv",
        via: "cli",
      })
    }
    const vscode = `/Users/x/.vscode/extensions/anthropic.claude-code-2.1.296-darwin-arm64/resources/native-binary/claude --resume=${ID}`
    expect(
      drivenElsewhere({ ...base, ownPids: new Set() }, probe([{ pid: 9, args: vscode }])).via,
    ).toBe("vscode")
    expect(
      drivenElsewhere(
        { ...base, ownPids: new Set() },
        probe([{ pid: 9, args: `claude --resume=${OTHER}` }]),
      ).elsewhere,
    ).toBe(false)
    expect(
      drivenElsewhere(
        { ...base, ownPids: new Set([9]) },
        probe([{ pid: 9, args: `claude --resume=${ID}` }]),
      ).elsewhere,
    ).toBe(false)
  })

  it("S51: off macOS only the recent write counts (documented fallback)", () => {
    const { config, jsonl } = scratch()
    setMtime(jsonl, NOW - 3_600_000)
    registryEntry(config, 4242, ID, "claude-vscode")
    const base = {
      jsonl,
      sessionId: ID,
      configDir: config,
      ownPids: new Set<number>(),
      ownLastWriteMs: null,
      now: NOW,
    }
    for (const platform of ["linux", "win32"]) {
      expect(
        drivenElsewhere(base, probe([{ pid: 4242, args: `claude --resume=${ID}` }], platform))
          .elsewhere,
      ).toBe(false)
    }
    setMtime(jsonl, NOW - 1_000)
    expect(drivenElsewhere(base, probe(null, "win32"))).toEqual({
      elsewhere: true,
      signal: "recent_write",
      via: null,
    })
  })

  it("S51: no transcript, no registry and no process is not driven", () => {
    const config = mkdtempSync(path.join(tmpdir(), "driver-cfg-"))
    roots.push(config)
    expect(
      drivenElsewhere(
        {
          jsonl: path.join(config, "projects", "x", `${ID}.jsonl`),
          sessionId: ID,
          configDir: config,
          ownPids: new Set(),
          ownLastWriteMs: null,
          now: NOW,
        },
        probe([]),
      ),
    ).toEqual({ elsewhere: false, signal: null, via: null })
  })

  it("S51: liveRegistry skips unreadable entries and the CLI's .key and .lock files", () => {
    const { config } = scratch()
    registryEntry(config, 7, ID, "cli")
    writeFileSync(path.join(config, "sessions", "8.json"), "{not json")
    writeFileSync(path.join(config, "sessions", "9.lock"), "")
    writeFileSync(path.join(config, "sessions", "10.abc.key"), "k")
    expect(liveRegistry(config)).toEqual([{ pid: 7, sessionId: ID, entrypoint: "cli" }])
  })
})

describe("W1-D3 the node's own leftover claude", () => {
  /** The node's mirror config dir of one session, beside the owner's. */
  function nodeWorld() {
    const { config, jsonl } = scratch()
    const nodeConfig = mkdtempSync(path.join(tmpdir(), "driver-node-cfg-"))
    roots.push(nodeConfig)
    // The node's own run wrote the transcript last, two minutes ago.
    writeFileSync(jsonl, `${JSON.stringify({ type: "user", entrypoint: "liaison-node" })}\n`)
    setMtime(jsonl, NOW - 120_000)
    return { config, jsonl, nodeConfig }
  }
  // A first run's child: no --resume, the SDK's own flags only.
  const firstRunArgs =
    "/tmp/claude-501/abc/claude --output-format stream-json --verbose --input-format stream-json"

  it("W1-D3: a claude of the node's own earlier run, orphaned with no --resume and registered in the session's config dir, holds the session", () => {
    const { config, jsonl, nodeConfig } = nodeWorld()
    registryEntry(nodeConfig, 20847, ID, "sdk-ts")
    const check = {
      jsonl,
      sessionId: ID,
      configDir: config,
      nodeConfigDir: nodeConfig,
      ownPids: new Set<number>([999]),
      ownLastWriteMs: null,
      now: NOW,
    }
    expect(drivenElsewhere(check, probe([{ pid: 20847, ppid: 1, args: firstRunArgs }]))).toEqual({
      elsewhere: true,
      signal: "registry",
      via: null,
      orphanPid: 20847,
    })
    // Its runner still alive: another live run, never a second one beside it.
    expect(drivenElsewhere(check, probe([{ pid: 20847, ppid: 4321, args: firstRunArgs }]))).toEqual(
      {
        elsewhere: true,
        signal: "registry",
        via: null,
      },
    )
    // A stale entry (the pid is gone or is not a claude), another session, or
    // this process's own child: not driven.
    expect(drivenElsewhere(check, probe([])).elsewhere).toBe(false)
    expect(
      drivenElsewhere(check, probe([{ pid: 20847, ppid: 1, args: "sleep 150" }])).elsewhere,
    ).toBe(false)
    expect(
      drivenElsewhere(
        { ...check, ownPids: new Set([20847]) },
        probe([{ pid: 20847, ppid: 1, args: firstRunArgs }]),
      ).elsewhere,
    ).toBe(false)
    registryEntry(nodeConfig, 20847, OTHER, "sdk-ts")
    expect(
      drivenElsewhere(check, probe([{ pid: 20847, ppid: 1, args: firstRunArgs }])).elsewhere,
    ).toBe(false)
  })

  it("W1-D3: ownClaudeChildren names only the claude this process started for the session", () => {
    const { nodeConfig } = nodeWorld()
    registryEntry(nodeConfig, 501, ID, "sdk-ts")
    registryEntry(nodeConfig, 502, ID, "sdk-ts")
    registryEntry(nodeConfig, 503, OTHER, "sdk-ts")
    const table = [
      { pid: 501, ppid: 77, args: firstRunArgs },
      { pid: 502, ppid: 1, args: firstRunArgs },
      { pid: 503, ppid: 77, args: firstRunArgs },
    ]
    expect(ownClaudeChildren(nodeConfig, ID, 77, probe(table))).toEqual([501])
    expect(ownClaudeChildren(nodeConfig, ID, 77, probe(null))).toEqual([])
  })

  it.skipIf(process.platform === "win32")(
    "W1-D3: a runner killed outright takes its claude with it (the watchdog), and a live runner's claude is left alone",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "driver-runner-"))
      roots.push(dir)
      const config = path.join(dir, "config")
      mkdirSync(path.join(config, "sessions"), { recursive: true })
      // A stand-in CLI under the name the registry check reads (a copied
      // system binary is killed by macOS, so a script).
      const claude = path.join(dir, "claude")
      writeFileSync(claude, "#!/bin/sh\nwhile :; do sleep 1; done\n")
      chmodSync(claude, 0o755)
      const here = import.meta.dir
      const runner = path.join(dir, "runner.ts")
      writeFileSync(
        runner,
        `import { writeFileSync } from "node:fs"
import { guardOwnClaude } from ${JSON.stringify(path.join(here, "session-driver.ts"))}
const child = Bun.spawn([${JSON.stringify(claude)}, "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
writeFileSync(${JSON.stringify(path.join(config, "sessions"))} + "/" + child.pid + ".json", JSON.stringify({ pid: child.pid, sessionId: ${JSON.stringify(ID)}, entrypoint: "sdk-ts" }))
const found = guardOwnClaude(${JSON.stringify(config)}, ${JSON.stringify(ID)}, new Set(), {
  command: [process.execPath, ${JSON.stringify(path.join(here, "index.ts"))}],
})
console.log(JSON.stringify({ child: child.pid, found }))
await Bun.sleep(120_000)
`,
      )
      const proc = Bun.spawn([process.execPath, runner], { stdout: "pipe", stderr: "inherit" })
      const reader = proc.stdout.getReader()
      let text = ""
      while (!text.includes("\n")) {
        const { value, done } = await reader.read()
        if (done) break
        text += new TextDecoder().decode(value)
      }
      const { child, found } = JSON.parse(text.trim()) as { child: number; found: number[] }
      expect(found).toEqual([child])
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }
      try {
        // While the runner lives, its claude is left alone.
        await Bun.sleep(1_000)
        expect(alive(child)).toBe(true)
        // The runner killed outright: its claude goes with it.
        proc.kill("SIGKILL")
        const deadline = Date.now() + 8_000
        while (alive(child) && Date.now() < deadline) await Bun.sleep(100)
        expect(alive(child)).toBe(false)
      } finally {
        if (alive(child)) process.kill(child, "SIGKILL")
      }
    },
    30_000,
  )
})
