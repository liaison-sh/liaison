// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seven services starters (statement of work, master agreement, mutual
// NDA, retainer, time and materials, data processing addendum, change
// request), each in English and French. Starting points to review with a
// lawyer: plain, balanced clauses a firm adapts to its own practice.

import type { StarterContent, StarterLang } from "./common"

export type ServicesStarterKey =
  | "sow"
  | "master_agreement"
  | "mutual_nda"
  | "retainer"
  | "time_and_materials"
  | "data_processing_addendum"
  | "change_request"

/** The agreement kind a starter is for, as the agreements app names it. */
export const SERVICES_STARTER_KIND: Record<ServicesStarterKey, string> = {
  sow: "sow",
  master_agreement: "msa",
  mutual_nda: "nda",
  retainer: "retainer",
  time_and_materials: "tm",
  data_processing_addendum: "dpa",
  change_request: "change_request",
}

const confidentialityEn = {
  id: "confidentiality",
  heading: "Confidentiality",
  text: "Each party keeps confidential the information the other party discloses under this contract and uses it only to perform it. This obligation lasts for the term of the contract and three years after its end.",
}
const confidentialityFr = {
  id: "confidentiality",
  heading: "Confidentialité",
  text: "Chaque partie garde confidentielles les informations que l'autre partie lui communique au titre du présent contrat et ne les utilise que pour son exécution. Cette obligation dure pendant toute la durée du contrat et trois ans après sa fin.",
}
const lawEn = {
  id: "law",
  heading: "Governing law and disputes",
  text: "This contract is governed by {{contract.governing_law}}. The parties first seek an amicable settlement of any dispute; failing that within thirty days, the dispute goes to the courts of {{contract.court}}.",
}
const lawFr = {
  id: "law",
  heading: "Droit applicable et litiges",
  text: "Le présent contrat est soumis au {{contract.governing_law}}. Les parties recherchent d'abord une solution amiable à tout litige ; à défaut dans un délai de trente jours, le litige est porté devant les tribunaux de {{contract.court}}.",
}

export const SERVICES_STARTERS: Record<ServicesStarterKey, Record<StarterLang, StarterContent>> = {
  sow: {
    en: {
      title: "Statement of work",
      recitals: [
        "The Client wishes to entrust the Provider with the project {{project.name}}.",
        "The Provider has the skills the project needs and accepts it on the terms below.",
      ],
      clauses: [
        {
          id: "scope",
          heading: "Scope",
          text: "The Provider delivers the work described in {{ref:deliverables}}. Any work outside it is agreed in a change request signed by both parties.",
        },
        {
          id: "schedule",
          heading: "Schedule",
          text: "The work starts on {{project.start_date}} and the deliverables are due on {{project.end_date}}, provided the Client supplies on time the information and access the work needs.",
        },
        {
          id: "acceptance",
          heading: "Acceptance",
          text: "The Client checks each deliverable within ten working days of its delivery and either accepts it or lists in writing the points that do not meet {{ref:deliverables}}. A deliverable on which the Client says nothing within that period is accepted.",
        },
        {
          id: "price",
          heading: "Price and payment",
          text: "The price of the work is {{fees.total}} excluding taxes, invoiced as follows:",
          subs: [
            { level: 4, text: "{{fees.deposit_share}} on signature;" },
            { level: 4, text: "the balance on acceptance of the last deliverable." },
            {
              text: "Invoices are payable within thirty days of their date. A late payment bears the interest and the fixed recovery fee the law provides.",
            },
          ],
        },
        {
          id: "ip",
          heading: "Intellectual property",
          text: "On full payment of the price, the Provider assigns to the Client the rights in the deliverables the Client needs to use them. The Provider keeps its tools, methods and know-how.",
        },
        confidentialityEn,
        lawEn,
      ],
      annex: {
        id: "deliverables",
        title: "Deliverables",
        paragraphs: ["{{project.deliverables}}"],
      },
    },
    fr: {
      title: "Bon de commande de prestations",
      recitals: [
        "Le Client souhaite confier au Prestataire le projet {{project.name}}.",
        "Le Prestataire dispose des compétences que le projet requiert et l'accepte aux conditions ci-dessous.",
      ],
      clauses: [
        {
          id: "scope",
          heading: "Objet",
          text: "Le Prestataire réalise les prestations décrites à l'{{ref:deliverables}}. Toute prestation qui n'y figure pas fait l'objet d'une demande de modification signée par les deux parties.",
        },
        {
          id: "schedule",
          heading: "Calendrier",
          text: "Les prestations débutent le {{project.start_date}} et les livrables sont remis au plus tard le {{project.end_date}}, sous réserve que le Client fournisse à temps les informations et accès nécessaires.",
        },
        {
          id: "acceptance",
          heading: "Recette",
          text: "Le Client vérifie chaque livrable dans les dix jours ouvrés de sa remise et soit le réceptionne, soit liste par écrit les points non conformes à l'{{ref:deliverables}}. Un livrable sur lequel le Client ne se prononce pas dans ce délai est réputé réceptionné.",
        },
        {
          id: "price",
          heading: "Prix et paiement",
          text: "Le prix des prestations est de {{fees.total}} hors taxes, facturé comme suit :",
          subs: [
            { level: 4, text: "{{fees.deposit_share}} à la signature ;" },
            { level: 4, text: "le solde à la réception du dernier livrable." },
            {
              text: "Les factures sont payables à trente jours de leur date. Tout retard de paiement entraîne les pénalités et l'indemnité forfaitaire de recouvrement prévues par la loi.",
            },
          ],
        },
        {
          id: "ip",
          heading: "Propriété intellectuelle",
          text: "Au complet paiement du prix, le Prestataire cède au Client les droits sur les livrables nécessaires à leur utilisation. Le Prestataire conserve ses outils, méthodes et savoir-faire.",
        },
        confidentialityFr,
        lawFr,
      ],
      annex: {
        id: "deliverables",
        title: "Livrables",
        paragraphs: ["{{project.deliverables}}"],
      },
    },
  },

  master_agreement: {
    en: {
      title: "Master services agreement",
      recitals: [
        "The Provider offers design and development services.",
        "The parties wish to set once the terms that will apply to every order the Client places.",
      ],
      clauses: [
        {
          id: "purpose",
          heading: "Purpose",
          text: "This agreement sets the terms of every statement of work the parties sign during its term. A statement of work describes the work, its schedule and its price; where it departs from this agreement, the statement of work prevails for that work only.",
        },
        {
          id: "term",
          heading: "Term",
          text: "This agreement starts on {{contract.start_date}} for one year and renews for successive one-year periods unless a party ends it by registered letter or email with three months' notice. Statements of work in progress continue until their end.",
        },
        {
          id: "obligations",
          heading: "Obligations of the parties",
          text: "The Provider performs the work with care and in line with the practice of its trade. The Client supplies on time the information, access and decisions the work needs, and names one contact person.",
        },
        {
          id: "fees",
          heading: "Fees and invoicing",
          text: "Each statement of work sets its price. Invoices are payable within thirty days of their date; a late payment bears the interest and the fixed recovery fee the law provides.",
        },
        {
          id: "liability",
          heading: "Liability",
          text: "Each party is liable for the direct damage it causes. The Provider's total liability under a statement of work is limited to the price paid under it, except for gross negligence or wilful misconduct.",
        },
        confidentialityEn,
        {
          id: "termination",
          heading: "Termination for breach",
          text: "If a party fails a material obligation and does not remedy it within thirty days of a formal notice, the other party may end this agreement and the statements of work concerned.",
        },
        lawEn,
      ],
    },
    fr: {
      title: "Contrat-cadre de prestations de services",
      recitals: [
        "Le Prestataire propose des prestations de conception et de développement.",
        "Les parties souhaitent fixer une fois pour toutes les conditions applicables à chaque commande du Client.",
      ],
      clauses: [
        {
          id: "purpose",
          heading: "Objet",
          text: "Le présent contrat fixe les conditions de chaque bon de commande signé par les parties pendant sa durée. Un bon de commande décrit les prestations, leur calendrier et leur prix ; lorsqu'il déroge au présent contrat, il prévaut pour ces seules prestations.",
        },
        {
          id: "term",
          heading: "Durée",
          text: "Le présent contrat prend effet le {{contract.start_date}} pour un an et se renouvelle par périodes successives d'un an, sauf dénonciation par lettre recommandée ou email moyennant un préavis de trois mois. Les bons de commande en cours se poursuivent jusqu'à leur terme.",
        },
        {
          id: "obligations",
          heading: "Obligations des parties",
          text: "Le Prestataire exécute les prestations avec soin et conformément aux usages de sa profession. Le Client fournit à temps les informations, accès et décisions nécessaires, et désigne un interlocuteur unique.",
        },
        {
          id: "fees",
          heading: "Prix et facturation",
          text: "Chaque bon de commande fixe son prix. Les factures sont payables à trente jours de leur date ; tout retard entraîne les pénalités et l'indemnité forfaitaire de recouvrement prévues par la loi.",
        },
        {
          id: "liability",
          heading: "Responsabilité",
          text: "Chaque partie répond des dommages directs qu'elle cause. La responsabilité totale du Prestataire au titre d'un bon de commande est limitée au prix payé au titre de celui-ci, sauf faute lourde ou dolosive.",
        },
        confidentialityFr,
        {
          id: "termination",
          heading: "Résiliation pour manquement",
          text: "Si une partie manque à une obligation essentielle et n'y remédie pas dans les trente jours d'une mise en demeure, l'autre partie peut résilier le présent contrat et les bons de commande concernés.",
        },
        lawFr,
      ],
    },
  },

  mutual_nda: {
    en: {
      title: "Mutual non-disclosure agreement",
      confidential: true,
      recitals: [
        "The parties are discussing a possible collaboration about {{project.name}}.",
        "For these discussions each will disclose confidential information to the other.",
      ],
      clauses: [
        {
          id: "definition",
          heading: "Confidential information",
          text: "Confidential information means any information a party discloses to the other in connection with the discussions, in any form, except information that is public through no fault of the receiving party, that it already held lawfully, or that it develops on its own.",
        },
        {
          id: "duties",
          heading: "Obligations",
          text: "The receiving party:",
          subs: [
            { level: 4, text: "uses the confidential information only for the discussions;" },
            {
              level: 4,
              text: "discloses it only to its staff and advisers who need it and are bound by the same duty;",
            },
            {
              level: 4,
              text: "protects it with at least the care it gives its own confidential information.",
            },
          ],
        },
        {
          id: "return",
          heading: "Return of information",
          text: "At the end of the discussions, or at the request of the disclosing party, the receiving party returns or destroys the confidential information it holds.",
        },
        {
          id: "duration",
          heading: "Duration",
          text: "The obligations of {{ref:duties}} last for {{contract.nda_years}} years from the signature of this agreement.",
        },
        {
          id: "no_licence",
          heading: "No other commitment",
          text: "This agreement grants no licence and does not oblige either party to enter into any further contract.",
        },
        lawEn,
      ],
    },
    fr: {
      title: "Accord de confidentialité réciproque",
      confidential: true,
      recitals: [
        "Les parties envisagent une collaboration au sujet de {{project.name}}.",
        "Pour ces échanges, chacune communiquera à l'autre des informations confidentielles.",
      ],
      clauses: [
        {
          id: "definition",
          heading: "Informations confidentielles",
          text: "Sont confidentielles toutes les informations qu'une partie communique à l'autre dans le cadre des échanges, sous quelque forme que ce soit, à l'exception de celles qui sont publiques sans faute de la partie qui les reçoit, qu'elle détenait déjà légitimement ou qu'elle développe seule.",
        },
        {
          id: "duties",
          heading: "Obligations",
          text: "La partie qui reçoit les informations :",
          subs: [
            { level: 4, text: "ne les utilise que pour les échanges ;" },
            {
              level: 4,
              text: "ne les communique qu'à ceux de ses salariés et conseils qui en ont besoin et sont tenus à la même obligation ;",
            },
            {
              level: 4,
              text: "les protège avec au moins le soin qu'elle apporte à ses propres informations confidentielles.",
            },
          ],
        },
        {
          id: "return",
          heading: "Restitution",
          text: "À la fin des échanges, ou à la demande de la partie qui les a communiquées, la partie qui les a reçues restitue ou détruit les informations confidentielles qu'elle détient.",
        },
        {
          id: "duration",
          heading: "Durée",
          text: "Les obligations de l'{{ref:duties}} durent {{contract.nda_years}} ans à compter de la signature du présent accord.",
        },
        {
          id: "no_licence",
          heading: "Absence d'autre engagement",
          text: "Le présent accord ne concède aucune licence et n'oblige aucune partie à conclure un autre contrat.",
        },
        lawFr,
      ],
    },
  },

  retainer: {
    en: {
      title: "Retainer agreement",
      clauses: [
        {
          id: "purpose",
          heading: "Purpose",
          text: "The Provider keeps available for the Client a monthly volume of {{retainer.hours}} hours of work in the field of {{retainer.field}}.",
        },
        {
          id: "fee",
          heading: "Monthly fee",
          text: "The Client pays a monthly fee of {{retainer.monthly_fee}} excluding taxes, invoiced at the start of each month and payable within thirty days.",
        },
        {
          id: "use",
          heading: "Use of the hours",
          text: "Hours not used in a month carry over to the next month only, then lapse. Work beyond the monthly volume is agreed beforehand and invoiced at {{retainer.extra_rate}} per hour.",
        },
        {
          id: "report",
          heading: "Monthly report",
          text: "Each month the Provider sends the Client a short report of the work done and the total hours used.",
        },
        {
          id: "term",
          heading: "Term",
          text: "This agreement starts on {{contract.start_date}} for {{contract.term_months}} months and renews month by month unless a party ends it with one month's notice.",
        },
        confidentialityEn,
        lawEn,
      ],
    },
    fr: {
      title: "Contrat d'abonnement de prestations",
      clauses: [
        {
          id: "purpose",
          heading: "Objet",
          text: "Le Prestataire tient à la disposition du Client un volume mensuel de {{retainer.hours}} heures de travail dans le domaine suivant : {{retainer.field}}.",
        },
        {
          id: "fee",
          heading: "Redevance mensuelle",
          text: "Le Client verse une redevance mensuelle de {{retainer.monthly_fee}} hors taxes, facturée en début de mois et payable à trente jours.",
        },
        {
          id: "use",
          heading: "Utilisation des heures",
          text: "Les heures non utilisées dans le mois se reportent sur le seul mois suivant, puis sont perdues. Le travail au-delà du volume mensuel est convenu au préalable et facturé {{retainer.extra_rate}} de l'heure.",
        },
        {
          id: "report",
          heading: "Compte rendu mensuel",
          text: "Chaque mois, le Prestataire adresse au Client un bref compte rendu des travaux réalisés et du total des heures utilisées.",
        },
        {
          id: "term",
          heading: "Durée",
          text: "Le présent contrat prend effet le {{contract.start_date}} pour {{contract.term_months}} mois et se renouvelle de mois en mois, sauf dénonciation par une partie moyennant un préavis d'un mois.",
        },
        confidentialityFr,
        lawFr,
      ],
    },
  },

  time_and_materials: {
    en: {
      title: "Time and materials agreement",
      clauses: [
        {
          id: "purpose",
          heading: "Purpose",
          text: "The Provider performs for the Client the work described in {{project.name}}, billed on the time actually spent and the costs actually incurred.",
        },
        {
          id: "rates",
          heading: "Rates",
          text: "Time is billed at {{fees.daily_rate}} per day excluding taxes. Costs agreed beforehand by the Client are billed at cost.",
        },
        {
          id: "estimate",
          heading: "Estimate",
          text: "The Provider's estimate is {{fees.estimate}}. It is not a fixed price; the Provider tells the Client as soon as it expects to exceed it, and does not exceed it by more than ten per cent without the Client's written agreement.",
        },
        {
          id: "invoicing",
          heading: "Invoicing",
          text: "The Provider invoices at the end of each month the time and costs of that month, with a summary of the work done. Invoices are payable within thirty days.",
        },
        {
          id: "end",
          heading: "End of the work",
          text: "Either party may stop the work with fifteen days' notice. The Client then pays the time spent and the costs incurred up to the end of the notice.",
        },
        confidentialityEn,
        lawEn,
      ],
    },
    fr: {
      title: "Contrat de prestations en régie",
      clauses: [
        {
          id: "purpose",
          heading: "Objet",
          text: "Le Prestataire réalise pour le Client les travaux du projet {{project.name}}, facturés au temps réellement passé et aux frais réellement engagés.",
        },
        {
          id: "rates",
          heading: "Tarifs",
          text: "Le temps est facturé {{fees.daily_rate}} par jour hors taxes. Les frais acceptés au préalable par le Client sont refacturés à leur coût.",
        },
        {
          id: "estimate",
          heading: "Estimation",
          text: "L'estimation du Prestataire est de {{fees.estimate}}. Elle ne constitue pas un forfait ; le Prestataire prévient le Client dès qu'il prévoit de la dépasser et ne la dépasse pas de plus de dix pour cent sans l'accord écrit du Client.",
        },
        {
          id: "invoicing",
          heading: "Facturation",
          text: "Le Prestataire facture en fin de mois le temps et les frais du mois, avec un relevé des travaux réalisés. Les factures sont payables à trente jours.",
        },
        {
          id: "end",
          heading: "Fin des travaux",
          text: "Chaque partie peut arrêter les travaux moyennant un préavis de quinze jours. Le Client paie alors le temps passé et les frais engagés jusqu'à la fin du préavis.",
        },
        confidentialityFr,
        lawFr,
      ],
    },
  },

  data_processing_addendum: {
    en: {
      title: "Data processing addendum",
      confidential: true,
      recitals: [
        "In performing the services, the Provider processes personal data on behalf of the Client.",
        "This addendum sets the terms of that processing, in line with the General Data Protection Regulation.",
      ],
      clauses: [
        {
          id: "subject",
          heading: "Subject and duration",
          text: "The Provider processes the personal data described in {{ref:processing}} only for the services and for their duration.",
        },
        {
          id: "instructions",
          heading: "Instructions",
          text: "The Provider processes the data only on the Client's documented instructions, and tells the Client at once if an instruction seems to it to break the data protection rules.",
        },
        {
          id: "security",
          heading: "Security and confidentiality",
          text: "The Provider takes appropriate technical and organisational measures to protect the data, and ensures that the persons who process it are bound by confidentiality.",
        },
        {
          id: "subprocessors",
          heading: "Sub-processors",
          text: "The Provider engages a sub-processor only with the Client's prior written authorisation and binds it to the same obligations.",
        },
        {
          id: "assistance",
          heading: "Assistance and breaches",
          text: "The Provider helps the Client answer requests from data subjects, and notifies the Client of a personal data breach without undue delay and within forty-eight hours of becoming aware of it.",
        },
        {
          id: "end",
          heading: "End of the processing",
          text: "At the end of the services, the Provider returns or deletes the data, as the Client chooses, and deletes existing copies unless the law requires keeping them.",
        },
        lawEn,
      ],
      annex: {
        id: "processing",
        title: "Description of the processing",
        paragraphs: [
          "Categories of data subjects: {{processing.subjects}}.",
          "Categories of data: {{processing.data}}.",
          "Purposes: {{processing.purposes}}.",
        ],
      },
    },
    fr: {
      title: "Accord de sous-traitance de données personnelles",
      confidential: true,
      recitals: [
        "Pour exécuter les prestations, le Prestataire traite des données personnelles pour le compte du Client.",
        "Le présent accord fixe les conditions de ce traitement, conformément au Règlement général sur la protection des données.",
      ],
      clauses: [
        {
          id: "subject",
          heading: "Objet et durée",
          text: "Le Prestataire traite les données personnelles décrites à l'{{ref:processing}} pour les seules prestations et pendant leur durée.",
        },
        {
          id: "instructions",
          heading: "Instructions",
          text: "Le Prestataire ne traite les données que sur instruction documentée du Client, et l'informe immédiatement si une instruction lui paraît contraire aux règles de protection des données.",
        },
        {
          id: "security",
          heading: "Sécurité et confidentialité",
          text: "Le Prestataire met en œuvre des mesures techniques et organisationnelles appropriées pour protéger les données, et veille à ce que les personnes qui les traitent soient tenues à la confidentialité.",
        },
        {
          id: "subprocessors",
          heading: "Sous-traitants ultérieurs",
          text: "Le Prestataire ne recourt à un sous-traitant ultérieur qu'avec l'autorisation écrite préalable du Client et lui impose les mêmes obligations.",
        },
        {
          id: "assistance",
          heading: "Assistance et violations",
          text: "Le Prestataire aide le Client à répondre aux demandes des personnes concernées, et lui notifie toute violation de données personnelles dans les meilleurs délais et au plus tard quarante-huit heures après en avoir pris connaissance.",
        },
        {
          id: "end",
          heading: "Fin du traitement",
          text: "À la fin des prestations, le Prestataire restitue ou supprime les données, au choix du Client, et en efface les copies, sauf obligation légale de conservation.",
        },
        lawFr,
      ],
      annex: {
        id: "processing",
        title: "Description du traitement",
        paragraphs: [
          "Catégories de personnes concernées : {{processing.subjects}}.",
          "Catégories de données : {{processing.data}}.",
          "Finalités : {{processing.purposes}}.",
        ],
      },
    },
  },

  change_request: {
    en: {
      title: "Change request",
      recitals: [
        "The parties signed the contract {{change.contract_reference}}.",
        "The Client asks for a change to the work it describes.",
      ],
      clauses: [
        {
          id: "change",
          heading: "The change",
          text: "The work of the contract is changed as follows: {{change.description}}.",
        },
        {
          id: "price",
          heading: "Price",
          text: "The change adds {{change.price}} excluding taxes to the price of the contract, invoiced with the next invoice the contract provides.",
        },
        {
          id: "schedule",
          heading: "Schedule",
          text: "The change moves the delivery date of the contract to {{change.new_date}}.",
        },
        {
          id: "rest",
          heading: "Other terms",
          text: "Every other term of the contract stays as it is.",
        },
      ],
    },
    fr: {
      title: "Demande de modification",
      recitals: [
        "Les parties ont signé le contrat {{change.contract_reference}}.",
        "Le Client demande une modification des prestations qu'il décrit.",
      ],
      clauses: [
        {
          id: "change",
          heading: "La modification",
          text: "Les prestations du contrat sont modifiées comme suit : {{change.description}}.",
        },
        {
          id: "price",
          heading: "Prix",
          text: "La modification ajoute {{change.price}} hors taxes au prix du contrat, facturés avec la prochaine facture prévue par le contrat.",
        },
        {
          id: "schedule",
          heading: "Calendrier",
          text: "La modification reporte la date de livraison du contrat au {{change.new_date}}.",
        },
        {
          id: "rest",
          heading: "Autres stipulations",
          text: "Toutes les autres stipulations du contrat restent inchangées.",
        },
      ],
    },
  },
}
