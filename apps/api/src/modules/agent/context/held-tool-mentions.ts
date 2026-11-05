// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE PROMPT NAMES ONLY TOOLS THE TURN HOLDS.
//
// A turn's tool set is cut by its scope (a routine tick runs at its owner
// agent's ceiling intersected with its owner's grants), but the kernel's own
// prompt text was written once for every turn: `system.md` told a support
// routine to `kernel__skill_read` its playbook, the skills manifest and the
// agent's own deferred skills said the same, and the routine, which held no
// `kernel:skills:read`, called a tool it did not have. The SDK refused the call
// and the run was recorded failed although it had done its job.
//
// So the kernel-authored prompt is filtered against the turn's HELD set (its
// whole executable catalog, deferred tools included, since a deferred tool is
// one discovery away): a sentence that names a kernel tool the turn does not
// hold is left out, and a line left with nothing goes with it. A turn that
// holds every tool it is told about reads the text unchanged.

/** A kernel tool named in prompt prose, optionally behind an MCP server prefix. */
const KERNEL_TOOL_MENTION = /\b(?:mcp__liaison__)?(kernel__[A-Za-z0-9_]+)/g

/** A line's list marker: a bullet or a number, kept with the line's first sentence. */
const LIST_MARKER = /^(\s*(?:[-*+]|\d+\.)\s+)/

/** A sentence boundary inside a line: end punctuation, space, then a capital, a code tick, a quote or emphasis. */
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z0-9`*"'([])/

/** The kernel tools `text` names, in order of first mention. */
export function namedKernelTools(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(KERNEL_TOOL_MENTION)) {
    const name = m[1]
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

function namesUnheld(text: string, held: ReadonlySet<string>): boolean {
  return namedKernelTools(text).some((name) => !held.has(name))
}

/**
 * `text` without the sentences that name a kernel tool outside `held`. Lines
 * that name none are untouched; a line whose every sentence goes is removed.
 */
export function withoutUnheldToolMentions(text: string, held: ReadonlySet<string>): string {
  if (!namesUnheld(text, held)) return text
  const lines: string[] = []
  for (const line of text.split("\n")) {
    if (!namesUnheld(line, held)) {
      lines.push(line)
      continue
    }
    const marker = LIST_MARKER.exec(line)?.[1] ?? ""
    const kept = line
      .slice(marker.length)
      .split(SENTENCE_BOUNDARY)
      .filter((sentence) => !namesUnheld(sentence, held))
    if (kept.length > 0) lines.push(marker + kept.join(" "))
  }
  return lines.join("\n")
}
