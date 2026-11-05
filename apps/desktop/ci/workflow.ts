// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One parse of the desktop release workflow, shared by the tests that pin its
// shape. The workflow is the only artifact in this repo where the SIGNING
// ORDER is written down, and an order mistake there is silent: the bundle
// builds, the pipeline is green, and the refusal happens on a customer's Mac.
// So the file is read as data, and the order is asserted, not reviewed.

import { readFileSync } from "node:fs"
import path from "node:path"

/** `apps/desktop/ci` -> the repo root. */
export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..")
export const WORKFLOW_PATH = path.join(REPO_ROOT, "apps/desktop/ci/desktop-release.workflow.yml")

export type Step = {
  name?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
  if?: string
}
export type Job = {
  "runs-on": string
  needs?: string[]
  steps: Step[]
}
export type Workflow = {
  name: string
  on: { push: { tags: string[] } }
  jobs: Record<string, Job>
}

export function loadDesktopReleaseWorkflow(): Workflow {
  return Bun.YAML.parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow
}

/** Index of the step with this exact name, or -1. Names are the contract. */
export function stepIndex(steps: Step[], name: string): number {
  return steps.findIndex((step) => step.name === name)
}

/** The step with this exact name; throws rather than returning undefined, so
 *  a renamed step fails the assertion that named it instead of passing it. */
export function step(steps: Step[], name: string): Step {
  const found = steps.find((entry) => entry.name === name)
  if (!found) throw new Error(`no step named ${name}`)
  return found
}

/** A GitHub Actions secret reference, by name. Built rather than written out
 *  so a test can assert the exact string without a linter reading it as a
 *  template literal somebody forgot to interpolate. */
export function secretRef(name: string): string {
  return `\${{ secrets.${name} }}`
}
