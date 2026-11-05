#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Copy the documentation out of a cloned git repository (READMEs, docs/,
// manuals, changelogs, license) into a folder a `liaison config apply`
// knowledge `dir` entry loads. Code, vendored and generated trees are never
// read, and a file that looks like it carries a secret is skipped. Used by the
// setup playbook (.claude/skills/setup-liaison/SKILL.md).
//
//   git clone --depth 1 https://github.com/acme/widget /tmp/widget
//   bun apps/api/src/cli/setup/collect-repo-docs.ts --src /tmp/widget \
//     --out deploy/setup/knowledge/repos/widget --web-url https://github.com/acme/widget
//
// No Bun on the host? Run it in the Liaison image (see crawl-site.ts).
// Prints a JSON summary on stdout.

import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, extname, join, relative, sep } from "node:path"
import { parseArgs } from "node:util"
import { withOpenFileSync } from "../../lib/read-checked-file"

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"])
/** Extension-less files worth keeping (as .txt). */
const BARE_NAMES = /^(LICENSE|LICENCE|COPYING|NOTICE|AUTHORS|CHANGELOG|CHANGES|HISTORY)$/i
const SKIP_DIRS = new Set([
  "node_modules",
  "vendor",
  "third_party",
  "third-party",
  "bower_components",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "test-results",
  "__snapshots__",
  "snapshots",
  "fixtures",
  "__fixtures__",
  "testdata",
  "Pods",
  "venv",
  "site-packages",
  "generated",
  "templates",
])
/** Inside these, only a README is documentation; the rest is code-adjacent. */
const CODE_DIRS = new Set([
  "src",
  "lib",
  "app",
  "pkg",
  "internal",
  "test",
  "tests",
  "test-support",
  "e2e",
  "__tests__",
  "spec",
  "ios",
  "android",
])
/** Instructions for coding agents, not knowledge about the company. */
const AGENT_FILES = /^(CLAUDE|AGENTS|GEMINI|COPILOT-INSTRUCTIONS)\.md$/i
const MAX_BYTES = 1_000_000

/** Credential shapes; a file containing one is skipped, never copied. */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI-style key", /\bsk-(proj-)?[A-Za-z0-9]{32,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Shopify token", /\bshp(at|ss|ca|pa)_[a-fA-F0-9]{32}\b/],
  ["Stripe key", /\b(sk|rk)_live_[A-Za-z0-9]{20,}/],
  ["SendGrid key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
]

/** Values a documentation example uses instead of a real secret. */
const PLACEHOLDER =
  /^(<[^>]*>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\*+|x+|\.\.\.|changeme|change-me|password|secret|example|your[-_].*|xxx.*|redacted|null|none|true|false|pass|pwd|user|""|'')$/i

/** Shannon entropy of a string, in bits per character. */
export function entropy(value: string): number {
  const counts = new Map<string, number>()
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let bits = 0
  for (const n of counts.values()) {
    const p = n / value.length
    bits -= p * Math.log2(p)
  }
  return bits
}

/**
 * `password = hunter2`, `secret: ...`, `API_KEY="..."`, `token=...` lines whose
 * value is not an obvious placeholder, and any assignment of a long,
 * high-entropy value to a credential-looking name.
 */
function assignedSecret(text: string): string | null {
  const assignment =
    /\b([A-Za-z0-9_.-]*(pass(word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([^\s"'`,;]+)/gi
  for (const match of text.matchAll(assignment)) {
    const value = (match[4] ?? "").trim()
    if (value.length < 8 || PLACEHOLDER.test(value)) continue
    if (/^(https?:\/\/|\/)/.test(value) && !/@/.test(value)) continue
    if (value.length >= 16 && entropy(value) >= 3.5) return "high-entropy credential value"
    if (
      /^pass(word|wd)?$|secret$/i.test(match[1] ?? "") &&
      /[0-9]/.test(value) &&
      /[a-z]/i.test(value)
    ) {
      return "password or secret value"
    }
  }
  return null
}

/** `scheme://user:password@host` with a password that is not a placeholder. */
function urlCredentials(text: string): string | null {
  for (const m of text.matchAll(
    /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@"'<>]+):([^\s/@"'<>]+)@[^\s/"'<>]+/gi,
  )) {
    if (!PLACEHOLDER.test(m[2] ?? "")) return "credentials in a URL"
  }
  return null
}

export function secretKind(text: string): string | null {
  for (const [kind, re] of SECRET_PATTERNS) if (re.test(text)) return kind
  return urlCredentials(text) ?? assignedSecret(text)
}

/** Whether a repo-relative path is documentation this collector keeps. */
export function isDocPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/)
  const name = parts[parts.length - 1] ?? ""
  if (parts.some((p) => p.startsWith(".") || SKIP_DIRS.has(p))) return false
  if (/^\.env/i.test(name) || /\.(pem|key|p12|pfx|crt)$/i.test(name)) return false
  if (AGENT_FILES.test(name)) return false
  if (parts.slice(0, -1).some((p) => CODE_DIRS.has(p)) && !/^README\b/i.test(name)) return false
  return DOC_EXTENSIONS.has(extname(name).toLowerCase()) || BARE_NAMES.test(name)
}

/** Shallow first, a README first at each depth, then docs/, then by path: what to keep under a cap. */
export function byImportance(a: string, b: string): number {
  const depth = (p: string) => p.split("/").length
  const readme = (p: string) => (/(^|\/)README[^/]*$/i.test(p) ? 0 : 1)
  const docs = (p: string) => (/^docs?\//i.test(p) ? 0 : 1)
  return depth(a) - depth(b) || readme(a) - readme(b) || docs(a) - docs(b) || a.localeCompare(b)
}

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    const rel = relative(root, full).split(sep).join("/")
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue
      walk(root, full, out)
    } else if (entry.isFile() && isDocPath(rel)) {
      out.push(rel)
    }
  }
}

function main(): void {
  const { values } = parseArgs({
    options: {
      src: { type: "string" },
      out: { type: "string" },
      "web-url": { type: "string" },
      ref: { type: "string", default: "HEAD" },
      "max-files": { type: "string", default: "300" },
    },
  })
  if (!values.src || !values.out) {
    process.stderr.write(
      "usage: collect-repo-docs.ts --src <cloned repo dir> --out <dir> [--web-url <repo url>] [--max-files 300]\n",
    )
    process.exit(2)
  }
  const maxFiles = Number(values["max-files"])
  const webUrl = values["web-url"]?.replace(/\.git$/, "").replace(/\/+$/, "")

  const found: string[] = []
  walk(values.src, values.src, found)
  found.sort(byImportance)
  const kept = found.slice(0, maxFiles)

  const written: string[] = []
  const skipped: Array<{ path: string; reason: string }> = []
  for (const rel of kept) {
    const full = join(values.src, rel)
    // Sized and read through one descriptor: the file measured is the file read.
    const text = withOpenFileSync(full, ({ size }, read) =>
      size > MAX_BYTES ? null : read().toString("utf8"),
    )
    if (text === null) {
      skipped.push({ path: rel, reason: `larger than ${MAX_BYTES} bytes` })
      continue
    }
    if (text.includes("\u0000")) {
      skipped.push({ path: rel, reason: "binary" })
      continue
    }
    const secret = secretKind(text)
    if (secret) {
      skipped.push({ path: rel, reason: `looks like it contains a ${secret}; not copied` })
      continue
    }
    if (text.trim() === "") {
      skipped.push({ path: rel, reason: "empty" })
      continue
    }
    const target = join(values.out, extname(rel) === "" ? `${rel}.txt` : rel)
    mkdirSync(dirname(target), { recursive: true })
    const hasFrontMatter = /^---\r?\n/.test(text)
    const source = webUrl ? `${webUrl}/blob/${values.ref}/${rel}` : rel
    writeFileSync(
      target,
      hasFrontMatter ? text : `---\nsource: ${JSON.stringify(source)}\n---\n\n${text}`,
    )
    written.push(rel)
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        src: values.src,
        out: values.out,
        filesFound: found.length,
        filesWritten: written.length,
        droppedByCap: Math.max(0, found.length - maxFiles),
        files: written,
        skipped,
      },
      null,
      2,
    )}\n`,
  )
}

if (import.meta.main) main()
