// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo company's knowledge, beyond the articles written in Liaison: two
// SYNCED sources (the product manuals from a GitLab repository, the finance
// folder from Google Drive) and one playbook written in Liaison, each with the
// access a real company would give it. The company knowledge scenario stands
// on these: the visitor's agent answers from all three, and Lucas from
// support, asking Support Desk the same question, gets nothing from finance.
//
// THE SOURCES ARE REAL ROWS, THE PROVIDERS ARE NOT: the synced-sources
// factory (`seed/factories/knowledge/synced-sources.ts`) creates and syncs
// each one once through the product's own path with a fixture adapter that
// lists the fixed files below. No connected account exists for either app,
// and the sync worker skips sources in a demo org (knowledge-jobs.ts), so the
// scheduled ticks and a document's force-on-open leave these rows as seeded.
//
// ACCESS IS THE PRODUCT'S. Every document's sharing is set with
// `setDocumentSharing`, the call the Share dialog makes: the manuals readable
// by the whole company, the finance files by the finance and admin roles and
// Henrik Sandberg only, the playbook editable by sales. The database enforces
// it (RLS on the documents, the search ACL projection), not an agent.
//
// Idempotent: a source is found by its app and folder before one is created,
// the reconciler upserts by file identity, sharing is replaced as a whole, and
// the playbook is found by its title.

import { KNOWLEDGE_SCENARIO_PL_TITLE } from "@liaison/shared"
import type { UserContext } from "~/db/rls"
import { seedContext } from "~/seed/context"
import {
  type DocumentSharing,
  roleIdsByName,
  type SyncedFileSpec,
  seedSyncedSources,
  seedWrittenDocument,
} from "~/seed/factories/knowledge/synced-sources"
import type { SeedDemoOrgResult } from "./seed-org"

// ── The files ─────────────────────────────────────────────────────────────

interface SyncedSourceSpec {
  key: "manuals" | "finance"
  appName: "gitlab" | "google-drive"
  folderRef: string
  displayName: string
  defaultSensitivity: "internal" | "confidential"
  /** How long ago its last (seeded) sync ran. */
  lastSyncHoursAgo: number
  files: SyncedFileSpec[]
  /** Who may open its documents. */
  access: "company" | "finance"
}

export const KESTREL_MANUAL_TITLE = "Kestrel 10 user manual"
export const PREAMP_NOTES_TITLE = "Field Preamp firmware notes"
export const CASH_FORECAST_TITLE = "Cash forecast, next 6 months"
export const MARKETING_PLAYBOOK_TITLE = "Marketing funnel playbook"
export const PL_TITLE = KNOWLEDGE_SCENARIO_PL_TITLE

const GITLAB_BASE = "https://gitlab.resonantaudiolabs.example/resonant/manuals/-/blob/main"
const DRIVE_BASE = "https://drive.resonantaudiolabs.example/file/d"

const KESTREL_MANUAL = [
  "# Kestrel 10 user manual",
  "",
  "Revision 4.2, for firmware 1.8 and later. Maintained by the product team in resonant/manuals.",
  "",
  "## 1. What is in the box",
  "The Kestrel 10 recorder, a USB-C cable, a battery sled with two NP-F slots, a quick start sheet in",
  "English and French, and a soft pouch. Batteries and cards are sold separately.",
  "",
  "## 2. First start",
  "Slide a charged NP-F battery into the sled, insert an SDXC card (V30 or faster) and hold the power",
  "key for two seconds. The recorder formats nothing on its own: format the card from Menu > Media.",
  "",
  "## 3. Inputs and gain",
  "Ten inputs: eight XLR/TRS combo inputs with 48 V phantom power per channel, and a stereo line input.",
  "Gain runs from 0 to 76 dB in 1 dB steps. The limiter is per channel and off by default.",
  "",
  "## 4. Recording formats",
  "Polyphonic or mono WAV at 48, 96 or 192 kHz, 24 or 32-bit float. Each take writes an iXML and BWF",
  "header with the scene, take and timecode.",
  "",
  "## 5. Timecode and sync",
  "Timecode in and out on the LEMO connector, jam sync from an external source, and the clock and control",
  "bus to a Kestrel Field Preamp for four more synchronised inputs.",
  "",
  "## 6. Power",
  "About 7 hours on two NP-F 970 batteries with eight channels armed and phantom power on four. The",
  "USB-C port powers the recorder and charges nothing.",
  "",
  "## 7. Firmware 1.8: the input stage fix",
  "Firmware 1.8 recalibrates the input stage at every power on and corrects the gain drift some units",
  "showed on channels 5 to 8 after a cold start. Before 1.8, that drift was the first reason units came",
  "back: 41 of the 58 Kestrel 10 returns in Q2 2026 were input noise or drift with no hardware fault.",
  "Since 1.8 shipped at the start of Q3, returns fell from 3.1 % to 1.2 % of units shipped, and the",
  "Kestrel 10 became our best seller, at 58 % of the units we shipped in Q3.",
  "",
  "To update: download 1.8 from Kestrel Link, copy it to the root of the card, then Menu > System >",
  "Update. Keep the battery above 30 % during the update. Support asks every customer reporting noise",
  "to update first, before any return is opened.",
  "",
  "## 8. Care and warranty",
  "Two years standard warranty, four with the Extended Care Plan. See the warranty policy in Knowledge for",
  "what is covered.",
].join("\n")

const PREAMP_NOTES = [
  "# Field Preamp firmware notes",
  "",
  "Release notes for the Kestrel Field Preamp, newest first. Maintained in resonant/manuals.",
  "",
  "## 1.3.1",
  "- Phantom power now comes up one channel at a time, 150 ms apart, so a Kestrel 6 on battery no longer",
  "  browns out when four condensers are switched on together.",
  "- The preamp reports its firmware version to the recorder over the control bus; Kestrel Link shows it.",
  "",
  "## 1.3.0",
  "- Shares the input stage calibration introduced in Kestrel 10 firmware 1.8: run it from the recorder",
  "  (Menu > Inputs > Calibrate linked preamp).",
  "- Fixes a clock drift of up to one frame per hour when the preamp was linked before the recorder had",
  "  locked to external timecode.",
  "",
  "## 1.2.4",
  "- Fixes a click on channel 2 when the high-pass filter is switched while recording.",
  "",
  "Known issue: hum that appears only on the linked channels is almost always a ground loop at the",
  "location, not the preamp. The troubleshooting guide has the room swap test.",
].join("\n")

const Q3_PL = [
  "# Q3 2026 P&L",
  "",
  "Resonant Audio Labs SAS, July to September 2026, in EUR. Prepared by Henrik Sandberg, finance.",
  "Management accounts, not audited.",
  "",
  "| Line | Q3 2026 (EUR) |",
  "|---|---:|",
  "| Revenue | 1,284,000 |",
  "| Cost of goods sold | 706,200 |",
  "| Gross margin | 577,800 |",
  "| Gross margin rate | 45.0 % |",
  "| Operating expenses | 481,500 |",
  "| Operating result | 96,300 |",
  "",
  "## Revenue by product (units shipped)",
  "",
  "| Product | Units | Share of units |",
  "|---|---:|---:|",
  "| Kestrel 10 | 1,102 | 58 % |",
  "| Kestrel 6 | 437 | 23 % |",
  "| Kestrel Field Preamp | 247 | 13 % |",
  "| Kestrel 4 | 114 | 6 % |",
  "",
  "## Comments",
  "- The Kestrel 10 drove the quarter: 58 % of units shipped, at a higher margin than the range, and",
  "  fewer returns since firmware 1.8 (see the Kestrel 10 user manual, section 7).",
  "- Gross margin rate is up from 41.2 % in Q2, mostly from fewer warranty replacements.",
  "- Operating expenses include the trade show in September (38,400) and two support hires.",
].join("\n")

const CASH_FORECAST = [
  "# Cash forecast, next 6 months",
  "",
  "Rolling forecast, October 2026 to March 2027, in EUR. Owner: Henrik Sandberg. Updated monthly.",
  "",
  "| Month | Receipts | Payments | Closing cash |",
  "|---|---:|---:|---:|",
  "| Opening, 1 October | | | 742,000 |",
  "| October | 418,000 | 391,000 | 769,000 |",
  "| November | 446,000 | 402,000 | 813,000 |",
  "| December | 512,000 | 471,000 | 854,000 |",
  "| January | 352,000 | 448,000 | 758,000 |",
  "| February | 361,000 | 395,000 | 724,000 |",
  "| March | 409,000 | 412,000 | 721,000 |",
  "",
  "## Assumptions",
  "- Dealer payments at 45 days, direct sales at checkout.",
  "- January carries the component order for the spring production run (96,000).",
  "- No new financing. The credit line (250,000) stays undrawn.",
].join("\n")

const SYNCED_SOURCES: SyncedSourceSpec[] = [
  {
    key: "manuals",
    appName: "gitlab",
    folderRef: "resonant/manuals",
    displayName: "resonant/manuals",
    defaultSensitivity: "internal",
    lastSyncHoursAgo: 2,
    access: "company",
    files: [
      {
        externalId: "resonant/manuals:kestrel-10-user-manual.md",
        name: KESTREL_MANUAL_TITLE,
        url: `${GITLAB_BASE}/kestrel-10-user-manual.md`,
        modifiedHoursAgo: 30,
        body: KESTREL_MANUAL,
      },
      {
        externalId: "resonant/manuals:field-preamp-firmware-notes.md",
        name: PREAMP_NOTES_TITLE,
        url: `${GITLAB_BASE}/field-preamp-firmware-notes.md`,
        modifiedHoursAgo: 75,
        body: PREAMP_NOTES,
      },
    ],
  },
  {
    key: "finance",
    appName: "google-drive",
    folderRef: "1rAL-finance-folder",
    displayName: "Finance",
    defaultSensitivity: "confidential",
    lastSyncHoursAgo: 0.5,
    access: "finance",
    files: [
      {
        externalId: "1rAL-q3-2026-pl",
        name: PL_TITLE,
        url: `${DRIVE_BASE}/1rAL-q3-2026-pl/view`,
        modifiedHoursAgo: 52,
        body: Q3_PL,
      },
      {
        externalId: "1rAL-cash-forecast-6m",
        name: CASH_FORECAST_TITLE,
        url: `${DRIVE_BASE}/1rAL-cash-forecast-6m/view`,
        modifiedHoursAgo: 120,
        body: CASH_FORECAST,
      },
    ],
  },
]

/**
 * A source adapter that lists the fixed files of `spec` instead of calling the
 * provider: what the reconciler is handed for the one seeded sync.
 */

// ── The playbook written in Liaison ─────────────────────────────────────────

const MARKETING_PLAYBOOK = [
  "# Marketing funnel playbook",
  "",
  "How a stranger becomes a Kestrel owner, and what we do at each step. Owned by sales; everyone can",
  "read it, sales edits it.",
  "",
  "## 1. Discover",
  "Field recordists find us through reviews, the trade shows and the dealers' demo days. Every review",
  "unit goes out with firmware current and a printed note on the input stage calibration.",
  "",
  "## 2. Consider",
  "The comparison page and the sample library do the work. A question that reaches the desk from a",
  "prospect is answered within one working day, by sales, not support.",
  "",
  "## 3. Buy",
  "Direct on the shop, or through a dealer. A dealer lead is passed to the dealer the same day, never",
  "kept.",
  "",
  "## 4. Own",
  "The welcome mail points to the manual and the firmware update. A first-week check-in goes to every",
  "Kestrel 10 owner: since firmware 1.8 it is where most of our five-star reviews start.",
  "",
  "## 5. Recommend",
  "Owners who review us get an early look at the next release. We ask once, never twice.",
  "",
  "## Numbers we watch",
  "Visit to trial request, trial to order, and returns within 30 days. Finance shares the margin by",
  "product with sales each quarter; it is not copied here.",
].join("\n")

// ── The seed ────────────────────────────────────────────────────────────────

export interface SeedKnowledgeSourcesResult {
  syncedSourceIds: string[]
  collectionIds: string[]
  documentIds: string[]
}

/**
 * Seed the two synced sources, their documents and the playbook, with their
 * sharing. `admin` authors (the founder, who owns the sources); people are
 * found by their seed key. Only reached for a demo org: its one caller is the
 * demo support layer, on the org the demo tier created or adopted.
 */
export async function seedKnowledgeSources(
  org: SeedDemoOrgResult,
  admin: UserContext,
  now: Date,
  log: (msg: string) => void,
): Promise<SeedKnowledgeSourcesResult> {
  const ctx = seedContext({ orgId: org.orgId, now, log })
  const roles = await roleIdsByName(ctx)
  const roleId = (name: string): string => {
    const id = roles.get(name)
    if (!id) throw new Error(`demo knowledge seed: no '${name}' role`)
    return id
  }
  const personId = (key: string): string => {
    const id = org.peopleByKey[key]?.userId
    if (!id) throw new Error(`demo knowledge seed: no person '${key}'`)
    return id
  }
  const sharingOf = (access: SyncedSourceSpec["access"]): DocumentSharing =>
    access === "company"
      ? { orgAccess: "viewer", editScope: null, shares: [], roleShares: [] }
      : {
          orgAccess: "none",
          editScope: null,
          shares: [{ userId: personId("henrik"), role: "viewer" }],
          roleShares: [
            { roleId: roleId("finance"), role: "viewer" },
            { roleId: roleId("admin"), role: "editor" },
          ],
        }

  const synced = await seedSyncedSources(
    ctx,
    admin,
    SYNCED_SOURCES.map((spec) => ({ ...spec, sharing: sharingOf(spec.access) })),
  )

  // The playbook, written in Liaison by sales, in a collection of its own.
  const giulia = personId("giulia")
  const playbook = await seedWrittenDocument(ctx, admin, {
    collection: {
      name: "Playbooks",
      description: "How sales and marketing work, step by step.",
      ownerUserId: giulia,
    },
    document: {
      title: MARKETING_PLAYBOOK_TITLE,
      summary: "From first review to recommendation: what we do at each step of the funnel.",
      body: MARKETING_PLAYBOOK,
      ownerUserId: giulia,
      tags: ["marketing", "sales"],
      sensitivity: "internal",
      orgAccess: "viewer",
      verifyNow: true,
    },
    sharing: {
      orgAccess: "viewer",
      editScope: null,
      shares: [],
      roleShares: [{ roleId: roleId("sales"), role: "editor" }],
    },
  })

  const collectionIds = [...synced.collectionIds, playbook.collectionId]
  const documentIds = [...synced.documentIds, playbook.documentId]
  log(
    `knowledge sources: ${synced.syncedSourceIds.length} synced sources, ${documentIds.length} documents ` +
      `(the finance folder shared with finance, admins and Henrik only)`,
  )
  return { syncedSourceIds: synced.syncedSourceIds, collectionIds, documentIds }
}
