// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import {
  NODE_IMPORT_LIMITS,
  nodeFollowControlSchema,
  nodeFollowResultSchema,
  nodeImportCheckAnswerSchema,
  nodeImportListAnswerSchema,
  nodeImportOpSchema,
  nodeImportRowSchema,
  safeSubdir,
  safeWorktreePath,
} from "./node-import"

const ID = "0b1f6c2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b"

const row = (over: Record<string, unknown> = {}) => ({
  sdkSessionId: ID,
  folderName: "repo",
  cwdSubdir: "apps/web",
  title: "A title",
  firstPrompt: "hello",
  branch: null,
  lastModified: 1_700_000_000_000,
  createdAt: null,
  sizeBytes: 1234,
  from: "vscode",
  liveNow: false,
  ...over,
})

describe("node import vocabulary", () => {
  it("S40: a valid listing row parses", () => {
    expect(nodeImportRowSchema.parse(row()).cwdSubdir).toBe("apps/web")
  })

  it("S40: a listing row with an absolute cwdSubdir, a '..' segment, or a 121-char title is refused", () => {
    expect(nodeImportRowSchema.safeParse(row({ cwdSubdir: "/etc" })).success).toBe(false)
    expect(nodeImportRowSchema.safeParse(row({ cwdSubdir: "a/../b" })).success).toBe(false)
    expect(nodeImportRowSchema.safeParse(row({ title: "x".repeat(121) })).success).toBe(false)
    expect(nodeImportRowSchema.safeParse(row({ title: "x".repeat(120) })).success).toBe(true)
  })

  it("S40: a listing answer of 201 rows is refused", () => {
    const rows = (n: number) => Array.from({ length: n }, () => row())
    expect(
      nodeImportListAnswerSchema.safeParse({ rows: rows(200), truncated: false }).success,
    ).toBe(true)
    expect(nodeImportListAnswerSchema.safeParse({ rows: rows(201), truncated: true }).success).toBe(
      false,
    )
    expect(NODE_IMPORT_LIMITS.listRows).toBe(200)
  })

  it("S42: a check op refuses a non-uuid sdkSessionId", () => {
    const op = { kind: "check", sdkSessionId: ID, folderName: "repo", cwdSubdir: "" }
    expect(nodeImportOpSchema.safeParse(op).success).toBe(true)
    expect(nodeImportOpSchema.safeParse({ ...op, sdkSessionId: "../../x" }).success).toBe(false)
    expect(nodeImportOpSchema.safeParse({ kind: "list", query: "q".repeat(101) }).success).toBe(
      false,
    )
  })

  it("A45: a follow control line with an extra key is refused; follow_remove parses", () => {
    const add = {
      type: "follow_add",
      sessionId: ID,
      jobId: ID,
      folderPath: "/x",
      cwdSubdir: "",
      sdkSessionId: ID,
      startAt: "window",
      once: false,
      inPlace: false,
      server: "https://liaison.example",
    }
    expect(nodeFollowControlSchema.safeParse(add).success).toBe(true)
    // D49 F6: the shell always names its server.
    expect(nodeFollowControlSchema.safeParse({ ...add, server: undefined }).success).toBe(false)
    expect(nodeFollowControlSchema.safeParse({ ...add, extra: 1 }).success).toBe(false)
    expect(
      nodeFollowControlSchema.safeParse({ type: "follow_remove", sessionId: ID, jobId: ID })
        .success,
    ).toBe(true)
  })

  it("A57: {type:'shutdown'} parses; {type:'shutdown', x:1} is refused", () => {
    expect(nodeFollowControlSchema.safeParse({ type: "shutdown" }).success).toBe(true)
    expect(nodeFollowControlSchema.safeParse({ type: "shutdown", x: 1 }).success).toBe(false)
  })

  it("A45: a follow result accepts why replayed and refuses why 'done'", () => {
    expect(nodeFollowResultSchema.safeParse({ why: "replayed", endOffset: 10 }).success).toBe(true)
    expect(nodeFollowResultSchema.safeParse({ why: "done" }).success).toBe(false)
  })

  it("A62: endOffset is accepted only with why replayed or owner and only as a non-negative integer", () => {
    expect(nodeFollowResultSchema.safeParse({ why: "owner", endOffset: 0 }).success).toBe(true)
    expect(nodeFollowResultSchema.safeParse({ why: "host_exit", endOffset: 5 }).success).toBe(false)
    expect(nodeFollowResultSchema.safeParse({ why: "driver_left", endOffset: 5 }).success).toBe(
      false,
    )
    expect(nodeFollowResultSchema.safeParse({ why: "replayed", endOffset: -1 }).success).toBe(false)
    expect(nodeFollowResultSchema.safeParse({ why: "replayed", endOffset: 1.5 }).success).toBe(
      false,
    )
    expect(nodeFollowResultSchema.safeParse({ why: "transcript_gone" }).success).toBe(true)
  })

  it("A59: a check answer whose model is 'gpt 4; rm' or 101 chars is refused", () => {
    const ok = {
      ok: true,
      title: "t",
      model: "claude-haiku-5-5",
      from: "vscode",
      liveNow: false,
      driver: { elsewhere: false, via: null },
    }
    expect(nodeImportCheckAnswerSchema.safeParse(ok).success).toBe(true)
    expect(nodeImportCheckAnswerSchema.safeParse({ ...ok, model: "gpt 4; rm" }).success).toBe(false)
    expect(nodeImportCheckAnswerSchema.safeParse({ ...ok, model: "a".repeat(101) }).success).toBe(
      false,
    )
    expect(nodeImportCheckAnswerSchema.safeParse({ ...ok, model: null }).success).toBe(true)
    expect(nodeImportCheckAnswerSchema.safeParse({ ok: false, code: "symlink" }).success).toBe(true)
    expect(nodeImportCheckAnswerSchema.safeParse({ ok: false, code: "nope" }).success).toBe(false)
  })

  it("safeSubdir: '' and 'a/b' pass; '/a', 'a/../b', 'a//b', 'a\\0b' fail", () => {
    expect(safeSubdir("")).toBe(true)
    expect(safeSubdir("a/b")).toBe(true)
    expect(safeSubdir("/a")).toBe(false)
    expect(safeSubdir("a/../b")).toBe(false)
    expect(safeSubdir("a//b")).toBe(false)
    expect(safeSubdir("a\0b")).toBe(false)
    expect(safeSubdir("./a")).toBe(false)
    expect(safeSubdir("a".repeat(1025))).toBe(false)
  })

  it("D53: safeWorktreePath admits an absolute real path only", () => {
    expect(safeWorktreePath("/tmp/wt")).toBe(true)
    expect(safeWorktreePath("C:\\Users\\me\\wt")).toBe(true)
    for (const bad of ["", "/", "wt", "a/b", "/a/../b", "/a/./b", "/a//b", "/a/", "/a\0b"]) {
      expect(safeWorktreePath(bad)).toBe(false)
    }
    expect(safeWorktreePath(`/${"a".repeat(4096)}`)).toBe(false)
  })

  it("D53: a row, a check and a follow may name a worktree; an unsafe one is refused", () => {
    expect(nodeImportRowSchema.safeParse(row({ worktreePath: "/tmp/wt" })).success).toBe(true)
    expect(nodeImportRowSchema.safeParse(row({ worktreePath: "../wt" })).success).toBe(false)
    const check = { kind: "check", sdkSessionId: ID, folderName: "repo", cwdSubdir: "" }
    expect(nodeImportOpSchema.safeParse({ ...check, worktreePath: "/tmp/wt" }).success).toBe(true)
    expect(nodeImportOpSchema.safeParse({ ...check, worktreePath: "tmp/wt" }).success).toBe(false)
    const add = {
      type: "follow_add",
      sessionId: ID,
      jobId: ID,
      folderPath: "/x/repo",
      cwdSubdir: "",
      sdkSessionId: ID,
      startAt: "end",
      once: false,
      inPlace: false,
      server: "https://a.example",
    }
    expect(nodeFollowControlSchema.safeParse({ ...add, worktreePath: "/tmp/wt" }).success).toBe(
      true,
    )
    expect(nodeFollowControlSchema.safeParse({ ...add, worktreePath: "/tmp/../x" }).success).toBe(
      false,
    )
  })
})

describe("import listing detail (session import overhaul)", () => {
  const { nodeImportSidecarListSchema } = require("./node-import") as typeof import("./node-import")
  const group = {
    name: "app",
    display: "~/code/app",
    token: "0".repeat(32),
    sessions: 3,
    lastModified: 1,
    refusal: null,
  }

  it("list takes folder and detail, nothing else", () => {
    expect(
      nodeImportOpSchema.safeParse({ kind: "list", folder: "code", detail: true }).success,
    ).toBe(true)
    expect(nodeImportOpSchema.safeParse({ kind: "list", detail: false }).success).toBe(false)
    expect(nodeImportOpSchema.safeParse({ kind: "list", folder: "" }).success).toBe(false)
    expect(nodeImportOpSchema.safeParse({ kind: "list", path: "/x" }).success).toBe(false)
  })

  it("an old node's answer still parses, and the detail fields too", () => {
    expect(nodeImportListAnswerSchema.safeParse({ rows: [], truncated: false }).success).toBe(true)
    const full = nodeImportListAnswerSchema.safeParse({
      rows: [],
      truncated: false,
      folders: [{ name: "code", sessions: 250 }],
      unshared: [group],
      skipped: 2,
      unsharedPartial: false,
    })
    expect(full.success).toBe(true)
  })

  it("an unshared group never carries a path, a title or a prompt", () => {
    for (const extra of [{ path: "/h/code/app" }, { title: "secret" }, { firstPrompt: "x" }]) {
      expect(
        nodeImportListAnswerSchema.safeParse({
          rows: [],
          truncated: false,
          unshared: [{ ...group, ...extra }],
        }).success,
      ).toBe(false)
    }
    expect(
      nodeImportListAnswerSchema.safeParse({
        rows: [],
        truncated: false,
        unshared: [{ ...group, sessions: 0 }],
      }).success,
    ).toBe(false)
  })

  it("the sidecar's answer carries paths, which the shell turns into groups", () => {
    const raw = {
      rows: [],
      truncated: false,
      unsharedPaths: [{ path: "/h/code/app", sessions: 3, lastModified: 1 }],
    }
    expect(nodeImportSidecarListSchema.safeParse(raw).success).toBe(true)
    expect(nodeImportListAnswerSchema.safeParse(raw).success).toBe(false)
  })
})
