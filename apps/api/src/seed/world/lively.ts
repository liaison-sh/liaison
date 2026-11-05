// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The lively world: the demo company with three more people, so the desk reads
// as a ten-person team (a second support specialist, an operations associate
// and an accounts assistant). Same fiction, same reserved addresses: the three
// are ordinary entries of the team list and every layer treats them as such.
// The demo tier never reads this file, so its world stays exactly as it was.
import { DEMO_EMAIL_DOMAIN, DEMO_WORLD, type DemoPerson, type DemoWorld } from "./fiction"

export const LIVELY_EXTRA_TEAM: DemoPerson[] = [
  {
    key: "noemie",
    name: "Noemie Garnier",
    jobTitle: "Customer Support Specialist",
    role: "support",
    email: `noemie@${DEMO_EMAIL_DOMAIN}`,
    bio: "Covers the evening shift and the dealer support line. Writes most of the getting started articles.",
  },
  {
    key: "joel",
    name: "Joel Weber",
    jobTitle: "Operations Associate",
    role: "ops_lead",
    email: `joel@${DEMO_EMAIL_DOMAIN}`,
    bio: "Keeps the dealer orders moving and chases the carriers. Backs up the head of operations on the morning digest.",
  },
  {
    key: "clara",
    name: "Clara Moreau",
    jobTitle: "Accounts Assistant",
    role: "finance",
    email: `clara@${DEMO_EMAIL_DOMAIN}`,
    bio: "Sends the invoices, matches the payments and chases what is overdue. Prepares the month end file for finance.",
  },
]

export const LIVELY_WORLD: DemoWorld = {
  ...DEMO_WORLD,
  team: [...DEMO_WORLD.team, ...LIVELY_EXTRA_TEAM],
}
