// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The `studio` world's pack: Halden Studio, a software services firm billing
 * by the day, on a retainer and at fixed prices. Its company, team, clients,
 * the plan for time and budgets, and the layer that writes it (`layer.ts`).
 * The pack is registered in `PACKS`, so the CLI seeds it; the door never offers
 * the world while it has no door tours (`enabledDemoWorlds`).
 *
 * The world holds people, roles, companies, the pipeline, the projects with
 * their time and budgets, who is away, the agreements, the notes of past
 * projects a change request is sized from, its four desks, the support queue,
 * the team's channels and the routines it runs.
 *
 * A driver outside the seed reads `personas` and `namedRows`, never copies.
 */
import type { DemoPerson, DemoRole } from "~/seed/world/fiction"
import type { DemoWorldPack } from "../index"
import { STUDIO_AGENT_NATIVE_SPECS } from "./agent-native"
import { STUDIO_ROLE_AGENTS } from "./desk-prompts"
import {
  STUDIO_AWAY,
  STUDIO_CLIENTS,
  STUDIO_COMPANY,
  STUDIO_DELIVERY_KEYS,
  STUDIO_EMAIL_DOMAIN,
  STUDIO_TEAM,
  STUDIO_WORLD,
} from "./fiction"
import { STUDIO_HANDBOOK_SPECS, STUDIO_KNOWLEDGE_SPECS } from "./knowledge"
import { seedStudioLayer } from "./layer"
import { STUDIO_COST_RATES, STUDIO_DATED_LINES, studioPlan } from "./plan"
import { STUDIO_SUPPORT_SPECS } from "./support-specs"
import { STUDIO_THREAD_SPECS } from "./threads-specs"

function personas(): DemoWorldPack["personas"] {
  const out: Partial<Record<DemoRole, DemoPerson[]>> = {}
  for (const person of STUDIO_TEAM) out[person.role] = [...(out[person.role] ?? []), person]
  return out
}

/** The ticket teams each role works. */
const STUDIO_DESK_TEAMS: DemoWorldPack["deskTeams"] = {
  ops_lead: ["support", "sales"],
  support: ["support"],
  fulfillment: ["support"],
  engineering: ["support"],
  finance: ["finance"],
  sales: ["sales"],
}

export const STUDIO_WORLD_PACK: DemoWorldPack & { plan: typeof studioPlan } = {
  id: "studio",
  world: STUDIO_WORLD,
  orgName: STUDIO_COMPANY.name,
  emailDomain: STUDIO_EMAIL_DOMAIN,
  roleAgents: STUDIO_ROLE_AGENTS,
  deskTeams: STUDIO_DESK_TEAMS,
  supportSpecs: STUDIO_SUPPORT_SPECS,
  knowledgeSpecs: {
    ...STUDIO_KNOWLEDGE_SPECS,
    collections: [...STUDIO_KNOWLEDGE_SPECS.collections, ...STUDIO_HANDBOOK_SPECS.collections],
    articles: [...STUDIO_KNOWLEDGE_SPECS.articles, ...STUDIO_HANDBOOK_SPECS.articles],
  },
  threadSpecs: STUDIO_THREAD_SPECS,
  agentNative: STUDIO_AGENT_NATIVE_SPECS,
  layer: seedStudioLayer,
  people: STUDIO_TEAM,
  personas: personas(),
  namedRows: {
    company: STUDIO_COMPANY,
    clients: STUDIO_CLIENTS,
    delivery: STUDIO_DELIVERY_KEYS,
    costRates: STUDIO_COST_RATES,
    datedLines: STUDIO_DATED_LINES,
    away: STUDIO_AWAY,
  },
  plan: studioPlan,
}

/** The same pack, under the name drivers outside the seed import it by. */
export const STUDIO_PACK_EXPORTS = STUDIO_WORLD_PACK
