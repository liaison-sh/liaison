// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Country names for the document face, as a static table. Templates run in the QuickJS sandbox,
// which has no `Intl`, so `Intl.DisplayNames` cannot name a country. Each entry is the country's
// name in English, French and German (the three face languages), then other spellings an address
// may already end with (the country's own name, common variants), used only to recognise a
// country line that is already there. A code the table does not list prints as the code.

const NAMES: Record<string, [string, string, string, ...string[]]> = {
  AD: ["Andorra", "Andorre", "Andorra"],
  AE: ["United Arab Emirates", "Émirats arabes unis", "Vereinigte Arabische Emirate", "UAE"],
  AR: ["Argentina", "Argentine", "Argentinien"],
  AT: ["Austria", "Autriche", "Österreich", "Oesterreich"],
  AU: ["Australia", "Australie", "Australien"],
  BE: ["Belgium", "Belgique", "Belgien", "België", "Belgie"],
  BG: ["Bulgaria", "Bulgarie", "Bulgarien"],
  BL: ["Saint Barthélemy", "Saint-Barthélemy", "Saint-Barthélemy"],
  BR: ["Brazil", "Brésil", "Brasilien", "Brasil"],
  CA: ["Canada", "Canada", "Kanada"],
  CH: ["Switzerland", "Suisse", "Schweiz", "Svizzera", "Svizra"],
  CL: ["Chile", "Chili", "Chile"],
  CN: ["China", "Chine", "China"],
  CO: ["Colombia", "Colombie", "Kolumbien"],
  CY: ["Cyprus", "Chypre", "Zypern"],
  CZ: ["Czechia", "Tchéquie", "Tschechien", "Czech Republic", "République tchèque", "Česko"],
  DE: ["Germany", "Allemagne", "Deutschland"],
  DK: ["Denmark", "Danemark", "Dänemark", "Danmark"],
  DZ: ["Algeria", "Algérie", "Algerien"],
  EE: ["Estonia", "Estonie", "Estland", "Eesti"],
  EG: ["Egypt", "Égypte", "Ägypten"],
  ES: ["Spain", "Espagne", "Spanien", "España"],
  FI: ["Finland", "Finlande", "Finnland", "Suomi"],
  FR: ["France", "France", "Frankreich"],
  GB: ["United Kingdom", "Royaume-Uni", "Vereinigtes Königreich", "UK", "Great Britain", "England"],
  GF: ["French Guiana", "Guyane", "Französisch-Guayana", "Guyane française"],
  GP: ["Guadeloupe", "Guadeloupe", "Guadeloupe"],
  GR: ["Greece", "Grèce", "Griechenland", "Ellada", "Hellas"],
  HK: ["Hong Kong", "Hong Kong", "Hongkong"],
  HR: ["Croatia", "Croatie", "Kroatien", "Hrvatska"],
  HU: ["Hungary", "Hongrie", "Ungarn", "Magyarország"],
  ID: ["Indonesia", "Indonésie", "Indonesien"],
  IE: ["Ireland", "Irlande", "Irland", "Éire"],
  IL: ["Israel", "Israël", "Israel"],
  IN: ["India", "Inde", "Indien"],
  IS: ["Iceland", "Islande", "Island", "Ísland"],
  IT: ["Italy", "Italie", "Italien", "Italia"],
  JP: ["Japan", "Japon", "Japan"],
  KR: ["South Korea", "Corée du Sud", "Südkorea", "Korea", "Republic of Korea"],
  LI: ["Liechtenstein", "Liechtenstein", "Liechtenstein"],
  LT: ["Lithuania", "Lituanie", "Litauen", "Lietuva"],
  LU: ["Luxembourg", "Luxembourg", "Luxemburg"],
  LV: ["Latvia", "Lettonie", "Lettland", "Latvija"],
  MA: ["Morocco", "Maroc", "Marokko"],
  MC: ["Monaco", "Monaco", "Monaco"],
  MF: ["Saint Martin", "Saint-Martin", "Saint-Martin"],
  MQ: ["Martinique", "Martinique", "Martinique"],
  MT: ["Malta", "Malte", "Malta"],
  MX: ["Mexico", "Mexique", "Mexiko", "México"],
  MY: ["Malaysia", "Malaisie", "Malaysia"],
  NC: ["New Caledonia", "Nouvelle-Calédonie", "Neukaledonien"],
  NL: ["Netherlands", "Pays-Bas", "Niederlande", "The Netherlands", "Nederland", "Holland"],
  NO: ["Norway", "Norvège", "Norwegen", "Norge"],
  NZ: ["New Zealand", "Nouvelle-Zélande", "Neuseeland"],
  PE: ["Peru", "Pérou", "Peru"],
  PF: ["French Polynesia", "Polynésie française", "Französisch-Polynesien"],
  PH: ["Philippines", "Philippines", "Philippinen"],
  PL: ["Poland", "Pologne", "Polen", "Polska"],
  PM: ["Saint Pierre and Miquelon", "Saint-Pierre-et-Miquelon", "Saint-Pierre und Miquelon"],
  PR: ["Puerto Rico", "Porto Rico", "Puerto Rico"],
  PT: ["Portugal", "Portugal", "Portugal"],
  RE: ["Réunion", "La Réunion", "Réunion", "Reunion", "La Reunion"],
  RO: ["Romania", "Roumanie", "Rumänien", "România"],
  RS: ["Serbia", "Serbie", "Serbien", "Srbija"],
  SA: ["Saudi Arabia", "Arabie saoudite", "Saudi-Arabien"],
  SE: ["Sweden", "Suède", "Schweden", "Sverige"],
  SG: ["Singapore", "Singapour", "Singapur"],
  SI: ["Slovenia", "Slovénie", "Slowenien", "Slovenija"],
  SK: ["Slovakia", "Slovaquie", "Slowakei", "Slovensko"],
  SM: ["San Marino", "Saint-Marin", "San Marino"],
  TH: ["Thailand", "Thaïlande", "Thailand"],
  TN: ["Tunisia", "Tunisie", "Tunesien"],
  TR: ["Türkiye", "Turquie", "Türkei", "Turkey"],
  TW: ["Taiwan", "Taïwan", "Taiwan"],
  UA: ["Ukraine", "Ukraine", "Ukraine"],
  US: ["United States", "États-Unis", "Vereinigte Staaten", "USA", "United States of America"],
  VA: ["Vatican City", "Vatican", "Vatikanstadt"],
  VN: ["Vietnam", "Viêt Nam", "Vietnam", "Viet Nam"],
  WF: ["Wallis and Futuna", "Wallis-et-Futuna", "Wallis und Futuna"],
  YT: ["Mayotte", "Mayotte", "Mayotte"],
  ZA: ["South Africa", "Afrique du Sud", "Südafrika"],
}

const LANG_INDEX = { en: 0, fr: 1, de: 2 } as const

/** Lower case, diacritics and punctuation dropped: "États-Unis" and "etats unis" compare equal. */
function key(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "")
}

const BY_KEY: Map<string, string> = (() => {
  const map = new Map<string, string>()
  for (const [iso, names] of Object.entries(NAMES)) {
    for (const name of names) {
      const k = key(name)
      if (k !== "" && !map.has(k)) map.set(k, iso)
    }
  }
  return map
})()

/** The ISO 3166-1 alpha-2 code a text stands for: a code the table lists ("FR"), or one of its
 *  names ("France", "Allemagne", "USA"). Null for anything else, a locality line included. */
export function countryCodeOf(text: string | null | undefined): string | null {
  const t = (text ?? "").trim()
  if (t === "" || /\d/.test(t)) return null
  if (/^[A-Za-z]{2}$/.test(t)) {
    const code = t.toUpperCase()
    return NAMES[code] ? code : null
  }
  return BY_KEY.get(key(t)) ?? null
}

/** The country's name in the face language ("FR" -> "France", "DE" in fr -> "Allemagne"); a code
 *  the table does not list prints as given. */
export function countryName(code: string, lang: "en" | "fr" | "de"): string {
  const c = code.trim().toUpperCase()
  return NAMES[c]?.[LANG_INDEX[lang]] ?? code.trim()
}
