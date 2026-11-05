// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the demo door says about the company a workspace is a copy of. The
// seed's own literals live in apps/api/src/seed/world/fiction.ts, which the web bundle does
// not import, so the few the door names are restated here and in the
// `kernel.demo.company*` / `kernel.demo.team*` strings, and
// door-company.test.ts pins both to the seed.

/** The name of the fictional company every demo workspace is seeded with. */
export const DEMO_COMPANY_NAME = "Resonant Audio Labs"

/**
 * The teammates the door lists under "The team", in the seed's order, keyed
 * like `DEMO_TEAM`. The founder is left out: the visitor is the CEO.
 */
export const DEMO_DOOR_TEAM = [
  { key: "tobias", name: "Tobias Braun" },
  { key: "amina", name: "Amina Cherif" },
  { key: "lucas", name: "Lucas Pereira" },
  { key: "margot", name: "Margot Dufour" },
  { key: "henrik", name: "Henrik Sandberg" },
  { key: "giulia", name: "Giulia Ferrari" },
] as const

/** The six parts of the company's operations, each with the app it runs in. */
export const DEMO_DOOR_OPS = [
  { key: "support", app: "tickets" },
  { key: "orders", app: "shopify" },
  { key: "invoicing", app: "invoicing" },
  { key: "sales", app: "crm" },
  { key: "projects", app: "projects" },
  { key: "knowledge", app: "knowledge" },
] as const
