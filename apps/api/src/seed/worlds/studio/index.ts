// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The `studio` world's pack exports: Halden Studio, a software services firm
 * billing by the day, on a retainer and at fixed prices. Its company, team,
 * clients and the plan for time and budgets. The layer that writes the plan,
 * and the pack's registration in `PACKS`, come with the world's seed layer;
 * until then the world cannot be seeded, and the door never offers it.
 *
 * A driver outside the seed reads `personas` and `namedRows`, never copies.
 */
import type { DemoPerson, DemoRole } from "~/seed/world/fiction"
import type { DemoWorldPack } from "../index"
import {
  STUDIO_AWAY,
  STUDIO_CLIENTS,
  STUDIO_COMPANY,
  STUDIO_DELIVERY_KEYS,
  STUDIO_EMAIL_DOMAIN,
  STUDIO_TEAM,
  STUDIO_WORLD,
} from "./fiction"
import { STUDIO_COST_RATES, STUDIO_DATED_LINES, studioPlan } from "./plan"

function personas(): DemoWorldPack["personas"] {
  const out: Partial<Record<DemoRole, DemoPerson[]>> = {}
  for (const person of STUDIO_TEAM) out[person.role] = [...(out[person.role] ?? []), person]
  return out
}

export const STUDIO_PACK_EXPORTS: Pick<
  DemoWorldPack,
  "id" | "world" | "orgName" | "emailDomain" | "people" | "personas" | "namedRows"
> & { plan: typeof studioPlan } = {
  id: "studio",
  world: STUDIO_WORLD,
  orgName: STUDIO_COMPANY.name,
  emailDomain: STUDIO_EMAIL_DOMAIN,
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
