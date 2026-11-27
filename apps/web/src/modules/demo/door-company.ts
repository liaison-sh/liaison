// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the demo door says about the company a workspace is a copy of. The
// seed's own literals live in apps/api/src/seed/world/fiction.ts, which the web bundle does
// not import, so the few the door names are restated here and in the
// `kernel.demo.company*` strings, and door-company.test.ts pins both to the
// seed.

/** The name of the fictional company every demo workspace is seeded with. */
export const DEMO_COMPANY_NAME = "Resonant Audio Labs"

/** The worlds whose company the door describes (a world with no entry here reads as `products`). */
export type DoorWorldId = "products" | "saas" | "studio"

/**
 * What the door says about each world's company. Strings live under
 * `copyKey`: `kernel.demo` for `products` (its keys are the ones it always
 * had), `kernel.demo.world.<world>` for the others, with `companyFacts`,
 * `companyAbout`, `companyYou`, `companySimulated`, `companyExample` and
 * `pickMoment.<need>` beneath it. door-company.test.ts pins each world to its
 * seed pack, which the web bundle never imports.
 */
export interface DoorCompany {
  name: string
  initials: string
  copyKey: string
}

/** The software company: Tideform, whose seat of CEO the visitor takes. */
export const DEMO_SAAS_COMPANY_NAME = "Tideform"

/** The services company: Halden Studio, whose seat of co-founder the visitor takes. */
export const DEMO_STUDIO_COMPANY_NAME = "Halden Studio"

export const DEMO_DOOR: Readonly<Record<DoorWorldId, DoorCompany>> = {
  products: {
    name: DEMO_COMPANY_NAME,
    initials: "RA",
    copyKey: "kernel.demo",
  },
  saas: {
    name: DEMO_SAAS_COMPANY_NAME,
    initials: "TF",
    copyKey: "kernel.demo.world.saas",
  },
  studio: {
    name: DEMO_STUDIO_COMPANY_NAME,
    initials: "HS",
    copyKey: "kernel.demo.world.studio",
  },
}

/** The company the door describes for `world`: `products` for a world it has no page for. */
export function doorCompanyOf(world: string | null | undefined): DoorCompany {
  return world === "saas" || world === "studio" ? DEMO_DOOR[world] : DEMO_DOOR.products
}
