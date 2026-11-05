#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Prints `true` when the annotated tag named by argv[2] (or $GIT_TAG) carries a
// line `Security: yes` in its annotation message, else `false`. A lightweight
// tag has no annotation (`%(contents)` would return the commit message), so it
// is always `false`. release.yml reads this once, in `release-prep`, and the
// publish job names the GitHub release `<tag> [security]` from it; instances
// read that name to tell their admins an update fixes a security issue.
//
// Only node builtins: the job that runs it does not `bun install`.

import { execFileSync } from "node:child_process"

/** Whether an annotation message has a line that is exactly `Security: yes`. */
export function hasSecurityMarker(message: string): boolean {
  return message.split(/\r?\n/).some((line) => line.trim() === "Security: yes")
}

export function tagIsSecurityRelease(tag: string, cwd = process.cwd()): boolean {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" })
  if (git("cat-file", "-t", `refs/tags/${tag}`).trim() !== "tag") return false
  return hasSecurityMarker(git("tag", "-l", "--format=%(contents)", tag))
}

if (import.meta.main) {
  const tag = process.argv[2] ?? process.env.GIT_TAG
  if (!tag) {
    console.error("usage: release-security-marker.ts <tag>")
    process.exit(2)
  }
  console.log(String(tagIsSecurityRelease(tag)))
}
