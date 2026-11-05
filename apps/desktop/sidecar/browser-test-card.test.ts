// SPDX-License-Identifier: FSL-1.1-ALv2
//
// D56 F3: the files a browser test card lists, with REAL git in a temp repo.
import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  BROWSER_TEST_FILES_MAX,
  BROWSER_TEST_RIGHTS,
  browserTestFilesChanged,
  browserTestReason,
  isBrowserTestFile,
} from "./browser-test-card"

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "browser-card-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: root,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CEILING_DIRECTORIES: root,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
}

function git(dir: string, ...args: string[]): string {
  const out = spawnSync("git", ["-C", dir, ...args], { env: ENV, encoding: "utf8" })
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`)
  return out.stdout.trim()
}

function write(dir: string, rel: string, content = "x\n"): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  writeFileSync(path.join(dir, rel), content)
}

let n = 0
function repo(): string {
  const dir = path.join(root, `repo-${n++}`)
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "-b", "main")
  write(dir, "README.md")
  write(dir, "package.json", "{}\n")
  write(dir, "src/app.ts")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
  return dir
}

describe("D56 F3: the browser test card's files", () => {
  it("names the Playwright config, test and spec files, setup files, package.json and node_modules/.bin; nothing else", () => {
    for (const rel of [
      "playwright.config.ts",
      "apps/web/playwright.config.mjs",
      "playwright-ct.config.js",
      "tests/home.spec.ts",
      "e2e/login.test.tsx",
      "e2e/auth.setup.ts",
      "global-setup.ts",
      "tests/globalSetup.js",
      "global.teardown.mts",
      "package.json",
      "packages/ui/package.json",
      "node_modules/.bin/playwright",
      "apps/web/node_modules/.bin/tsx",
    ]) {
      expect({ rel, is: isBrowserTestFile(rel) }).toEqual({ rel, is: true })
    }
    for (const rel of [
      "README.md",
      "src/app.ts",
      "package-lock.json",
      "docs/testing.md",
      "node_modules/x/index.js",
    ]) {
      expect({ rel, is: isBrowserTestFile(rel) }).toEqual({ rel, is: false })
    }
  })

  it("lists uncommitted, untracked and committed-since-start changes of that kind, sorted, once each", () => {
    const dir = repo()
    const start = git(dir, "rev-parse", "HEAD")
    // Committed by the session after its start.
    write(dir, "playwright.config.ts", "export default {}\n")
    write(dir, "src/app.ts", "changed\n")
    git(dir, "add", ".")
    git(dir, "commit", "-qm", "session")
    // Uncommitted: a tracked edit, untracked files in a new folder.
    write(dir, "package.json", '{"scripts":{"pretest":"curl evil"}}\n')
    write(dir, "tests/home.spec.ts")
    write(dir, "tests/fixtures/data.json")
    write(dir, "README.md", "edited\n")
    expect(browserTestFilesChanged({ cwd: dir, sinceHead: start, env: ENV })).toEqual({
      files: ["package.json", "playwright.config.ts", "tests/home.spec.ts"],
      more: 0,
    })
    // Without the start commit only the uncommitted ones count.
    expect(browserTestFilesChanged({ cwd: dir, env: ENV }).files).toEqual([
      "package.json",
      "tests/home.spec.ts",
    ])
  })

  it("lists node_modules/.bin entries modified since the session started, even when git ignores them", () => {
    const dir = repo()
    write(dir, ".gitignore", "node_modules/\n")
    git(dir, "add", ".gitignore")
    git(dir, "commit", "-qm", "ignore")
    write(dir, "node_modules/.bin/old")
    write(dir, "node_modules/.bin/playwright", "#!/bin/sh\n")
    const since = Date.now() - 60_000
    const old = new Date(since - 3_600_000)
    utimesSync(path.join(dir, "node_modules/.bin/old"), old, old)
    expect(browserTestFilesChanged({ cwd: dir, sinceMs: since, env: ENV })).toEqual({
      files: ["node_modules/.bin/playwright"],
      more: 0,
    })
  })

  it("is bounded: at most BROWSER_TEST_FILES_MAX listed, the rest counted; a folder that is no repository lists nothing", () => {
    const dir = repo()
    for (let i = 0; i < BROWSER_TEST_FILES_MAX + 5; i++) write(dir, `tests/t${100 + i}.spec.ts`)
    const got = browserTestFilesChanged({ cwd: dir, env: ENV })
    expect(got.files.length).toBe(BROWSER_TEST_FILES_MAX)
    expect(got.more).toBe(5)
    const plain = path.join(root, "plain")
    write(plain, "playwright.config.ts")
    expect(browserTestFilesChanged({ cwd: plain, env: ENV })).toEqual({ files: [], more: 0 })
  })

  it("the English reason says the repository's code runs with full rights and names the files", () => {
    expect(BROWSER_TEST_RIGHTS).toContain("runs with your full rights")
    expect(BROWSER_TEST_RIGHTS).toContain("Playwright config, the tests, package scripts")
    expect(browserTestReason({ files: [], more: 0 })).toBe(
      `${BROWSER_TEST_RIGHTS} No such file changed in this folder.`,
    )
    expect(browserTestReason({ files: ["package.json", "a.spec.ts"], more: 3 })).toBe(
      `${BROWSER_TEST_RIGHTS} Changed in this folder: package.json, a.spec.ts and 3 more.`,
    )
  })
})
