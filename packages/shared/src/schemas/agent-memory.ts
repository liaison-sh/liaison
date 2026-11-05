// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const
export const MemoryTypeSchema = z.enum(MEMORY_TYPES)
export type MemoryType = z.infer<typeof MemoryTypeSchema>

export const MemoryNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "lowercase slug, ≤64 chars")

export const MemoryCreateSchema = z.object({
  type: MemoryTypeSchema,
  name: MemoryNameSchema,
  description: z.string().min(1).max(160),
  content: z.string().min(1).max(8192),
})

export const MemoryUpdateSchema = z
  .object({
    description: z.string().min(1).max(160).optional(),
    content: z.string().min(1).max(8192).optional(),
  })
  .refine((v) => v.description !== undefined || v.content !== undefined, {
    message: "Provide description, content, or both",
  })

export const MemoryEntrySchema = z.object({
  type: MemoryTypeSchema,
  name: MemoryNameSchema,
  description: z.string(),
  content: z.string(),
  updatedAt: z.string(),
})
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>

// --- The memory tree (P4m) -------------------------------------------------
//
// The agent's memory is a folder of plain Markdown files rooted at
// `/memories/<handle>/`, in Claude Code's shape: `MEMORY.md` as the index, one
// file per memory under its type folder, past conversations under `episodes/`
// and rendered conversation summaries under `checkpoints/`. The model sees
// paths and Markdown, nothing else, so the path grammar below is the only
// thing standing between a model-written path and another agent's root.

/** Every type an `agent_memory` row can carry in its frontmatter. */
export const MEMORY_FILE_TYPES = [...MEMORY_TYPES, "episode"] as const
export const MemoryFileTypeSchema = z.enum(MEMORY_FILE_TYPES)

/** The index file, always at the root of the tree. */
export const MEMORY_INDEX_PATH = "MEMORY.md"

const SLUG_SOURCE = "[a-z0-9][a-z0-9_-]{0,63}"
/** The slug grammar as a standalone anchored test, for a caller that builds a
 *  path out of a handle before it ever reaches `isLegalMemoryPath`. */
const SLUG_RE = new RegExp(`^${SLUG_SOURCE}$`)
export function isLegalMemorySlug(value: string): boolean {
  return SLUG_RE.test(value)
}
const TOPIC_PATH_RE = new RegExp(`^(${MEMORY_TYPES.join("|")})\\/${SLUG_SOURCE}\\.md$`)
const EPISODE_PATH_RE = new RegExp(
  `^episodes\\/${SLUG_SOURCE}\\/\\d{4}-\\d{2}-\\d{2}(-\\d+)?\\.md$`,
)
const CHECKPOINT_PATH_RE = new RegExp(`^checkpoints\\/${SLUG_SOURCE}\\.md$`)

/**
 * True for a path that is one of the four legal shapes AND carries no
 * traversal. The shape regexes are anchored and their segments cannot contain
 * a dot run, a slash or a backslash, so they already refuse every traversal
 * form; the explicit guard is kept because it fails for the RIGHT reason and a
 * later widening of the slug grammar must not silently reopen the hole.
 */
export function isLegalMemoryPath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false
  if (path.startsWith("/") || path.includes("\\")) return false
  const segments = path.split("/")
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false
  if (path === MEMORY_INDEX_PATH) return true
  return TOPIC_PATH_RE.test(path) || EPISODE_PATH_RE.test(path) || CHECKPOINT_PATH_RE.test(path)
}

export const MemoryPathSchema = z
  .string()
  .refine(isLegalMemoryPath, "not a path inside this agent's memory tree")

/**
 * The YAML frontmatter block at the top of every topic file. It is RENDERED
 * from the row's columns on read and parsed back into them on write: the
 * columns stay the source of truth, so a body that claims a wider
 * `requiredScopes` about itself changes nothing.
 */
export const MemoryFrontmatterSchema = z.object({
  name: MemoryNameSchema,
  description: z.string().min(1).max(160),
  type: MemoryFileTypeSchema,
  /** ISO calendar date, `YYYY-MM-DD`, rendered from the row's updatedAt. */
  modified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requiredScopes: z.array(z.string()),
  sources: z.array(z.string()),
  supersedes: z.string().nullable(),
})
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>

// --- The six verbs, mirroring Anthropic's memory tool ----------------------

export const MemoryViewParamsSchema = z.object({
  path: MemoryPathSchema,
  viewRange: z.tuple([z.number().int(), z.number().int()]).optional(),
})

export const MemoryCreateParamsSchema = z.object({
  path: MemoryPathSchema,
  body: z.string().min(1).max(8192).describe("Markdown; its first line is its MEMORY.md hook"),
})

export const MemoryStrReplaceParamsSchema = z.object({
  path: MemoryPathSchema,
  old: z.string().min(1),
  new: z.string(),
})

export const MemoryInsertParamsSchema = z.object({
  path: MemoryPathSchema,
  /** One based, the line the text is inserted BEFORE. */
  line: z.number().int().min(1),
  text: z.string(),
})

export const MemoryDeleteParamsSchema = z.object({ path: MemoryPathSchema })

export const MemoryRenameParamsSchema = z.object({
  from: MemoryPathSchema,
  to: MemoryPathSchema,
})

export const MemorySearchParamsSchema = z.object({
  query: z.string().min(1).max(500),
  since: z.string().optional(),
  until: z.string().optional(),
  threadId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(20).optional(),
  includeSuperseded: z.boolean().default(false),
})

export const MemoryOpenParamsSchema = z.object({
  messageId: z.string(),
  before: z.number().int().min(0).max(20).optional(),
  after: z.number().int().min(0).max(20).optional(),
})
