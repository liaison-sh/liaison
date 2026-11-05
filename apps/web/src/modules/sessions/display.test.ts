// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T06: the pure display rules of the Sessions app (charter: status colours,
// no absolute path outside the folder chip tooltip, no time without a zone in
// a tooltip, Paused while the node is offline, P2-D3, P2-D4).
import { describe, expect, it } from "vitest"
import { translatorFor } from "~/modules/i18n/i18n-context"
import {
  countText,
  displayPath,
  displayStatus,
  elapsedMs,
  formatDuration,
  formatTimeWithZone,
  formatTokens,
  isEnded,
  NEUTRAL_TONE,
  originLabel,
  parseClaudeCode,
  plainInline,
  relativizePaths,
  STATUS_TONE,
  sessionTitle,
  startedByLabel,
  statusReasonText,
  systemText,
  toneOf,
} from "./display"
import type { NodeSessionRow } from "./session-api"

function row(over: Partial<NodeSessionRow> = {}): NodeSessionRow {
  return {
    id: "3f2a9c1e-0000-4000-8000-000000000001",
    ownerUserId: "u1",
    nodeId: "n1",
    jobId: "j1",
    agentId: "a1",
    source: "dispatch",
    configKind: "owner",
    sourceThreadId: null,
    sourceMessageId: null,
    title: "Fix the flaky test",
    folderName: "code",
    repo: null,
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-haiku-4-5",
    level: "strict",
    status: "running",
    pendingCount: 0,
    waitingReason: null,
    claudeCode: null,
    lastSeq: 0,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: null,
    error: null,
    createdAt: "2026-10-13T09:27:00.000Z",
    startedAt: "2026-10-13T10:00:00.000Z",
    endedAt: null,
    updatedAt: "2026-10-13T10:00:00.000Z",
    ...over,
  }
}

const t = (key: string, params?: Record<string, unknown>) =>
  `${key}${params ? JSON.stringify(params) : ""}`
const i18n = {
  t,
  fmtDate: (v: Date | number, o?: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-GB", { ...o, timeZone: "UTC" }).format(v),
}

describe("displayStatus (P2-D3)", () => {
  it("running on an offline node displays paused; queued stays queued", () => {
    expect(displayStatus(row({ status: "running" }), false)).toBe("paused")
    expect(displayStatus(row({ status: "waiting" }), false)).toBe("paused")
    expect(displayStatus(row({ status: "running" }), true)).toBe("running")
    expect(displayStatus(row({ status: "queued" }), false)).toBe("queued")
    expect(displayStatus(row({ status: "done" }), false)).toBe("done")
    expect(displayStatus(row({ status: "paused" }), true)).toBe("paused")
  })

  it("gives each status the charter's tone", () => {
    expect(STATUS_TONE.running.text).toBe("text-accent")
    expect(STATUS_TONE.waiting.text).toBe("text-warning")
    expect(STATUS_TONE.done.text).toBe("text-success")
    expect(STATUS_TONE.failed.text).toBe("text-error")
    expect(STATUS_TONE.paused.text).toBe("text-text-tertiary")
  })
})

describe("needs_you and unknown states (S9, D14)", () => {
  it("needs_you is ended and warning-toned", () => {
    expect(isEnded("needs_you")).toBe(true)
    expect(toneOf("needs_you")).toEqual(STATUS_TONE.waiting)
    // The wire carries status waiting and the true state: the state wins.
    const served = row({ status: "waiting", state: "needs_you" })
    expect(displayStatus(served, true)).toBe("needs_you")
    // An ended session is not "paused" when its node is offline.
    expect(displayStatus(served, false)).toBe("needs_you")
  })

  it("S9: an unknown state has the neutral tone and is not ended", () => {
    expect(toneOf("hibernating")).toEqual(NEUTRAL_TONE)
    expect(isEnded("hibernating")).toBe(false)
    expect(displayStatus(row({ status: "running", state: "hibernating" }), true)).toBe(
      "hibernating",
    )
  })
})

describe("displayPath (P2-D4)", () => {
  const sessionId = "3f2a9c1e-0000-4000-8000-000000000001"
  it("strips the worktree, the app session folder, the clone, the folder name, else the basename, and never returns a leading slash", () => {
    const ctx = { sessionId, folderName: "my-repo" }
    expect(displayPath("/Users/me/Liaison Node/worktrees/my-repo-3f2a9c1e0000/src/a.ts", ctx)).toBe(
      "src/a.ts",
    )
    expect(displayPath(`/Users/me/Liaison Node/sessions/${sessionId}/notes.md`, ctx)).toBe(
      "notes.md",
    )
    expect(
      displayPath("/Users/me/Liaison Node/agents/a1/sessions/3f2a9c1e0000/repo/lib/b.ts", {
        sessionId,
        repo: "https://gitlab.com/acme/repo.git",
      }),
    ).toBe("lib/b.ts")
    expect(displayPath("/Users/me/code/my-repo/README.md", ctx)).toBe("README.md")
    expect(displayPath("/etc/hosts", ctx)).toBe("hosts")
    expect(displayPath("C:\\Users\\me\\other\\x.txt", ctx)).toBe("x.txt")
    for (const p of ["/", "/Users/me/my-repo", "/Users/me/my-repo/"]) {
      const out = displayPath(p, ctx)
      expect(out.startsWith("/")).toBe(false)
      expect(out).not.toContain("/Users/")
    }
  })

  it("prefers the session's own working directory when the start event names it", () => {
    expect(displayPath("/w/x/y/src/z.ts", { sessionId, cwd: "/w/x/y" })).toBe("src/z.ts")
  })

  it("relativizes local paths inside text, and leaves URLs and system paths", () => {
    const ctx = { sessionId, folderName: "my-repo" }
    expect(
      relativizePaths(
        "I edited /Users/me/code/my-repo/src/a.ts and /Users/me/code/my-repo/b.md.",
        ctx,
      ),
    ).toBe("I edited src/a.ts and b.md.")
    expect(relativizePaths("ls '/Users/me/Liaison Node'", ctx)).not.toContain("/Users/")
    expect(relativizePaths("see https://x.dev/Users/a and /etc/hosts", ctx)).toBe(
      "see https://x.dev/Users/a and hosts",
    )
  })

  // m3: every way an absolute path reached the screen past the old matcher.
  const sid = "3f2a9c1e-0000-4000-8000-000000000001"
  const nodeRoot = "/Users/sam/Liaison Node"
  it.each([
    ["a file URL", "open file:///Users/me/code/my-repo/a.ts now", "open a.ts now"],
    ["after a redirect", "echo hi >/Users/me/code/my-repo/out.txt", "echo hi >out.txt"],
    ["after a pipe", "cat x |/Users/me/bin/tool", "cat x |tool"],
    ["a lowercase Windows home", "type c:\\users\\me\\secret.txt", "type secret.txt"],
    ["another drive", "copy D:\\work\\client\\plan.docx", "copy plan.docx"],
    ["a forward-slash drive", "see d:/work/client/plan.docx", "see plan.docx"],
    ["a non-home root", "ran /opt/acme/bin/run.sh twice", "ran run.sh twice"],
    ["a system path", "edited /etc/nginx/nginx.conf.", "edited nginx.conf."],
    [
      "the default node root with a space",
      `Reading ${nodeRoot}/sessions/${sid}/notes/todo.md now`,
      "Reading notes/todo.md now",
    ],
    [
      "a node-root worktree with a space",
      `diff ${nodeRoot}/worktrees/my-repo-3f2a9c1e0000/src/a.ts`,
      "diff src/a.ts",
    ],
    ["a quoted root with a space", `ls '${nodeRoot}'`, "ls 'Liaison Node'"],
    ["a path then prose", "Delete /Users/me/secret/notes.txt?", "Delete notes.txt?"],
    ["a home tilde", "cat ~/.ssh/config", "cat config"],
  ])("%s", (_name, input, expected) => {
    const out = relativizePaths(input, { sessionId: sid, folderName: "my-repo" })
    expect(out).toBe(expected)
    expect(out).not.toMatch(/(^|[\s'">|(=])(\/|[A-Za-z]:[\\/]|file:)/)
  })

  it("leaves URLs, relative paths and fractions alone", () => {
    const ctx = { sessionId: sid }
    for (const s of ["https://x.dev/a/b", "src/a/b.ts", "and/or", "1/2", "./run.sh", "a / b"]) {
      expect(relativizePaths(s, ctx)).toBe(s)
    }
  })

  it("keeps a relative path as it is", () => {
    expect(displayPath("src/a.ts", { sessionId })).toBe("src/a.ts")
  })
})

describe("formatting", () => {
  it("time tooltips carry a zone", () => {
    expect(formatTimeWithZone("2026-10-13T10:00:00.000Z", "en")).toMatch(
      /(UTC|GMT|[A-Z]{2,5}|[+-]\d)/,
    )
    const s = formatTimeWithZone("2026-10-13T10:00:00.000Z", "en")
    const zoneless = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date("2026-10-13T10:00:00.000Z"))
    expect(s).not.toBe(zoneless)
  })

  it("1.9M and 412k tokens", () => {
    expect(formatTokens(1_900_000)).toBe("1.9M")
    expect(formatTokens(412_000)).toBe("412k")
    expect(formatTokens(850)).toBe("850")
    expect(formatTokens(2_000_000)).toBe("2M")
  })

  it("durations read 42 s, 23 min, 1 h 42 min", () => {
    expect(formatDuration(42_000)).toBe("42 s")
    expect(formatDuration(23 * 60_000 + 5_000)).toBe("23 min")
    expect(formatDuration(102 * 60_000)).toBe("1 h 42 min")
  })

  it("elapsed runs from the start to the end, or to now while running", () => {
    const now = Date.parse("2026-10-13T10:00:42.000Z")
    expect(elapsedMs(row(), now)).toBe(42_000)
    expect(elapsedMs(row({ status: "done", endedAt: "2026-10-13T10:01:00.000Z" }), now)).toBe(
      60_000,
    )
    expect(elapsedMs(row({ startedAt: null, status: "queued" }), now)).toBe(0)
  })

  it("origin per source", () => {
    expect(originLabel(row({ source: "dispatch" }), "Personal agent", i18n)).toBe(
      'kernel.nodeSessions.origin.dispatch{"agent":"Personal agent","time":"09:27"}',
    )
    expect(originLabel(row({ source: "routine" }), "X", i18n)).toBe(
      "kernel.nodeSessions.origin.routine",
    )
    expect(originLabel(row({ source: "app" }), "X", i18n)).toBe("kernel.nodeSessions.origin.app")
    expect(originLabel(row({ source: "agent_tag" }), "Bot", i18n)).toBe(
      'kernel.nodeSessions.origin.agentTag{"agent":"Bot"}',
    )
  })

  it("the header's started-by sentence per source; an import has none", () => {
    expect(startedByLabel(row({ source: "dispatch" }), "Personal agent", i18n)).toBe(
      'kernel.nodeSessions.header.startedBy.dispatch{"agent":"Personal agent","time":"09:27"}',
    )
    expect(startedByLabel(row({ source: "app" }), "X", i18n)).toBe(
      'kernel.nodeSessions.header.startedBy.app{"time":"09:27"}',
    )
    expect(startedByLabel(row({ source: "import" }), "X", i18n)).toBeNull()
    expect(startedByLabel(row({ source: "future" as never }), "X", i18n)).toBe(
      'kernel.nodeSessions.header.startedBy.other{"time":"09:27"}',
    )
  })

  it("parses the Claude Code line", () => {
    expect(parseClaudeCode("2.1.7 installed /opt/homebrew/bin/claude")).toEqual({
      version: "2.1.7",
      source: "installed",
      path: "/opt/homebrew/bin/claude",
    })
    expect(parseClaudeCode(null)).toBeNull()
  })
})

// P1-walk D15: the node's own system lines and "unknown" stayed English in a
// French session view. The node sends codes and facts; the web says them.
describe("systemText and the Claude Code chip (D15)", () => {
  const fr = translatorFor("fr")
  const en = translatorFor("en")
  const start = {
    claudeCodeVersion: "2.1.286",
    claudeCodeSource: "bundled",
    level: "strict",
  }

  it("the start line is said in the viewer's language from its facts", () => {
    expect(systemText("start", "Claude Code 2.1.286 (bundled) started at strict", start, en)).toBe(
      "Claude Code 2.1.286 (bundled) started at Strict",
    )
    const french = systemText("start", "Claude Code 2.1.286 (bundled) started at strict", start, fr)
    expect(french).toContain("2.1.286")
    expect(french).toContain("intégré")
    expect(french).not.toContain("started")
    expect(systemText("start", "x", { ...start, claudeCodeVersion: null }, fr)).not.toContain(
      "unknown",
    )
  })

  it("W3-D2: a CLI task notification is a quiet line said from its facts, in both languages", () => {
    const agent = { kind: "task", status: "completed", agent: true, summary: 'Agent "x" finished' }
    expect(systemText("notification", 'Agent "x" finished', agent, en)).toBe("Subagent finished")
    expect(systemText("notification", "", { ...agent, status: "killed" }, en)).toBe(
      "Subagent stopped",
    )
    expect(systemText("notification", "", { status: "failed", agent: false }, en)).toBe(
      "Background task failed",
    )
    expect(systemText("notification", "", agent, fr)).toBe("Sous-agent terminé")
  })

  it("W1-D9: the server's effort_changed line (no text) is said from its data", () => {
    expect(systemText("effort_changed", "", { from: null, to: "xhigh" }, en)).toBe(
      "Reasoning: Extra high",
    )
    expect(systemText("effort_changed", "", { from: "high", to: null }, en)).toBe(
      "Reasoning: Default",
    )
    expect(systemText("effort_changed", "", { from: null, to: "max" }, fr)).toBe(
      "Raisonnement : Maximum",
    )
  })

  it("S27: the Artifact unavailable line is said from its data, never the node's English text", () => {
    const text = "Artifact unavailable on CLI 2.1.286"
    expect(systemText("artifact_unavailable", text, { claudeCodeVersion: "2.1.286" }, en)).toBe(
      "Artifact unavailable on Claude Code 2.1.286",
    )
    expect(systemText("artifact_unavailable", text, { claudeCodeVersion: "2.1.286" }, fr)).toBe(
      "Artifact indisponible sur Claude Code 2.1.286",
    )
    expect(systemText("artifact_unavailable", "x", { claudeCodeVersion: null }, fr)).toBe(
      "Artifact indisponible sur cette version de Claude Code",
    )
  })

  it("S51: the driver line is said from its code, never the node's English text", () => {
    const text = "Driven from VS Code"
    expect(systemText("driver", text, { elsewhere: true, via: "vscode" }, en)).toBe(
      "Driven from VS Code",
    )
    expect(systemText("driver", text, { elsewhere: true, via: "vscode" }, fr)).toBe(
      "Pilotée depuis VS Code",
    )
    expect(systemText("driver", "x", { elsewhere: true, via: "cli" }, en)).toBe(
      "Driven from a terminal",
    )
    expect(systemText("driver", "x", { elsewhere: true, via: null }, fr)).toBe(
      "Pilotée depuis un autre Claude Code",
    )
    expect(systemText("driver", "x", { elsewhere: false, via: null }, en)).toBe(
      "No other Claude Code drives this session now",
    )
  })

  it("settings_filtered, allowed_for_session and still_queued are said from their data", () => {
    const filtered = {
      hooksOff: true,
      userKeysNotMirrored: ["env", "apiKeyHelper"],
      mcpSkipped: [{ name: "github" }],
    }
    expect(systemText("settings_filtered", "Hooks are off; …", filtered, en)).toBe(
      "Hooks are off; not applied: env, apiKeyHelper; MCP servers skipped: github",
    )
    const french = systemText("settings_filtered", "Hooks are off; …", filtered, fr)
    expect(french).not.toContain("Hooks are off")
    expect(french).toContain("env, apiKeyHelper")
    expect(
      systemText("allowed_for_session", "Allowed for this session: Bash", { tool: "Bash" }, fr),
    ).not.toContain("Allowed")
    expect(systemText("still_queued", "Still queued when stopped: 2", { count: 2 }, fr)).toContain(
      "2",
    )
    expect(
      systemText("still_queued", "Still queued when stopped: 2", { count: 2 }, fr),
    ).not.toContain("Still queued")
  })

  it("an unknown subtype, or one without its facts, keeps the node's text", () => {
    expect(systemText("other", "Something happened", undefined, fr)).toBe("Something happened")
    expect(systemText("start", "Claude Code started", undefined, fr)).toBe("Claude Code started")
  })
})

describe("no raw code, no English in French (walk D12)", () => {
  const fr = translatorFor("fr")
  const en = translatorFor("en")
  const codes = [
    "node_offline",
    "node_silent",
    "node_back",
    "replaced",
    "discarded",
    "stopped_by_owner",
    "resume_offline",
    "resume_message",
    "resume_crash",
    "resume_level",
    "rerun",
  ]

  it("every status reason code is said in words, in both languages", () => {
    for (const code of codes) {
      for (const t of [fr, en]) {
        const said = statusReasonText(code, t)
        expect(said).not.toBe("")
        expect(said).not.toContain("_")
        expect(said).not.toContain("kernel.")
      }
      expect(statusReasonText(code, fr)).not.toBe(statusReasonText(code, en))
    }
    expect(statusReasonText("resume_message", fr)).toBe("reprise pour votre message")
  })

  it("a waiting reason is said, never shown as permission: Write", () => {
    expect(statusReasonText("permission: Write", fr)).toBe("autorisation pour Write")
    expect(statusReasonText("question: Choice", fr)).toBe("une question")
    expect(statusReasonText("plan: approve a plan", fr)).toBe("un plan à approuver")
    expect(statusReasonText("permission: Write", en)).toBe("permission for Write")
  })

  it("an unknown code shows nothing rather than itself", () => {
    expect(statusReasonText("some_new_code", fr)).toBe("")
    expect(statusReasonText("", fr)).toBe("")
  })

  it("the rate limit line is said in the viewer's language, with or without its data", () => {
    const changed = systemText("rate_limit", "Rate limit status changed", undefined, fr)
    expect(changed).not.toContain("Rate limit")
    expect(changed).not.toBe("")
    expect(systemText("rate_limit", "Rate limit status changed", { status: "rejected" }, fr)).toBe(
      "Limite d'utilisation atteinte",
    )
    expect(systemText("rate_limit", "Rate limit status changed", { status: "rejected" }, en)).toBe(
      "Usage limit reached",
    )
  })

  it("counts take the singular for one", () => {
    expect(countText(fr, "kernel.nodeSessions.transcript.lines", 1)).toBe("1 ligne")
    expect(countText(fr, "kernel.nodeSessions.transcript.lines", 3)).toBe("3 lignes")
    expect(countText(en, "kernel.nodeSessions.transcript.lines", 1)).toBe("1 line")
    expect(countText(fr, "kernel.nodeSessions.transcript.matches", 1)).toBe("1 correspondance")
    expect(countText(en, "kernel.nodeSessions.transcript.earlier", 1)).toBe("Show 1 earlier step")
  })

  it("a shell-escaped path or a relative one through the node's worktrees shows only the part in the session (walk D16)", () => {
    const ctx = {
      sessionId: "3f2a9c1e-0000-4000-8000-000000000001",
      folderName: "liaison-walk-sample",
    }
    expect(
      relativizePaths(
        "cat /Users/sam/Liaison\\ Node/worktrees/liaison-walk-sample-3f2a/README.md",
        ctx,
      ),
    ).toBe("cat README.md")
    expect(relativizePaths("ls Liaison\\ Node/worktrees/liaison-walk-sample-3f2a/src", ctx)).toBe(
      "ls src",
    )
    expect(relativizePaths("echo a\\ b", ctx)).toBe("echo a\\ b")
  })

  it("a session title from a prompt with an absolute path shows it relative (walk D16)", () => {
    expect(
      sessionTitle({
        id: "3f2a9c1e-0000-4000-8000-000000000001",
        title: "Use the Write tool to create /Volumes/Minimac/tmp/walk-allow/desk.txt",
        folderName: "liaison-walk-sample",
        repo: null,
      }),
    ).toBe("Use the Write tool to create desk.txt")
  })
})

describe("imports (W3: S9, S40, A45, A54)", () => {
  it("S9: an unknown source renders with the fallback; an import says Imported", () => {
    expect(originLabel(row({ source: "import" }), "X", i18n)).toBe(
      "kernel.nodeSessions.origin.import",
    )
    expect(
      originLabel(row({ source: "carrier_pigeon" as NodeSessionRow["source"] }), "X", i18n),
    ).toBe("kernel.nodeSessions.origin.other")
  })

  it("A54: a follow-mode import is read only, a following take_over is replaying, a following in-place session is auto-followed", async () => {
    const { autoFollowed, followReadOnly, takeOverReplay } = await import("./display")
    const imp = { source: "import" as const }
    expect(followReadOnly({ ...imp, importMode: "follow", following: false })).toBe(true)
    expect(followReadOnly({ ...imp, importMode: "take_over", following: true })).toBe(false)
    expect(takeOverReplay({ ...imp, importMode: "take_over", following: true })).toBe(true)
    expect(takeOverReplay({ ...imp, importMode: "take_over", following: false })).toBe(false)
    expect(autoFollowed({ source: "app", importMode: null, following: true })).toBe(true)
    expect(autoFollowed({ ...imp, importMode: "follow", following: true })).toBe(false)
  })

  it("A45: the following chip names the import's Claude Code, else the driver event's", async () => {
    const { followingVia } = await import("./display")
    expect(followingVia({ following: true, importFrom: "vscode" }, [])).toBe("vscode")
    expect(followingVia({ following: false, importFrom: "vscode" }, [])).toBeNull()
    const driver = {
      type: "system",
      payload: { subtype: "driver", data: { elsewhere: true, via: "cli" } },
    }
    expect(followingVia({ following: true, importFrom: null }, [driver])).toBe("cli")
    expect(followingVia({ following: true, importFrom: "other" }, [])).toBe("other")
  })
})

describe("plainInline (W2-D7)", () => {
  it("drops inline markdown and keeps the words", () => {
    expect(plainInline("Use **foo** or **bar**?")).toBe("Use foo or bar?")
    expect(plainInline("an *emphasis* and `code` and ~~gone~~")).toBe(
      "an emphasis and code and gone",
    )
    expect(plainInline("see [the PR](https://github.com/o/r/pull/1)")).toBe("see the PR")
    expect(plainInline("## Done\n- fixed cart\n> quoted")).toBe("Done\nfixed cart\nquoted")
  })

  it("leaves snake_case, dunder names, lone asterisks and arithmetic alone", () => {
    for (const text of [
      "cart_total_fix",
      "edit __init__.py",
      "a * b * c",
      "2*3 = 6",
      "x_y and _z",
    ]) {
      expect(plainInline(text)).toBe(text)
    }
  })
})
