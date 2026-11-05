// SPDX-License-Identifier: FSL-1.1-ALv2

import { z } from "zod"
import { NODE_SESSION_DRIVERS } from "./node-session-protocol"

/**
 * Session import and the follow host (S40-S44, D28 b): the shapes shared by
 * the node, the API and the clients.
 */

export const NODE_IMPORT_LIMITS = {
  /** OPEN-9: the replay window of a transcript (A43). */
  historyBytes: 8 * 1024 * 1024,
  lineBytes: 16 * 1024 * 1024,
  listRows: 200,
  subagentBytes: 2 * 1024 * 1024,
  subagentReplayBytes: 16 * 1024 * 1024,
  subagentReplayCount: 32,
  subagentLineBytes: 4 * 1024 * 1024,
  subagentsOpenPerHost: 8,
  followsPerNode: 8,
  metaBytes: 16 * 1024,
  headBytes: 64 * 1024,
} as const

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const uuidSchema = z.string().regex(UUID_RE)

/**
 * A recorded cwd relative to the shared folder: POSIX separators, no empty,
 * `.` or `..` segment, no leading slash, at most 1024 characters, no NUL.
 * `""` is the folder itself.
 */
export function safeSubdir(s: string): boolean {
  if (s.length > 1024 || s.includes("\0") || s.includes("\\")) return false
  if (s === "") return true
  return s.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..")
}

const subdirSchema = z.string().max(1024).refine(safeSubdir, { message: "unsafe subdir" })

/**
 * D53: the real path of one of a shared repository's own git worktrees that
 * lives outside the shared folder: absolute (POSIX `/…` or Windows `C:\…`),
 * no empty, `.` or `..` segment, no trailing separator, no NUL, at most 4096
 * characters. A shape only: the node accepts it only when it is among the
 * worktrees it lists itself for that folder (`git worktree list`), never
 * because a server or a job named it.
 */
export function safeWorktreePath(s: string): boolean {
  if (s.length < 2 || s.length > 4096 || s.includes("\0")) return false
  const posix = s.startsWith("/")
  if (!posix && !/^[A-Za-z]:\\/.test(s)) return false
  const segments = s.split(posix ? "/" : "\\").slice(1)
  return segments.every((seg) => seg !== "" && seg !== "." && seg !== "..")
}

const worktreePathSchema = z
  .string()
  .max(4096)
  .refine(safeWorktreePath, { message: "unsafe worktree path" })

export const NODE_IMPORT_ROW_FROM = ["vscode", "cli", "liaison", "other"] as const

export const nodeImportRowSchema = z
  .object({
    sdkSessionId: uuidSchema,
    folderName: z.string().min(1).max(200),
    /**
     * D53: set when the session ran in one of the shared repository's own
     * worktrees outside the folder; `cwdSubdir` is then relative to it.
     * Absent: relative to the shared folder.
     */
    worktreePath: worktreePathSchema.optional(),
    cwdSubdir: subdirSchema,
    title: z.string().max(120),
    firstPrompt: z.string().max(300),
    branch: z.string().max(200).nullable(),
    lastModified: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative().nullable(),
    sizeBytes: z.number().int().nonnegative(),
    from: z.enum(NODE_IMPORT_ROW_FROM),
    liveNow: z.boolean(),
  })
  .strict()
export type NodeImportRow = z.infer<typeof nodeImportRowSchema>

/** A shared folder's session count, counted before the row cap. */
const folderCountSchema = z
  .object({ name: z.string().min(1).max(200), sessions: z.number().int().nonnegative() })
  .strict()

export const NODE_UNSHARED_REFUSALS = ["home", "hidden", "outside_search"] as const

/**
 * Sessions in a folder that is not shared (the git top level of their
 * recorded cwd, else the cwd): a name, how it reads, a count. Never a path, a
 * title or a prompt. `token` is the node's proof to share it, when it can be.
 */
export const nodeUnsharedGroupSchema = z
  .object({
    name: z.string().min(1).max(200),
    /** `~/…` inside the home folder, else the folder's own name. */
    display: z.string().min(1).max(4096),
    token: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .nullable(),
    sessions: z.number().int().positive(),
    lastModified: z.number().int().nonnegative(),
    refusal: z.enum(NODE_UNSHARED_REFUSALS).nullable(),
  })
  .strict()
export type NodeUnsharedGroup = z.infer<typeof nodeUnsharedGroupSchema>

/** At most this many unshared groups in one listing. */
export const NODE_UNSHARED_GROUPS = 50

/**
 * The list answer. `folders`, `unshared`, `skipped` and `unsharedPartial`
 * come only when the op asked with `detail` (A1: an older server's strict
 * schema never sees them).
 */
export const nodeImportListAnswerSchema = z
  .object({
    rows: z.array(nodeImportRowSchema).max(NODE_IMPORT_LIMITS.listRows),
    truncated: z.boolean(),
    folders: z.array(folderCountSchema).max(500).optional(),
    unshared: z.array(nodeUnsharedGroupSchema).max(NODE_UNSHARED_GROUPS).optional(),
    /** Sessions the node found but could not list (a check refused them, the cwd is gone). */
    skipped: z.number().int().nonnegative().optional(),
    unsharedPartial: z.boolean().optional(),
  })
  .strict()
export type NodeImportListAnswer = z.infer<typeof nodeImportListAnswerSchema>

/**
 * The sidecar's list answer, before the shell turns `unsharedPaths` into
 * `unshared` (tokens, refusals). Paths never leave the shell.
 */
export const nodeImportSidecarListSchema = z
  .object({
    rows: z.array(nodeImportRowSchema).max(NODE_IMPORT_LIMITS.listRows),
    truncated: z.boolean(),
    folders: z.array(folderCountSchema).max(500).optional(),
    unsharedPaths: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            sessions: z.number().int().positive(),
            lastModified: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(NODE_UNSHARED_GROUPS)
      .optional(),
    skipped: z.number().int().nonnegative().optional(),
    unsharedPartial: z.boolean().optional(),
  })
  .strict()
export type NodeImportSidecarList = z.infer<typeof nodeImportSidecarListSchema>

export const nodeImportOpSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("list"),
      query: z.string().max(100).optional(),
      /** One shared folder only (S12). */
      folder: z.string().min(1).max(200).optional(),
      /** A1: ask for the counts, the unshared groups and the skipped count. */
      detail: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("check"),
      sdkSessionId: uuidSchema,
      folderName: z.string().min(1).max(200),
      worktreePath: worktreePathSchema.optional(),
      cwdSubdir: subdirSchema,
    })
    .strict(),
])
export type NodeImportOp = z.infer<typeof nodeImportOpSchema>

export const NODE_IMPORT_CHECK_CODES = [
  "not_found",
  "outside_shared",
  "symlink",
  "ambiguous_transcript",
  "not_regular",
  "unsafe_subdir",
  "already_liaison",
] as const
export type NodeImportCheckCode = (typeof NODE_IMPORT_CHECK_CODES)[number]

export const nodeImportCheckAnswerSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      title: z.string().max(120),
      model: z
        .string()
        .regex(/^[a-z0-9.\-[\]]{1,100}$/)
        .nullable(),
      from: z.enum(NODE_IMPORT_ROW_FROM),
      liveNow: z.boolean(),
      driver: z
        .object({
          elsewhere: z.boolean(),
          via: z.enum(NODE_SESSION_DRIVERS).nullable(),
          orphanPid: z.number().int().positive().optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ ok: z.literal(false), code: z.enum(NODE_IMPORT_CHECK_CODES) }).strict(),
])
export type NodeImportCheckAnswer = z.infer<typeof nodeImportCheckAnswerSchema>

/** The `follow` part of a follow job's claim answer. */
export const nodeFollowClaimSchema = z
  .object({
    sdkSessionId: uuidSchema,
    folderName: z.string().min(1).max(200),
    /** D53: the worktree `cwdSubdir` is relative to (absent: the shared folder). */
    worktreePath: worktreePathSchema.optional(),
    cwdSubdir: subdirSchema,
    startAt: z.enum(["window", "end"]),
    once: z.boolean(),
    inPlace: z.boolean(),
  })
  .strict()
export type NodeFollowClaim = z.infer<typeof nodeFollowClaimSchema>

export const NODE_FOLLOW_WHY = [
  "owner",
  "replayed",
  "driver_left",
  "transcript_gone",
  "host_exit",
] as const
export type NodeFollowWhy = (typeof NODE_FOLLOW_WHY)[number]

/** The `follow` body of `POST /api/node/jobs/:id/result` (A62: endOffset only with replayed or owner). */
export const nodeFollowResultSchema = z
  .object({
    why: z.enum(NODE_FOLLOW_WHY),
    endOffset: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((v) => v.endOffset === undefined || v.why === "replayed" || v.why === "owner", {
    message: "endOffset only with replayed or owner",
    path: ["endOffset"],
  })
export type NodeFollowResult = z.infer<typeof nodeFollowResultSchema>

/** The follow host's stdin lines, one JSON each (A45, A57). */
export const nodeFollowControlSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("follow_add"),
      sessionId: uuidSchema,
      jobId: uuidSchema,
      folderPath: z.string().min(1).max(4096),
      /** D53: re-checked by the host against the folder's own worktrees. */
      worktreePath: worktreePathSchema.optional(),
      cwdSubdir: subdirSchema,
      sdkSessionId: uuidSchema,
      startAt: z.enum(["window", "end"]),
      once: z.boolean(),
      inPlace: z.boolean(),
      /**
       * D49 F6: the server the shell is connected to now (its own value,
       * never a claim field): a liaison-node transcript is followed in place
       * only when this node recorded running it for this server.
       */
      server: z.string().min(1).max(2048),
    })
    .strict(),
  z.object({ type: z.literal("follow_remove"), sessionId: uuidSchema, jobId: uuidSchema }).strict(),
  z.object({ type: z.literal("shutdown") }).strict(),
])
export type NodeFollowControl = z.infer<typeof nodeFollowControlSchema>
