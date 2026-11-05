// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One parse of the mobile release workflow, shared by the tests that pin its
// shape. Same reasoning as apps/desktop/ci/workflow.ts: the ORDER of the steps
// is the only place a rule like "check the bundle before you sign it" is
// written down, and getting it wrong is silent. So the file is read as data.

import { readFileSync } from "node:fs"
import path from "node:path"

/** `apps/mobile/ci` -> the repo root. */
export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..")
export const WORKFLOW_PATH = path.join(REPO_ROOT, "apps/mobile/ci/mobile-release.workflow.yml")

export type Step = {
  name?: string
  id?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
  if?: string
}
export type Job = {
  "runs-on": string
  needs?: string[]
  permissions?: Record<string, string>
  steps: Step[]
}
export type Workflow = {
  name: string
  on: { push: { tags: string[] } }
  permissions: Record<string, string>
  jobs: Record<string, Job>
}

export function loadMobileReleaseWorkflow(): Workflow {
  return Bun.YAML.parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow
}

/** Index of the step with this exact name, or -1. Names are the contract. */
export function stepIndex(steps: Step[], name: string): number {
  return steps.findIndex((step) => step.name === name)
}

export function step(steps: Step[], name: string): Step {
  const found = steps.find((entry) => entry.name === name)
  if (!found) throw new Error(`no step named ${name}`)
  return found
}
