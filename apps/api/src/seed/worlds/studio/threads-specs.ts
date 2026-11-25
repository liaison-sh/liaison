// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `studio` world's team conversations: the Client work channel the whole
// studio reads, the Delivery room where the developers and the project lead
// plan the week and take hand-overs from support, and the Sales room.
// Every age is an offset in hours from the anchor; no string names a date.
import type { DemoThreadSpecs } from "~/seed/tiers/demo/seed-support"

export const STUDIO_CHANNEL_TITLES = {
  clientWork: "Client work",
  delivery: "Delivery",
  sales: "Sales",
} as const

export const STUDIO_THREAD_SPECS: DemoThreadSpecs = {
  threads: [
    {
      key: "client-work",
      title: STUDIO_CHANNEL_TITLES.clientWork,
      creator: "bastien",
      participants: ["bastien", "lea", "nadia", "sarah", "anais"],
      discoverable: true,
      topic: "What clients asked for and what we told them",
      messages: [
        {
          author: "sarah",
          body: "Groupe Marlin is happy with the Beta demo. Pauline wants to talk about phase two after the launch.",
          hoursAgo: 52,
        },
        {
          author: "bastien",
          body: "Éditions Sorel's report for last month went out with the retainer invoice. Thomas had no questions.",
          hoursAgo: 30,
        },
      ],
    },
    {
      key: "delivery",
      title: STUDIO_CHANNEL_TITLES.delivery,
      creator: "bastien",
      // Not discoverable: the accounts layer seats the owner in every channel that is not a
      // browsable one, so the founder reads the delivery room too.
      participants: ["bastien", "nadia", "clara", "emma", "hugo", "lina", "mathis", "noemie"],
      topic: "The week's plan, releases and what support hands over",
      messages: [
        {
          author: "nadia",
          body: "My week is over full with the partner directory. Mathis, could you take the directory import?",
          hoursAgo: 20,
        },
        {
          author: "noemie",
          body: "Coopérative Alpine's stock export stopped after the last release. Ticket is in the Support queue.",
          hoursAgo: 6,
        },
      ],
    },
    {
      key: "sales",
      title: STUDIO_CHANNEL_TITLES.sales,
      creator: "romain",
      participants: ["romain", "sarah", "lea"],
      topic: "Briefs, proposals and the pipeline",
      messages: [
        {
          author: "romain",
          body: "Tessier signed the proposal. The agreement is out, waiting on Jean's signature.",
          hoursAgo: 70,
        },
        {
          author: "sarah",
          body: "Rhône Mutuelle wants a second demo of the claims analytics with their actuaries.",
          hoursAgo: 26,
        },
      ],
    },
  ],
  agentDms: [
    {
      key: "owner-personal",
      agent: "personal",
      messages: [
        { from: "owner", body: "What needs me first?", hoursAgo: 1 },
        {
          from: "agent",
          body: "Pauline Gros asked for single sign-on, which the signed agreement leaves out. The change request and its reply are ready for you on Home.",
          hoursAgo: 1,
        },
      ],
    },
  ],
}
