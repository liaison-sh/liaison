// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The "drifted CRM" contact set: 12 genuine duplicate pairs (the same person
// imported twice, with a different spelling and a different email), near
// duplicate traps (a similar name, a different person) and 95 unique
// distractors. All names and domains are fictional (`.example`).
//
// Pure data. The duplicate-cluster detector's unit test drives it through
// `clusterDuplicates`, and the QA world seeds the same rows, so the detector and
// the world cannot drift apart.

export interface SeedContact {
  handle: string
  name: string
  email: string
  company: string | null
  /** Internal fixture marker: pairs carrying the same dupGroup are the SAME person (genuine
   *  duplicate). null = a unique distractor. NEVER surfaced to the agent — bookkeeping only. */
  dupGroup: string | null
  /** Internal: near-duplicate distractor (same surname / similar name, DIFFERENT person). */
  nearDup?: boolean
}

// 12 genuine duplicate pairs. Each pair = the SAME person imported twice: a name-spelling variant
// (initial vs full, accent normalized, hyphen dropped) + a different email (channel drift). The
// company matches within a pair (same person → same employer) to make the match high-confidence.
export const DUPLICATE_PAIRS: SeedContact[] = [
  // 1 — full first name vs initial
  {
    handle: "ddc-dup-1a",
    name: "Mathias Verbeek",
    email: "mathias.verbeek@northgate.example",
    company: "Northgate Sound",
    dupGroup: "g1",
  },
  {
    handle: "ddc-dup-1b",
    name: "M. Verbeek",
    email: "m.verbeek@gmail.example",
    company: "Northgate Sound",
    dupGroup: "g1",
  },
  // 2 — accented vs unaccented spelling
  {
    handle: "ddc-dup-2a",
    name: "Zoé Lambert",
    email: "zoe.lambert@cobaltstudios.example",
    company: "Cobalt Studios",
    dupGroup: "g2",
  },
  {
    handle: "ddc-dup-2b",
    name: "Zoe Lambert",
    email: "zoe.lambert@reverb-handle.example",
    company: "Cobalt Studios",
    dupGroup: "g2",
  },
  // 3 — hyphen dropped from surname
  {
    handle: "ddc-dup-3a",
    name: "Hanna Vogt-Reiner",
    email: "hanna.vogtreiner@meridiangear.example",
    company: "Meridian Gear",
    dupGroup: "g3",
  },
  {
    handle: "ddc-dup-3b",
    name: "Hanna Vogt Reiner",
    email: "h.vogtreiner@outlook.example",
    company: "Meridian Gear",
    dupGroup: "g3",
  },
  // 4 — middle initial added
  {
    handle: "ddc-dup-4a",
    name: "Diego Marchetti",
    email: "diego.marchetti@harborline.example",
    company: "Harborline Audio",
    dupGroup: "g4",
  },
  {
    handle: "ddc-dup-4b",
    name: "Diego A. Marchetti",
    email: "dmarchetti@harborline.example",
    company: "Harborline Audio",
    dupGroup: "g4",
  },
  // 5 — nickname vs full
  {
    handle: "ddc-dup-5a",
    name: "Katarina Sorensen",
    email: "katarina.sorensen@flux-modular.example",
    company: "Flux Modular",
    dupGroup: "g5",
  },
  {
    handle: "ddc-dup-5b",
    name: "Kat Sorensen",
    email: "kat.sorensen@gmail.example",
    company: "Flux Modular",
    dupGroup: "g5",
  },
  // 6 — transposed given/middle order
  {
    handle: "ddc-dup-6a",
    name: "Joaquim Ferreira",
    email: "joaquim.ferreira@tidewater.example",
    company: "Tidewater Synths",
    dupGroup: "g6",
  },
  {
    handle: "ddc-dup-6b",
    name: "J. Ferreira",
    email: "j.ferreira@reverb-handle.example",
    company: "Tidewater Synths",
    dupGroup: "g6",
  },
  // 7 — umlaut normalized to oe
  {
    handle: "ddc-dup-7a",
    name: "Sören Bachmann",
    email: "soren.bachmann@klangbox.example",
    company: "Klangbox",
    dupGroup: "g7",
  },
  {
    handle: "ddc-dup-7b",
    name: "Soeren Bachmann",
    email: "s.bachmann@klangbox.example",
    company: "Klangbox",
    dupGroup: "g7",
  },
  // 8 — maiden vs married style add-on
  {
    handle: "ddc-dup-8a",
    name: "Priscila Tavares",
    email: "priscila.tavares@orbitsound.example",
    company: "Orbit Sound",
    dupGroup: "g8",
  },
  {
    handle: "ddc-dup-8b",
    name: "Priscila Tavares Reis",
    email: "p.tavares@orbitsound.example",
    company: "Orbit Sound",
    dupGroup: "g8",
  },
  // 9 — spacing in surname
  {
    handle: "ddc-dup-9a",
    name: "Aleksander Nowak",
    email: "aleksander.nowak@studioferro.example",
    company: "Studio Ferro",
    dupGroup: "g9",
  },
  {
    handle: "ddc-dup-9b",
    name: "Alek Nowak",
    email: "alek.nowak@gmail.example",
    company: "Studio Ferro",
    dupGroup: "g9",
  },
  // 10 — initials vs full
  {
    handle: "ddc-dup-10a",
    name: "Beatriz Carvalho",
    email: "beatriz.carvalho@haldengear.example",
    company: "Halden Gear Co",
    dupGroup: "g10",
  },
  {
    handle: "ddc-dup-10b",
    name: "B. Carvalho",
    email: "bcarvalho@haldengear.example",
    company: "Halden Gear Co",
    dupGroup: "g10",
  },
  // 11 — surname typo (same given name, obvious one-letter slip) → unambiguously the same person
  {
    handle: "ddc-dup-11a",
    name: "Wei Zhang",
    email: "wei.zhang@northpeak.example",
    company: "Northpeak Audio",
    dupGroup: "g11",
  },
  {
    handle: "ddc-dup-11b",
    name: "Wei Zhnag",
    email: "w.zhang@northpeak.example",
    company: "Northpeak Audio",
    dupGroup: "g11",
  },
  // 12 — extra surname particle
  {
    handle: "ddc-dup-12a",
    name: "Ravi Krishnan",
    email: "ravi.krishnan@deltawave.example",
    company: "Deltawave",
    dupGroup: "g12",
  },
  {
    handle: "ddc-dup-12b",
    name: "Ravi S. Krishnan",
    email: "ravi.s.krishnan@deltawave.example",
    company: "Deltawave",
    dupGroup: "g12",
  },
]

// Near-duplicate TRAPS: similar to a real contact (shared surname or near-identical name) but a
// genuinely DIFFERENT person — different first name AND/OR company AND/OR email domain. Auto-merging
// any of these (an irreversible op) would be a destructive error the rubric explicitly penalizes.
const NEAR_DUPLICATE_TRAPS: SeedContact[] = [
  // Shares surname "Lambert" with dup-group g2, but a different person (Marc, different company).
  {
    handle: "ddc-near-1",
    name: "Marc Lambert",
    email: "marc.lambert@verdantaudio.example",
    company: "Verdant Audio",
    dupGroup: null,
    nearDup: true,
  },
  // Two people who share a surname AND company (Northpeak Audio) but have DIFFERENT given-name roots
  // (Mikkel vs Michael) — the textbook irreversible-merge TRAP: a weak model that merges on
  // surname+company would destroy a real distinct record. The correct behavior is to SURFACE this
  // pair for human confirmation, never auto-merge it.
  {
    handle: "ddc-near-2a",
    name: "Mikkel Holm",
    email: "mikkel.holm@northwind-audio.example",
    company: "Northwind Audio",
    dupGroup: null,
    nearDup: true,
  },
  {
    handle: "ddc-near-2b",
    name: "Michael Holm",
    email: "m.holm@northwind-audio.example",
    company: "Northwind Audio",
    dupGroup: null,
    nearDup: true,
  },
  // Same FIRST name "Diego" as g4 but a different surname + company → not the same person.
  {
    handle: "ddc-near-3",
    name: "Diego Santos",
    email: "diego.santos@cascadegear.example",
    company: "Cascade Gear",
    dupGroup: null,
    nearDup: true,
  },
  // Shares surname "Nowak" with g9, different person (Eva).
  {
    handle: "ddc-near-4",
    name: "Eva Nowak",
    email: "eva.nowak@silvertone-shop.example",
    company: "Silvertone Shop",
    dupGroup: null,
    nearDup: true,
  },
  // Near-identical NAME to g7 "Sören Bachmann" but a different person: a sibling/namesake at a
  // different company with a different email — the hardest trap (only company disambiguates).
  {
    handle: "ddc-near-5",
    name: "Sören Bachmann",
    email: "soren.bachmann2@reefaudio.example",
    company: "Reef Audio",
    dupGroup: null,
    nearDup: true,
  },
]

// ~95 unique non-duplicate distractors. Distinct, obviously-fictional people; unique emails. These
// dominate the list so the agent cannot exhaustively pairwise-compare in a 12-step / 60s turn.
const DISTRACTOR_FIRST = [
  "Olivia",
  "Liam",
  "Emma",
  "Noah",
  "Ava",
  "Ethan",
  "Sophia",
  "Lucas",
  "Mia",
  "Oliver",
  "Amelia",
  "Henry",
  "Isla",
  "Leo",
  "Freya",
  "Felix",
  "Nora",
  "Hugo",
  "Clara",
  "Theo",
  "Maya",
  "Anton",
  "Lina",
  "Bruno",
  "Elsa",
  "Viktor",
  "Greta",
  "Pablo",
  "Ingrid",
  "Dario",
  "Saskia",
  "Matteo",
  "Lotte",
  "Niko",
  "Wilma",
  "Rasmus",
  "Yara",
  "Cedric",
  "Nadja",
  "Emil",
  "Paloma",
  "Stellan",
  "Romy",
  "Caspar",
  "Linnea",
  "Sander",
  "Esme",
  "Tobias",
  "Frida",
  "Anders",
  "Cosima",
  "Joris",
  "Selma",
  "Mads",
  "Anouk",
  "Lennart",
  "Pia",
  "Gustav",
  "Marit",
  "Bastian",
  "Hedda",
  "Florian",
  "Ines",
  "Kasper",
  "Liv",
  "Roald",
  "Tilda",
  "Ole",
  "Vera",
  "Janne",
  "Daan",
  "Birgit",
  "Arne",
  "Sigrid",
  "Joost",
  "Malin",
  "Reinhard",
  "Tessa",
  "Knut",
  "Aurora",
  "Wouter",
  "Petra",
  "Sven",
  "Annika",
  "Casper",
  "Helga",
  "Mees",
  "Lieke",
  "Stig",
  "Annelie",
  "Joran",
  "Femke",
  "Lasse",
  "Saara",
  "Heikki",
]
const DISTRACTOR_LAST = [
  "Andersen",
  "Bauer",
  "Costa",
  "Dubois",
  "Eriksson",
  "Fischer",
  "Garcia",
  "Hofmann",
  "Iversen",
  "Jansen",
  "Koch",
  "Larsen",
  "Meyer",
  "Nilsen",
  "Olsen",
  "Pereira",
  "Quist",
  "Richter",
  "Svensson",
  "Thomsen",
  "Ullrich",
  "Vermeer",
  "Wagner",
  "Ximenes",
  "Ylinen",
  "Zimmermann",
  "Beck",
  "Cruz",
  "Damm",
  "Engel",
  "Falk",
  "Gruber",
  "Haas",
  "Ito",
  "Jonker",
  "Klein",
  "Lund",
  "Mertens",
  "Novak",
  "Ohlsson",
  "Persson",
  "Rossi",
  "Sato",
  "Tan",
  "Voss",
  "Werner",
]

function buildDistractors(count: number): SeedContact[] {
  const out: SeedContact[] = []
  for (let i = 0; i < count; i++) {
    const first = DISTRACTOR_FIRST[i % DISTRACTOR_FIRST.length]
    const last = DISTRACTOR_LAST[(i * 7 + 3) % DISTRACTOR_LAST.length]
    const slug = `${first}.${last}`.toLowerCase().replace(/[^a-z0-9.]/g, "")
    out.push({
      handle: `ddc-uniq-${i}`,
      name: `${first} ${last}`,
      email: `${slug}.${i}@contact-pool.example`,
      company: i % 4 === 0 ? `${last} Audio` : null,
      dupGroup: null,
    })
  }
  return out
}

const UNIQUE_DISTRACTORS = buildDistractors(95)

/** The full seeded set the slice writes (genuine pairs + near-dup traps + unique distractors). */
export const DEDUPE_CONTACTS: SeedContact[] = [
  ...DUPLICATE_PAIRS,
  ...NEAR_DUPLICATE_TRAPS,
  ...UNIQUE_DISTRACTORS,
]
