#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run check:no-ai-coauthor`
//
// Commits on main are authored by people. No commit message, pull request
// title or body may carry an AI tool's co-author trailer or "Generated with"
// footer: GitHub turns a `Co-authored-by:` line into a listed contributor, and a
// squash merge copies the trailers of every commit of the pull request.
//
// CI passes what to read through env (never interpolated into `run:`):
//   BASE_SHA, HEAD_SHA  the commit range to read (BASE_SHA..HEAD_SHA)
//   PR_TITLE, PR_BODY   the pull request text, when there is one
// With no range and no text it reads nothing and passes.

import { spawnSync } from "node:child_process"

const AI_NAMES = /\b(claude|anthropic|copilot|chatgpt|openai|codex|cursor|gemini|devin|aider)\b/i
const CO_AUTHOR = /^[ \t>]*co-authored-by:\s*(.+)$/gim
const GENERATED = /generated (with|by) \[?(claude|copilot|chatgpt|codex|cursor|gemini|devin|aider)/i

/** The offending lines of `text`, empty when it is clean. */
export function findAiAttribution(text: string): string[] {
  const hits: string[] = []
  for (const match of text.matchAll(CO_AUTHOR)) {
    if (AI_NAMES.test(match[1] ?? "")) hits.push(match[0].trim())
  }
  for (const line of text.split("\n")) {
    if (GENERATED.test(line)) hits.push(line.trim())
  }
  return hits
}

function commitMessages(base: string, head: string): { sha: string; message: string }[] {
  const out = spawnSync("git", ["log", "--format=%H%x00%B%x01", `${base}..${head}`], {
    encoding: "utf8",
  })
  if (out.status !== 0) {
    console.error(`check-no-ai-coauthor: cannot read ${base}..${head}: ${out.stderr.trim()}`)
    process.exit(2)
  }
  return out.stdout
    .split("\x01")
    .map((entry) => entry.replace(/^\n/, ""))
    .filter((entry) => entry.includes("\x00"))
    .map((entry) => {
      const [sha, message] = entry.split("\x00")
      return { sha: (sha ?? "").slice(0, 10), message: message ?? "" }
    })
}

if (import.meta.main) {
  const { BASE_SHA, HEAD_SHA, PR_TITLE, PR_BODY } = process.env
  const findings: string[] = []
  const zero = /^0+$/
  if (BASE_SHA && HEAD_SHA && !zero.test(BASE_SHA)) {
    for (const { sha, message } of commitMessages(BASE_SHA, HEAD_SHA)) {
      for (const hit of findAiAttribution(message)) findings.push(`commit ${sha}: ${hit}`)
    }
  }
  for (const [where, text] of [
    ["pull request title", PR_TITLE],
    ["pull request body", PR_BODY],
  ] as const) {
    for (const hit of findAiAttribution(text ?? "")) findings.push(`${where}: ${hit}`)
  }
  if (findings.length > 0) {
    console.error("AI attribution found. Commits are authored by people; remove these lines:")
    for (const f of findings) console.error(`  ${f}`)
    console.error(
      "Fix: edit the PR text, and reword the commits (git rebase -i <base>, then `reword`), then push.",
    )
    process.exit(1)
  }
  console.log("check-no-ai-coauthor: clean")
}
