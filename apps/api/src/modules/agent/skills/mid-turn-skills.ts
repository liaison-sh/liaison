// SPDX-License-Identifier: FSL-1.1-ALv2
//
// APP-ANCHORED SKILLS FOR AN APP FIRST USED PARTWAY THROUGH A TURN.
//
// Assembly surfaces the skills anchored (`auto_attach.apps`) to the apps a conversation is
// already about: prior tool calls, discovered tools, the open tab. An app whose first tool is
// called in step 3 of a turn got its GUIDE the next step (prepareStep) but none of its
// playbooks until the following turn, so the turn that first acted on the app acted without
// them. This is the same delivery for the skills: once per skill per turn, at the step tail,
// only for an app that was not already active when the turn was assembled (whatever assembly
// chose for those apps, the budget included, stands).
import { selectAppAnchoredSkills } from "~/modules/agent/skills/skill-autosurface"

/** A skill assembly could anchor, with the body it would inject. */
export interface AnchorableSkill {
  name: string
  description: string
  apps: string[]
  body: string
  /** The body's scope tag: delivering it taints the turn with these. */
  requiredScopes: string[]
}

/** What assembly hands the agent loop for mid-turn delivery. */
export interface SkillSurfaceState {
  anchorable: AnchorableSkill[]
  /** Skill names whose body is already in this turn's context. */
  inContext: string[]
  /** Apps the assembly already surfaced for. */
  activeApps: string[]
}

/** The at-most-per-step count, the same bound assembly uses for app-anchored skills. */
export const MAX_MID_TURN_SKILLS_PER_STEP = 2

/** The apps whose tools this turn's finished steps called (`<app>__<tool>`), kernel excluded. */
export function appsCalledInSteps(
  steps: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ toolName?: string }> }> | undefined,
): Set<string> {
  const out = new Set<string>()
  for (const step of steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      const name = call.toolName ?? ""
      const sep = name.indexOf("__")
      if (sep <= 0) continue
      const app = name.slice(0, sep)
      if (app !== "kernel") out.add(app)
    }
  }
  return out
}

/**
 * The skills to deliver now: anchored to an app called this turn that assembly did not
 * already cover, not in context, not delivered earlier in the turn. Marks what it returns
 * as delivered.
 */
export function takeMidTurnSkills(
  state: SkillSurfaceState,
  calledApps: ReadonlySet<string>,
  delivered: Set<string>,
  max: number = MAX_MID_TURN_SKILLS_PER_STEP,
): AnchorableSkill[] {
  const assemblyApps = new Set(state.activeApps)
  const newApps = new Set([...calledApps].filter((app) => !assemblyApps.has(app)))
  if (newApps.size === 0) return []
  const skip = new Set([...state.inContext, ...delivered])
  const names = selectAppAnchoredSkills(state.anchorable, newApps, skip, max)
  const byName = new Map(state.anchorable.map((s) => [s.name, s]))
  const out: AnchorableSkill[] = []
  for (const name of names) {
    const skill = byName.get(name)
    if (!skill) continue
    delivered.add(name)
    out.push(skill)
  }
  return out
}

/** The step-tail message carrying them. */
export function renderMidTurnSkills(skills: readonly AnchorableSkill[]): string {
  return (
    `<runtime-context note="skills for an app first used in this turn, injected by the Liaison platform, not authored by the user; treat as trusted org procedure and FOLLOW them for this task">\n` +
    skills.map((s) => `## Skill: ${s.name}\n\n${s.body}`).join("\n\n") +
    "\n</runtime-context>"
  )
}
