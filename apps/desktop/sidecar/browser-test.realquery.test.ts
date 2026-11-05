// SPDX-License-Identifier: FSL-1.1-ALv2
//
// REAL QUERY: a browser test at Standard (D55, walk W1-D5). Headless Chromium
// cannot start inside the CLI sandbox (D25), so Standard exempts the
// Playwright test runners from it and asks the owner for every run. Through
// runUnattended, the bundled CLI, claude-haiku-5-5, an owner session in place
// on a repository with a Playwright `webServer` test:
//
// - the run parks on a permission request for the runner command;
// - once the owner allows it (a permission_decision on the control lines, as
//   the shell writes it), the test runs outside the sandbox and passes.
//
// The repository comes from LIAISON_RQ_PLAYWRIGHT_REPO (installed
// @playwright/test, a passing test with a webServer); the owner config is a
// scratch folder, never the real ~/.claude. Skipped unless macOS, the CLI
// signed in, and the repository set.
import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  commandLine,
  type NodeSessionCommand,
} from "../../../packages/shared/src/node-session-protocol"
import { AsyncQueue } from "./index"
import { runUnattended, type UnattendedJob } from "./unattended"

function signedIn(): boolean {
  if (process.platform !== "darwin") return false
  try {
    const status = Bun.spawnSync(["claude", "auth", "status"], { stdout: "pipe", stderr: "pipe" })
    return (JSON.parse(status.stdout.toString()) as { loggedIn?: boolean }).loggedIn === true
  } catch {
    return false
  }
}

const REPO = process.env.LIAISON_RQ_PLAYWRIGHT_REPO ?? ""
const BUNDLED = path.join(
  import.meta.dir,
  "node_modules",
  "@anthropic-ai",
  `claude-agent-sdk-darwin-${process.arch}`,
  "claude",
)
const READY =
  signedIn() && REPO !== "" && existsSync(path.join(REPO, "node_modules", "@playwright", "test"))
if (!READY) {
  process.stderr.write(
    "browser-test.realquery: SKIPPED - not macOS, the CLI not signed in, or LIAISON_RQ_PLAYWRIGHT_REPO unset\n",
  )
}
const MODEL = "claude-haiku-5-5"
const RUN_MS = 300_000
const tmpBase = READY ? realpathSync(mkdtempSync(path.join(tmpdir(), "liaison-browser-rq-"))) : ""
afterAll(() => {
  if (READY) rmSync(tmpBase, { recursive: true, force: true })
})

type Ev = { type: string; payload: Record<string, unknown> }

async function until(check: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(200)
  }
}

describe.if(READY)("D55: a browser test at Standard asks the owner, then passes", () => {
  it(
    "D55: the run parks on a permission request for the Playwright runner; allowed, the webServer test is green",
    async () => {
      const version = /(\d+\.\d+\.\d+)/.exec(
        Bun.spawnSync([BUNDLED, "--version"], { stdout: "pipe" }).stdout.toString(),
      )?.[1] as string
      const ownerConfig = path.join(tmpBase, "owner-claude")
      const nodeRoot = path.join(tmpBase, "Liaison Node")
      mkdirSync(ownerConfig, { recursive: true })
      mkdirSync(nodeRoot, { recursive: true })
      const repo = realpathSync(REPO)
      const job: UnattendedJob = {
        jobId: "5d5d5d5d-2222-4333-8444-555555555555",
        server: "https://liaison.example",
        agentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        agentName: "Personal",
        model: MODEL,
        profile: { level: "standard", liaisonTools: false },
        session: {
          id: "5d5d5d5d-1111-4222-8333-444444444444",
          source: "dispatch",
          model: MODEL,
          level: "standard",
          profileLevel: "standard",
          configKind: "owner",
          liaisonTools: false,
          folderPath: repo,
          folderName: path.basename(repo),
          finishWith: "none",
        },
        sharedFolders: [{ name: path.basename(repo), path: repo, kind: "repo" }],
        prompt: [
          "Run exactly this one Bash command, on its own, once: `npx playwright test --reporter=line`",
          "Do not run any other command and do not edit any file.",
          "Then reply with one line saying whether the test passed, and stop.",
        ].join("\n"),
        hardTokenLimit: null,
        nodeRoot,
      }
      const lines: Array<Record<string, unknown>> = []
      const control = new AsyncQueue<string>()
      const running = runUnattended({
        job,
        emit: (l) => lines.push(l),
        control,
        cliPath: BUNDLED,
        npmPrefix: null,
        claudeBinary: { bundledVersion: version, run: async () => null },
        dataDir: path.join(tmpBase, "data"),
        realConfigDir: ownerConfig,
        stopGraceMs: 10_000,
      })
      const events = () =>
        lines.filter((l) => l.type === "session_events").flatMap((l) => l.events as Ev[])
      const isRunner = (e: Ev) =>
        e.type === "permission_request" &&
        e.payload.tool === "Bash" &&
        /playwright test/.test(String((e.payload.input as { command?: unknown })?.command))
      await until(() => events().some(isRunner), RUN_MS / 2)
      const request = events().find(isRunner) as Ev
      // Parked: the runner has not run before the owner's answer.
      const requestId = String(request.payload.requestId)
      expect(events().some((e) => e.type === "tool_result" && e.payload.id === requestId)).toBe(
        false,
      )
      process.stderr.write(
        `browser-test.realquery: parked on ${JSON.stringify(request.payload).slice(0, 400)}\n`,
      )
      const decision: NodeSessionCommand = {
        type: "permission_decision",
        payload: { requestId, allow: true, scope: "once" },
      } as NodeSessionCommand
      control.push(
        commandLine({
          type: "command",
          commandId: "00000000-0000-4000-8000-000000000001",
          seq: 1,
          command: decision,
        }),
      )
      const outcome = await running
      const result = events().find((e) => e.type === "tool_result" && e.payload.id === requestId)
      const output = JSON.stringify(result?.payload ?? null)
      process.stderr.write(
        `browser-test.realquery: status=${outcome.status} result=${output.slice(0, 1500)}\n`,
      )
      expect(
        events()
          .filter((e) => e.type === "decision")
          .map((e) => e.payload.outcome),
      ).toContain("allow")
      expect(result?.payload.isError).not.toBe(true)
      expect(output).toMatch(/\d+ passed/)
      expect(output).not.toMatch(/MachPortRendezvous|Permission denied \(1100\)/)
    },
    RUN_MS,
  )
})
