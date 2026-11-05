// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S51 (owner D13): the read-only follow of a transcript another Claude Code
// writes. A scratch file only, never the owner's real ~/.claude.
import { afterAll, describe, expect, it } from "bun:test"
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { NodeSessionEventIn } from "../../../packages/shared/src/node-session-protocol"
import { TranscriptFollow, transcriptFile } from "./transcript-follow"

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
const ID = "41173e76-dc0a-4f5f-8c7a-fde5d5329047"

function scratchFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "follow-"))
  roots.push(dir)
  const file = path.join(dir, `${ID}.jsonl`)
  writeFileSync(file, "")
  return file
}

const line = (o: unknown) => `${JSON.stringify(o)}\n`
const base = { sessionId: ID, cwd: "/tmp/repo", isSidechain: false }
const userTyped = (text: string) => ({
  ...base,
  type: "user",
  message: { role: "user", content: text },
})
const assistantText = (id: string, text: string) => ({
  ...base,
  type: "assistant",
  message: {
    id,
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 2 },
  },
})
const toolUse = (id: string) => ({
  ...base,
  type: "assistant",
  message: {
    id: "msg_t",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }],
  },
})
const toolResult = (id: string) => ({
  ...base,
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "a.txt" }] },
})

function follower(file: string) {
  const out: NodeSessionEventIn[] = []
  const f = new TranscriptFollow({
    file,
    emit: (events) => out.push(...events),
    now: () => "2026-10-15T15:00:00.000Z",
  })
  return { f, out, kinds: () => out.map((e) => e.type) }
}

describe("TranscriptFollow", () => {
  it("S51: appended lines become events in order; a partial last line waits for its newline", () => {
    const file = scratchFile()
    const { f, out, kinds } = follower(file)
    appendFileSync(file, line(userTyped("run the tests")) + line(assistantText("msg_1", "On it.")))
    f.poll()
    expect(kinds()).toEqual(["user_message", "assistant_text", "usage"])
    expect(out[0]?.payload).toEqual({ text: "run the tests" })
    expect(out[1]?.payload).toMatchObject({ text: "On it." })

    // Half a line: nothing yet, and nothing is lost.
    const next = line(toolUse("toolu_01"))
    appendFileSync(file, next.slice(0, 40))
    f.poll()
    expect(out.length).toBe(3)
    appendFileSync(file, next.slice(40) + line(toolResult("toolu_01")))
    f.poll()
    expect(kinds().slice(3)).toEqual(["tool_call", "tool_result"])
    expect(out[3]?.payload).toMatchObject({ id: "toolu_01", name: "Bash" })
    expect(f.offset).toBe(statSync(file).size)
  })

  it("S51: a multi-byte character split across reads arrives whole", () => {
    const file = scratchFile()
    const { f, out } = follower(file)
    const whole = Buffer.from(line(userTyped("café ☕ déjà")), "utf8")
    const cut = whole.indexOf(Buffer.from("☕", "utf8")) + 1
    appendFileSync(file, whole.subarray(0, cut))
    f.poll()
    appendFileSync(file, whole.subarray(cut))
    f.poll()
    expect(out.map((e) => e.payload)).toEqual([{ text: "café ☕ déjà" }])
  })

  it("S51: meta lines, sidechains, bookkeeping lines and bad JSON become nothing", () => {
    const file = scratchFile()
    const { f, kinds } = follower(file)
    appendFileSync(
      file,
      line({ ...userTyped("<command-name>/clear</command-name>"), isMeta: true }) +
        line({ ...assistantText("msg_s", "sub"), isSidechain: true }) +
        line({ type: "queue-operation", operation: "enqueue" }) +
        line({ type: "file-history-snapshot" }) +
        "{not json\n" +
        line(assistantText("msg_2", "Done.")),
    )
    f.poll()
    expect(kinds()).toEqual(["assistant_text", "usage"])
  })

  it("S51: starting at an offset follows only what comes after it; the file is never written", () => {
    const file = scratchFile()
    appendFileSync(file, line(userTyped("old turn")))
    const before = readFileSync(file)
    const out: NodeSessionEventIn[] = []
    const f = new TranscriptFollow({ file, offset: before.length, emit: (e) => out.push(...e) })
    f.poll()
    expect(out).toEqual([])
    appendFileSync(file, line(userTyped("new turn")))
    f.poll()
    expect(out.map((e) => e.payload)).toEqual([{ text: "new turn" }])
    expect(readFileSync(file).subarray(0, before.length).equals(before)).toBe(true)
  })

  it("S51: a line longer than one read still arrives; one over the line cap is skipped, not a stall", () => {
    const file = scratchFile()
    const out: NodeSessionEventIn[] = []
    const f = new TranscriptFollow({
      file,
      emit: (e) => out.push(...e),
      maxReadBytes: 64,
      maxLineBytes: 4096,
    })
    appendFileSync(file, line(userTyped("x".repeat(1000))) + line(userTyped("after")))
    f.poll()
    expect(out.map((e) => (e.payload as { text: string }).text.length)).toEqual([1000, 5])
    appendFileSync(file, line(userTyped("y".repeat(10_000))) + line(userTyped("next")))
    for (let i = 0; i < 5; i++) f.poll()
    expect(out.slice(2).map((e) => e.payload)).toEqual([{ text: "next" }])
    expect(f.offset).toBe(statSync(file).size)
  })

  it("S51: the driver event goes out on each change only", () => {
    const file = scratchFile()
    const { f, out } = follower(file)
    f.driver({ elsewhere: true, via: "vscode" })
    f.driver({ elsewhere: true, via: "vscode" })
    f.driver({ elsewhere: false, via: null })
    expect(
      out.map((e) => [
        e.type,
        (e.payload as { subtype: string }).subtype,
        (e.payload as { data: unknown }).data,
      ]),
    ).toEqual([
      ["system", "driver", { elsewhere: true, via: "vscode" }],
      ["system", "driver", { elsewhere: false, via: null }],
    ])
  })

  it("S51: transcriptFile is the owner's projects/<slug of the folder>/<sdk id>.jsonl; a bad id is refused", () => {
    expect(transcriptFile("/cfg", "/Users/x/Documents/liaison-monorepo", ID)).toBe(
      `/cfg/projects/-Users-x-Documents-liaison-monorepo/${ID}.jsonl`,
    )
    expect(transcriptFile("/cfg", "/Users/x/repo", "../../etc/passwd")).toBeNull()
  })

  it("OPEN-10: transcriptFile finds a long cwd's transcript under its slice(0,200)-<hash> dir; none there is null", () => {
    const cfg = mkdtempSync(path.join(tmpdir(), "follow-cfg-"))
    roots.push(cfg)
    const cwd = `/${"a-long-folder-name/".repeat(14)}repo`
    const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-")
    expect(slug.length).toBeGreaterThan(200)
    expect(transcriptFile(cfg, cwd, ID)).toBeNull()
    const dir = path.join(cfg, "projects", `${slug.slice(0, 200)}-k3j9x2`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${ID}.jsonl`), "")
    expect(transcriptFile(cfg, cwd, ID)).toBe(path.join(dir, `${ID}.jsonl`))
  })
})

describe("TranscriptFollow, W3 options (A57)", () => {
  it("A57: transform applies to every event before emit, the driver event included", () => {
    const file = scratchFile()
    const out: NodeSessionEventIn[] = []
    const f = new TranscriptFollow({
      file,
      emit: (e) => out.push(...e),
      transform: (e) => ({ ...e, payload: { ...e.payload, seen: true } }),
    })
    appendFileSync(file, line(userTyped("hello")) + line(assistantText("msg_1", "hi")))
    f.poll()
    f.driver({ elsewhere: true, via: "cli" })
    expect(out.map((e) => (e.payload as { seen?: boolean }).seen)).toEqual([true, true, true, true])
  })

  it("A57: parentToolUseId tags every event and admits isSidechain lines; isMeta lines stay dropped", () => {
    const file = scratchFile()
    const out: NodeSessionEventIn[] = []
    const f = new TranscriptFollow({
      file,
      emit: (e) => out.push(...e),
      parentToolUseId: "toolu_parent",
    })
    appendFileSync(
      file,
      line({ ...userTyped("sub prompt"), isSidechain: true, agentId: "a1" }) +
        line({ ...assistantText("msg_s", "sub answer"), isSidechain: true, agentId: "a1" }) +
        line({ ...userTyped("<meta/>"), isSidechain: true, isMeta: true }),
    )
    f.poll()
    expect(out.map((e) => [e.type, e.parentToolUseId])).toEqual([
      ["user_message", "toolu_parent"],
      ["assistant_text", "toolu_parent"],
      ["usage", "toolu_parent"],
    ])
  })

  it("A57: noFollowOpen never reads a transcript swapped for a symlink", () => {
    const file = scratchFile()
    const out: NodeSessionEventIn[] = []
    const f = new TranscriptFollow({ file, emit: (e) => out.push(...e), noFollowOpen: true })
    appendFileSync(file, line(userTyped("first")))
    f.poll()
    const elsewhere = path.join(path.dirname(file), "elsewhere.jsonl")
    writeFileSync(elsewhere, line(userTyped("first")) + line(userTyped("not yours")))
    renameSync(file, `${file}.old`)
    symlinkSync(elsewhere, file)
    f.poll()
    expect(out.map((e) => e.payload)).toEqual([{ text: "first" }])
  })

  it("A57: onShrink end reads nothing more of a shorter file and says so; the default restarts", () => {
    const file = scratchFile()
    const out: NodeSessionEventIn[] = []
    const f = new TranscriptFollow({ file, emit: (e) => out.push(...e), onShrink: "end" })
    appendFileSync(file, line(userTyped("one")) + line(userTyped("two")))
    f.poll()
    truncateSync(file, 0)
    appendFileSync(file, line(userTyped("x")))
    f.poll()
    expect(f.shrunk).toBe(true)
    expect(out.map((e) => e.payload)).toEqual([{ text: "one" }, { text: "two" }])

    const other = scratchFile()
    const again: NodeSessionEventIn[] = []
    const g = new TranscriptFollow({ file: other, emit: (e) => again.push(...e) })
    appendFileSync(other, line(userTyped("one")) + line(userTyped("two")))
    g.poll()
    truncateSync(other, 0)
    appendFileSync(other, line(userTyped("x")))
    g.poll()
    expect(g.shrunk).toBe(false)
    expect(again.map((e) => e.payload)).toEqual([{ text: "one" }, { text: "two" }, { text: "x" }])
  })
})

// W3-D2: lines Claude Code writes as a user turn that the person never typed,
// shaped as 2.1.286 and 2.1.296 write them (placeholder content only).
const AGENT_USE = "toolu_01AgentFixtureAAAAAAAAAA"
const notificationXml = (o: { status?: string; tool?: string } = {}) =>
  [
    "<task-notification>",
    "<task-id>a0fixture0000001</task-id>",
    `<tool-use-id>${o.tool ?? AGENT_USE}</tool-use-id>`,
    "<output-file>/tmp/claude-501/-tmp-repo/sess/tasks/a0fixture0000001.output</output-file>",
    `<status>${o.status ?? "completed"}</status>`,
    '<summary>Agent "List files" finished</summary>',
    "<note>A task-notification fires each time this agent stops.</note>",
    "<result>Delivered as a message.\n</result>",
    "<usage><subagent_tokens>100</subagent_tokens><tool_uses>2</tool_uses><duration_ms>6128</duration_ms></usage>",
    "</task-notification>",
  ].join("\n")
const agentUse = {
  ...base,
  type: "assistant",
  message: {
    id: "msg_a",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "tool_use", id: AGENT_USE, name: "Agent", input: { description: "d" } }],
  },
}
/** 2.1.286: a user line with `origin.kind` task-notification and `promptSource` system. */
const notificationLine = (o: { status?: string; tool?: string; origin?: boolean } = {}) => ({
  ...base,
  type: "user",
  message: { role: "user", content: notificationXml(o) },
  ...(o.origin === false
    ? {}
    : { origin: { kind: "task-notification", producer: "session-task" }, promptSource: "system" }),
})
/** 2.1.296: a mid-turn message recorded only as a `queued_command` attachment. */
const queuedLine = (prompt: unknown, commandMode: string, origin?: object) => ({
  ...base,
  type: "attachment",
  attachment: { type: "queued_command", prompt, commandMode, ...(origin ? { origin } : {}) },
})

describe("TranscriptFollow, CLI-injected user lines (W3-D2)", () => {
  it("W3-D2: a task-notification user line is a quiet system notification, never a user_message, and carries no output file", () => {
    const file = scratchFile()
    const { f, out } = follower(file)
    writeFileSync(file, line(agentUse) + line(notificationLine()))
    f.poll()
    expect(out.filter((e) => e.type === "user_message")).toEqual([])
    const notes = out.filter((e) => e.type === "system")
    expect(notes.map((e) => e.payload)).toEqual([
      {
        subtype: "notification",
        text: 'Agent "List files" finished',
        data: {
          kind: "task",
          taskId: "a0fixture0000001",
          toolUseId: AGENT_USE,
          status: "completed",
          agent: true,
          summary: 'Agent "List files" finished',
          durationMs: 6128,
          toolUses: 2,
        },
      },
    ])
    expect(JSON.stringify(out)).not.toContain("output-file")
    expect(JSON.stringify(out)).not.toContain(".output")
  })

  it("W3-D2: an older line with no origin, a background shell's notification, and other CLI wrappers are never the person", () => {
    const file = scratchFile()
    const { f, out } = follower(file)
    const wrapped = (text: string) => ({
      ...base,
      type: "user",
      message: { role: "user", content: text },
    })
    writeFileSync(
      file,
      line(notificationLine({ origin: false, status: "failed", tool: "toolu_01ShellFixture" })) +
        line(wrapped("<system-reminder>\nnote\n</system-reminder>")) +
        line(wrapped("<local-command-stdout>ok</local-command-stdout>")) +
        line({ ...wrapped("anything"), promptSource: "system" }) +
        line({ ...wrapped("hello"), origin: { kind: "peer", from: "a1" } }) +
        line({ ...userTyped("typed by me"), origin: { kind: "human" }, promptSource: "typed" }),
    )
    f.poll()
    expect(out.filter((e) => e.type === "user_message").map((e) => e.payload)).toEqual([
      { text: "typed by me" },
    ])
    const notes = out.filter((e) => e.type === "system").map((e) => e.payload as { data: object })
    expect(notes.length).toBe(1)
    expect(notes[0]?.data).toMatchObject({ status: "failed", agent: false })
  })

  it("W3-D2 review: a human-origin line is the person's message whatever its text starts with, and never a notification", () => {
    const file = scratchFile()
    const { f, out } = follower(file)
    const human = (text: string) => ({
      ...base,
      type: "user",
      message: { role: "user", content: text },
      origin: { kind: "human" },
      promptSource: "typed",
    })
    const typed = [
      "<system-reminder>pasted from a log</system-reminder>",
      "<bash-stdout>ok</bash-stdout> why?",
      notificationXml(),
    ]
    const queued = "<task-notification>pasted mid-turn</task-notification>"
    writeFileSync(
      file,
      line(agentUse) +
        typed.map((t) => line(human(t))).join("") +
        line(queuedLine(queued, "prompt", { kind: "human" })),
    )
    f.poll()
    expect(out.filter((e) => e.type === "user_message").map((e) => e.payload)).toEqual([
      ...typed.map((text) => ({ text })),
      { text: queued },
    ])
    expect(out.filter((e) => e.type === "system")).toEqual([])
  })

  it("W3-D2: 2.1.296 queued_command attachments: the person's mid-turn message is a user_message, a task notification a quiet line, a peer's nothing", () => {
    const file = scratchFile()
    const { f, out } = follower(file)
    writeFileSync(
      file,
      line(agentUse) +
        line(
          queuedLine([{ type: "text", text: "also check the docs" }], "prompt", { kind: "human" }),
        ) +
        line(queuedLine(notificationXml(), "task-notification", { kind: "task-notification" })) +
        line(queuedLine(notificationXml({ tool: "toolu_01Other" }), "task-notification")) +
        line(queuedLine('<agent-message from="a1">x</agent-message>', "prompt", { kind: "peer" })),
    )
    f.poll()
    expect(out.filter((e) => e.type === "user_message").map((e) => e.payload)).toEqual([
      { text: "also check the docs" },
    ])
    const notes = out
      .filter((e) => e.type === "system")
      .map((e) => (e.payload as { data: { toolUseId: string; agent: boolean } }).data)
    expect(notes.map((d) => [d.toolUseId, d.agent])).toEqual([
      [AGENT_USE, true],
      ["toolu_01Other", false],
    ])
  })
})
