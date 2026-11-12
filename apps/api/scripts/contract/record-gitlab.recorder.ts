// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the gitlab app's contract fixtures (fixtures/gitlab/*.json) against
// real gitlab.com, reading PUBLIC projects only (the `gitlab-examples` group
// and two of its projects, one milestone read of `gitlab-org/cli`), so every
// answer recorded is public data. The token is any valid gitlab.com token of
// the person recording (a read-only personal access token, or an OAuth token
// such as the GitLab CLI's), given in GITLAB_RECORD_TOKEN: it is stored as the
// contract org's connection and added host-side by `ctx.fetch` auth, never seen
// by the app or written to a fixture. The token owner's profile (the verify
// read) is reduced to a stand-in before it is recorded, and every other person
// in an answer (names, handles, avatars) is replaced by the recorder's scrub.
// Not part of any suite run (it skips unless CONTRACT_RECORD=1): run it by
// path when the app's calls change, read what it wrote, commit it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && CONTRACT_RECORD=1 \
//     GITLAB_RECORD_TOKEN=... bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./scripts/contract/record-gitlab.recorder.ts)
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { join } from "node:path"
import type { AppBridge } from "~/modules/apps/sandbox/run-app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  connectCredentials,
  installForRecording,
  type RecordingState,
  type RecordingStep,
  runRecordingPlan,
  uninstallAfterRecording,
} from "./recording-run"

const APP = "gitlab"
const TOKEN = process.env.GITLAB_RECORD_TOKEN ?? ""
const GROUP = "gitlab-examples"
/** gitlab-examples/semantic-release-npm: issues, closed merge requests, releases, tags. */
const RELEASES_PROJECT = "22738259"
/** gitlab-examples/gitlab-game-demo: a `doc` folder of Markdown and images. */
const DOCS_PROJECT = "23764176"
const COMMIT = "a25752217d8fbf001332f14738afbfa0b60e0a50"
const STAND_IN_USER = {
  id: 1,
  username: "contract-reader",
  name: "Contract Reader",
  state: "active",
}

type Rec = Record<string, unknown>
const params = (p: Rec) => ({ params: p })

const PLAN: RecordingStep[] = [
  { entry: "tool:gitlab_list_projects", input: () => params({}) },
  {
    entry: "tool:gitlab_list_commits",
    input: () => params({ project: RELEASES_PROJECT, path: "index.js" }),
  },
  {
    entry: "tool:gitlab_get_commit",
    input: () => params({ project: RELEASES_PROJECT, sha: COMMIT, withDiff: true }),
  },
  {
    entry: "tool:gitlab_list_merge_requests",
    input: () => params({ project: RELEASES_PROJECT, state: "closed" }),
  },
  {
    entry: "tool:gitlab_get_merge_request",
    input: () => params({ project: RELEASES_PROJECT, iid: 8, withChanges: true }),
  },
  {
    entry: "tool:gitlab_list_issues",
    input: () => params({ project: RELEASES_PROJECT, state: "all" }),
  },
  {
    entry: "tool:gitlab_list_milestones",
    input: () => params({ project: "gitlab-org/cli", state: "active" }),
  },
  { entry: "tool:gitlab_list_labels", input: () => params({ project: RELEASES_PROJECT }) },
  { entry: "tool:gitlab_list_releases", input: () => params({ project: RELEASES_PROJECT }) },
  { entry: "tool:gitlab_list_tags", input: () => params({ project: RELEASES_PROJECT }) },
  {
    entry: "tool:gitlab_read_file",
    input: () =>
      params({
        project: DOCS_PROJECT,
        path: "README.md",
        ref: "master",
        startLine: 1,
        endLine: 20,
      }),
  },
  {
    entry: "tool:gitlab_list_tree",
    input: () => params({ project: DOCS_PROJECT, path: "doc", ref: "master" }),
  },
  {
    entry: "tool:gitlab_search",
    input: () => params({ project: DOCS_PROJECT, scope: "blobs", query: "Continuous Integration" }),
  },
  {
    entry: "knowledge-sync:folder",
    input: () =>
      params({
        sourceId: "00000000-0000-4000-8000-00000000c0e3",
        kind: "folder",
        config: { ref: `${DOCS_PROJECT}:master:doc` },
        cursor: null,
      }),
  },
  {
    entry: "knowledge-items:search",
    input: () => params({ query: "Continuous Integration", limit: 5, cursor: null }),
  },
  {
    entry: "knowledge-items:resolve",
    input: () => params({ ref: `${DOCS_PROJECT}:master:README.md`, content: true }),
  },
  { entry: "provision:handler", input: () => params({ config: {}, dryRun: false }) },
  { entry: "provision:verify", input: () => params({ config: {} }) },
]

/** The token owner's profile becomes a stand-in before the app (and the fixture) sees it. */
function standInProfile(bridge: AppBridge): AppBridge {
  const real = bridge as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  const fetch = real.fetch
  if (typeof fetch !== "function") return bridge
  return new Proxy(bridge as object, {
    get(target, prop, receiver) {
      if (prop !== "fetch") return Reflect.get(target, prop, receiver)
      return async (...args: unknown[]) => {
        const answer = await fetch.apply(target, args)
        if (typeof args[0] !== "string" || !args[0].endsWith("/api/v4/user")) return answer
        const parsed = (typeof answer === "string" ? JSON.parse(answer) : answer) as {
          status: number
          headers: Record<string, string>
          body: string
        }
        const out = { ...parsed, body: JSON.stringify(STAND_IN_USER) }
        return typeof answer === "string" ? JSON.stringify(out) : out
      }
    },
  }) as AppBridge
}

describe.skipIf(process.env.CONTRACT_RECORD !== "1")("record gitlab contract fixtures", () => {
  let installed: Awaited<ReturnType<typeof installForRecording>>

  beforeAll(async () => {
    if (!TOKEN) throw new Error("GITLAB_RECORD_TOKEN is required")
    await acquireTestLock()
    installed = await installForRecording(APP, {})
    await connectCredentials(APP, "gitlab", GROUP, { token: TOKEN, group: GROUP })
  }, 300_000)

  afterAll(async () => {
    await uninstallAfterRecording(APP)
    await releaseTestLock()
  })

  it("records every planned entry", async () => {
    const report = await runRecordingPlan({
      app: APP,
      manifest: installed.manifest,
      bridgeManifest: installed.bridgeManifest,
      plan: PLAN,
      state: { values: {} } satisfies RecordingState,
      replacements: [{ from: TOKEN, to: "redacted" }],
      secrets: [TOKEN],
      recordedFrom:
        "public gitlab.com projects (gitlab-examples, gitlab-org/cli) read with a recording token, record-gitlab.recorder.ts",
      fixturesDir: join(import.meta.dir, "../../src/modules/apps/contract/fixtures"),
      appConfig: {},
      wrapBridge: (bridge) => standInProfile(bridge),
    })
    console.log(`\n${report.join("\n")}\n`)
    expect(report.filter((l) => !l.startsWith("ok ") && !l.startsWith("  (prereq)"))).toEqual([])
  }, 900_000)
})
