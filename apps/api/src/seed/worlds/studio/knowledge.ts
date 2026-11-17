// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The `studio` world's Knowledge: the notes of two past projects, each with the hours its
 * partner sign-on took. A change request for sign-on is sized from them (their mean), never
 * from memory.
 */
import type { DemoKnowledgeSpecs } from "~/seed/tiers/demo/seed-support"

/** The sign-on work of the two past projects, in hours of real time. */
export const STUDIO_PAST_SIGN_ON_HOURS: Readonly<Record<"brume" | "osier", number>> = {
  brume: 52,
  osier: 68,
}

export const STUDIO_KNOWLEDGE_SPECS: DemoKnowledgeSpecs = {
  authorKey: "lea",
  collections: [
    {
      key: "past-projects",
      name: "Past projects",
      description: "Closed client projects: what was built, what it took, and what we learned.",
      owner: "bastien",
    },
  ],
  articles: [
    {
      key: "past-brume",
      title: "Past project: BRUME client extranet",
      collection: "past-projects",
      owner: "bastien",
      summary:
        "Client extranet for Brume Conseil, closed. Partner single sign-on took 52 h of real time.",
      tags: ["past project", "single sign-on"],
      body:
        "# Past project: BRUME client extranet\n\nAn extranet for Brume Conseil's clients, " +
        "fixed price, closed.\n\n## Single sign-on\n\nSign-on for the client's partners through " +
        `their own identity provider took ${STUDIO_PAST_SIGN_ON_HOURS.brume} h of real time, ` +
        "tests and a runbook included.",
      reviewDueInDays: 180,
      verified: true,
    },
    {
      key: "past-osier",
      title: "Past project: OSIER tenant portal",
      collection: "past-projects",
      owner: "bastien",
      summary:
        "Tenant portal for Osier Habitat, closed. Partner single sign-on took 68 h of real time.",
      tags: ["past project", "single sign-on"],
      body:
        "# Past project: OSIER tenant portal\n\nA portal for Osier Habitat's tenants and " +
        "partners, fixed price, closed.\n\n## Single sign-on\n\nSign-on for partners through " +
        `their own identity provider took ${STUDIO_PAST_SIGN_ON_HOURS.osier} h of real time; ` +
        "two identity providers needed their own setup.",
      reviewDueInDays: 180,
      verified: true,
    },
  ],
}
