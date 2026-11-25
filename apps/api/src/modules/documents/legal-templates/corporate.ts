// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The three corporate starters: minutes of a general meeting, a written
// consultation of the partners, and a power of attorney. They wait on a
// lawyer's answer about the signature level these acts need, so they are
// offered only when the agreements app's `corporateTemplates` feature is on
// (off by default). Starting points to review with a lawyer, like the others.

import { PROOF_CLAUSE, type StarterLang } from "./common"

export type CorporateStarterKey =
  | "general_meeting_minutes"
  | "written_consultation"
  | "power_of_attorney"

const proof = (lang: StarterLang) => ({
  type: "article",
  id: PROOF_CLAUSE[lang].id,
  level: 1,
  heading: PROOF_CLAUSE[lang].heading,
  text: PROOF_CLAUSE[lang].text,
})

const article = (id: string, heading: string, text: string) => ({
  type: "article",
  id,
  level: 1,
  heading,
  text,
})

const page = (lang: StarterLang, shortTitle: string) => ({
  layout: "legal",
  lang,
  shortTitle,
})

function minutes(lang: StarterLang): Record<string, unknown> {
  const fr = lang === "fr"
  return {
    page: page(lang, fr ? "Procès-verbal d'assemblée générale" : "Minutes of the general meeting"),
    blocks: [
      {
        type: "paragraph",
        text: fr
          ? "{{company.name}}, {{company.form}} au capital de {{company.capital}}, dont le siège social est situé {{company.seat}}, immatriculée au registre du commerce et des sociétés de {{company.rcs_city}} sous le numéro {{company.rcs_number}}."
          : "{{company.name}}, a {{company.form}} with a share capital of {{company.capital}}, whose registered office is at {{company.seat}}, registered with the Trade and Companies Register of {{company.rcs_city}} under number {{company.rcs_number}}.",
      },
      {
        type: "paragraph",
        text: fr
          ? "Le {{meeting.date}}, les associés se sont réunis en assemblée générale {{meeting.kind}} à {{meeting.place}}, sur convocation de {{meeting.convened_by}}. L'assemblée est présidée par {{meeting.chair}}. Les associés présents ou représentés détiennent {{meeting.quorum}} des parts ; l'assemblée peut donc valablement délibérer."
          : "On {{meeting.date}}, the partners met in {{meeting.kind}} general meeting at {{meeting.place}}, convened by {{meeting.convened_by}}. The meeting is chaired by {{meeting.chair}}. The partners present or represented hold {{meeting.quorum}} of the shares; the meeting may therefore validly deliberate.",
      },
      {
        type: "heading",
        level: 2,
        text: fr ? "Ordre du jour" : "Agenda",
      },
      { type: "paragraph", text: "{{meeting.agenda}}" },
      article(
        "resolution_one",
        fr ? "Première résolution" : "First resolution",
        fr
          ? "{{resolutions.first}} Cette résolution est adoptée par {{resolutions.first_vote}}."
          : "{{resolutions.first}} This resolution is adopted by {{resolutions.first_vote}}.",
      ),
      article(
        "resolution_two",
        fr ? "Deuxième résolution" : "Second resolution",
        fr
          ? "L'assemblée confère tous pouvoirs au porteur d'une copie du présent procès-verbal pour accomplir les formalités. Cette résolution est adoptée par {{resolutions.second_vote}}."
          : "The meeting gives every power to the bearer of a copy of these minutes to complete the formalities. This resolution is adopted by {{resolutions.second_vote}}.",
      ),
      proof(lang),
      {
        type: "signature_block",
        place: "{{signature.place}}",
        lines: [
          {
            party: fr ? "Le président de séance" : "The chair of the meeting",
            name: "{{meeting.chair}}",
            capacity: fr ? "président de séance" : "chair",
          },
          {
            party: fr ? "Le secrétaire" : "The secretary",
            name: "{{meeting.secretary}}",
            capacity: fr ? "secrétaire" : "secretary",
          },
        ],
      },
    ],
  }
}

function consultation(lang: StarterLang): Record<string, unknown> {
  const fr = lang === "fr"
  return {
    page: page(
      lang,
      fr ? "Consultation écrite des associés" : "Written consultation of the partners",
    ),
    blocks: [
      {
        type: "paragraph",
        text: fr
          ? "{{company.name}}, {{company.form}} au capital de {{company.capital}}, dont le siège social est situé {{company.seat}}, immatriculée au registre du commerce et des sociétés de {{company.rcs_city}} sous le numéro {{company.rcs_number}}."
          : "{{company.name}}, a {{company.form}} with a share capital of {{company.capital}}, whose registered office is at {{company.seat}}, registered with the Trade and Companies Register of {{company.rcs_city}} under number {{company.rcs_number}}.",
      },
      {
        type: "paragraph",
        text: fr
          ? "Par consultation écrite adressée le {{consultation.sent_on}}, {{consultation.sent_by}} a soumis aux associés le texte des résolutions ci-dessous. Chaque associé disposait d'un délai de {{consultation.days}} jours pour voter."
          : "By a written consultation sent on {{consultation.sent_on}}, {{consultation.sent_by}} submitted to the partners the text of the resolutions below. Each partner had {{consultation.days}} days to vote.",
      },
      article(
        "resolution_one",
        fr ? "Résolution soumise au vote" : "Resolution put to the vote",
        fr
          ? "{{resolutions.first}} Cette résolution est adoptée par {{resolutions.first_vote}}."
          : "{{resolutions.first}} This resolution is adopted by {{resolutions.first_vote}}.",
      ),
      article(
        "formalities",
        fr ? "Formalités" : "Formalities",
        fr
          ? "Tous pouvoirs sont conférés au porteur d'une copie du présent acte pour accomplir les formalités."
          : "Every power is given to the bearer of a copy of this record to complete the formalities.",
      ),
      proof(lang),
      {
        type: "signature_block",
        place: "{{signature.place}}",
        lines: [
          {
            party: "{{company.name}}",
            name: "{{company.represented_by}}",
            capacity: "{{company.capacity}}",
          },
        ],
      },
    ],
  }
}

function power(lang: StarterLang): Record<string, unknown> {
  const fr = lang === "fr"
  return {
    page: page(lang, fr ? "Pouvoir" : "Power of attorney"),
    blocks: [
      {
        type: "parties",
        lead: fr ? "Le soussigné :" : "The undersigned:",
        groups: [
          {
            items: [
              {
                kind: "person",
                name: "{{grantor.name}}",
                seat: "{{grantor.address}}",
                defined_as: fr ? "le Mandant" : "the Principal",
              },
            ],
          },
          {
            items: [
              {
                kind: "person",
                name: "{{attorney.name}}",
                seat: "{{attorney.address}}",
                defined_as: fr ? "le Mandataire" : "the Attorney",
              },
            ],
          },
        ],
      },
      article(
        "object",
        fr ? "Objet du pouvoir" : "Purpose of the power",
        fr
          ? "Le Mandant donne pouvoir au Mandataire de, en son nom et pour son compte : {{power.object}}."
          : "The Principal gives the Attorney power to, in the Principal's name and on the Principal's behalf: {{power.object}}.",
      ),
      article(
        "duration",
        fr ? "Durée" : "Duration",
        fr
          ? "Le présent pouvoir vaut jusqu'au {{power.until}} et peut être révoqué à tout moment par le Mandant."
          : "This power is valid until {{power.until}} and may be revoked at any time by the Principal.",
      ),
      proof(lang),
      {
        type: "signature_block",
        place: "{{signature.place}}",
        lines: [
          {
            party: fr ? "Le Mandant" : "The Principal",
            name: "{{grantor.name}}",
            capacity: fr ? "mandant" : "principal",
          },
        ],
      },
    ],
  }
}

export const CORPORATE_STARTERS: Record<
  CorporateStarterKey,
  { title: Record<StarterLang, string>; body: (lang: StarterLang) => Record<string, unknown> }
> = {
  general_meeting_minutes: {
    title: { fr: "Procès-verbal d'assemblée générale", en: "Minutes of a general meeting" },
    body: minutes,
  },
  written_consultation: {
    title: { fr: "Consultation écrite des associés", en: "Written consultation of the partners" },
    body: consultation,
  },
  power_of_attorney: {
    title: { fr: "Pouvoir", en: "Power of attorney" },
    body: power,
  },
}
