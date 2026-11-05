// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Country names -> ISO 3166-1 alpha-2, as a static table. The app runs in a QuickJS sandbox that
// has NO `Intl`, so `Intl.DisplayNames` cannot be used to recognise a trailing "Germany" on an
// invoice address: it threw, the throw was swallowed, and the country line was read as the city.
// Names are listed in English, French, German, Spanish, Italian, Dutch, Polish and the country's
// own language (romanised when its script is not Latin), with common variants. Lookup ignores
// case, diacritics, spaces and punctuation ("U.S.A.", "Österreich", "the Netherlands").

const NAMES: Record<string, string[]> = {
  AT: ["Austria", "Autriche", "Österreich", "Oesterreich", "Oostenrijk", "Republic of Austria"],
  BE: ["Belgium", "Belgique", "Belgien", "Bélgica", "Belgio", "België", "Belgia"],
  BG: ["Bulgaria", "Bulgarie", "Bulgarien", "Bulgarije", "Bulgariya", "Balgariya"],
  HR: ["Croatia", "Croatie", "Kroatien", "Croacia", "Croazia", "Kroatië", "Chorwacja", "Hrvatska"],
  CY: ["Cyprus", "Chypre", "Zypern", "Chipre", "Cipro", "Cypr", "Kypros", "Kibris"],
  CZ: [
    "Czechia",
    "Czech Republic",
    "The Czech Republic",
    "Tchéquie",
    "République tchèque",
    "Tschechien",
    "Tschechische Republik",
    "Chequia",
    "República Checa",
    "Cechia",
    "Repubblica Ceca",
    "Tsjechië",
    "Czechy",
    "Česko",
    "Česká republika",
  ],
  DK: ["Denmark", "Danemark", "Dänemark", "Dinamarca", "Danimarca", "Denemarken", "Dania", "Danmark"],
  EE: ["Estonia", "Estonie", "Estland", "Eesti"],
  FI: ["Finland", "Finlande", "Finnland", "Finlandia", "Suomi"],
  FR: ["France", "Frankreich", "Francia", "Frankrijk", "Francja", "République française"],
  DE: [
    "Germany",
    "Allemagne",
    "Deutschland",
    "Alemania",
    "Germania",
    "Duitsland",
    "Niemcy",
    "Federal Republic of Germany",
    "Bundesrepublik Deutschland",
    "BRD",
  ],
  GR: ["Greece", "Grèce", "Griechenland", "Grecia", "Griekenland", "Grecja", "Hellas", "Ellada", "Hellenic Republic"],
  HU: ["Hungary", "Hongrie", "Ungarn", "Hungría", "Ungheria", "Hongarije", "Węgry", "Magyarország"],
  IE: ["Ireland", "Irlande", "Irland", "Irlanda", "Ierland", "Irlandia", "Éire", "Republic of Ireland"],
  IT: ["Italy", "Italie", "Italien", "Italia", "Italië", "Włochy"],
  LV: ["Latvia", "Lettonie", "Lettland", "Letonia", "Lettonia", "Letland", "Łotwa", "Latvija"],
  LT: ["Lithuania", "Lituanie", "Litauen", "Lituania", "Litouwen", "Litwa", "Lietuva"],
  LU: ["Luxembourg", "Luxemburg", "Luxemburgo", "Lussemburgo", "Luksemburg", "Lëtzebuerg"],
  MT: ["Malta", "Malte"],
  NL: [
    "Netherlands",
    "The Netherlands",
    "Pays-Bas",
    "Niederlande",
    "Países Bajos",
    "Paesi Bassi",
    "Nederland",
    "Holandia",
    "Holland",
    "Hollande",
    "Olanda",
    "Holanda",
  ],
  PL: ["Poland", "Pologne", "Polen", "Polonia", "Polska"],
  PT: ["Portugal", "Portogallo", "Portugalia"],
  RO: ["Romania", "Roumanie", "Rumänien", "Rumanía", "Roemenië", "Rumunia", "România"],
  SK: ["Slovakia", "Slovaquie", "Slowakei", "Eslovaquia", "Slovacchia", "Slowakije", "Słowacja", "Slovensko"],
  SI: ["Slovenia", "Slovénie", "Slowenien", "Eslovenia", "Slovenië", "Słowenia", "Slovenija"],
  ES: ["Spain", "Espagne", "Spanien", "España", "Spagna", "Spanje", "Hiszpania"],
  SE: ["Sweden", "Suède", "Schweden", "Suecia", "Svezia", "Zweden", "Szwecja", "Sverige"],
  IS: ["Iceland", "Islande", "Island", "Islandia", "Islanda", "IJsland", "Ísland"],
  LI: ["Liechtenstein"],
  NO: ["Norway", "Norvège", "Norwegen", "Noruega", "Norvegia", "Noorwegen", "Norwegia", "Norge", "Noreg"],
  CH: [
    "Switzerland",
    "Suisse",
    "Schweiz",
    "Suiza",
    "Svizzera",
    "Zwitserland",
    "Szwajcaria",
    "Svizra",
    "Confoederatio Helvetica",
    "Helvetia",
  ],
  GB: [
    "United Kingdom",
    "The United Kingdom",
    "UK",
    "U.K.",
    "Great Britain",
    "Britain",
    "England",
    "Scotland",
    "Wales",
    "Northern Ireland",
    "United Kingdom of Great Britain and Northern Ireland",
    "Royaume-Uni",
    "Grande-Bretagne",
    "Angleterre",
    "Vereinigtes Königreich",
    "Großbritannien",
    "England",
    "Reino Unido",
    "Gran Bretaña",
    "Regno Unito",
    "Gran Bretagna",
    "Verenigd Koninkrijk",
    "Groot-Brittannië",
    "Wielka Brytania",
  ],
  US: [
    "United States",
    "United States of America",
    "The United States",
    "USA",
    "U.S.A.",
    "US",
    "U.S.",
    "America",
    "États-Unis",
    "États-Unis d'Amérique",
    "Vereinigte Staaten",
    "Vereinigte Staaten von Amerika",
    "Estados Unidos",
    "Estados Unidos de América",
    "Stati Uniti",
    "Stati Uniti d'America",
    "Verenigde Staten",
    "Stany Zjednoczone",
  ],
  CA: ["Canada", "Kanada", "Canadá"],
  AU: ["Australia", "Australie", "Australien", "Australië", "Commonwealth of Australia"],
  NZ: ["New Zealand", "Nouvelle-Zélande", "Neuseeland", "Nueva Zelanda", "Nuova Zelanda", "Nieuw-Zeeland", "Nowa Zelandia", "Aotearoa"],
  JP: ["Japan", "Japon", "Japón", "Giappone", "Japonia", "Nippon", "Nihon"],
  KR: ["South Korea", "Korea", "Republic of Korea", "Corée du Sud", "Südkorea", "Corea del Sur", "Corea del Sud", "Zuid-Korea", "Korea Południowa"],
  CN: ["China", "Chine", "Cina", "Chiny", "Zhongguo", "People's Republic of China"],
  HK: ["Hong Kong", "Hongkong"],
  TW: ["Taiwan", "Taïwan", "Taiwán", "Tajwan"],
  SG: ["Singapore", "Singapour", "Singapur"],
  IN: ["India", "Inde", "Indien", "Indie", "Indie", "Bharat"],
  IL: ["Israel", "Israël", "Israele", "Izrael"],
  AE: ["United Arab Emirates", "UAE", "Émirats arabes unis", "Vereinigte Arabische Emirate", "Emiratos Árabes Unidos", "Emirati Arabi Uniti", "Verenigde Arabische Emiraten", "Zjednoczone Emiraty Arabskie"],
  TR: ["Turkey", "Türkiye", "Turkiye", "Turquie", "Türkei", "Turquía", "Turchia", "Turkije", "Turcja"],
  UA: ["Ukraine", "Ucrania", "Ucraina", "Oekraïne", "Ukraina", "Ukrayina"],
  RS: ["Serbia", "Serbie", "Serbien", "Servië", "Srbija"],
  BA: ["Bosnia and Herzegovina", "Bosnia", "Bosnie-Herzégovine", "Bosnien und Herzegowina", "Bosnia y Herzegovina", "Bosnia ed Erzegovina", "Bosnië en Herzegovina", "Bośnia i Hercegowina", "Bosna i Hercegovina"],
  ME: ["Montenegro", "Monténégro", "Czarnogóra", "Crna Gora"],
  MK: ["North Macedonia", "Macedonia", "Macédoine du Nord", "Nordmazedonien", "Macedonia del Norte", "Macedonia del Nord", "Noord-Macedonië", "Macedonia Północna", "Severna Makedonija"],
  AL: ["Albania", "Albanie", "Albanien", "Albanië", "Shqipëri", "Shqipëria"],
  MD: ["Moldova", "Moldavie", "Moldau", "Moldavia", "Moldavië", "Mołdawia"],
  MC: ["Monaco", "Mónaco", "Monako"],
  AD: ["Andorra", "Andorre"],
  SM: ["San Marino", "Saint-Marin"],
  VA: ["Vatican", "Vatican City", "Holy See", "Cité du Vatican", "Vatikanstadt", "Ciudad del Vaticano", "Città del Vaticano", "Vaticaanstad", "Watykan"],
  MX: ["Mexico", "Mexique", "Mexiko", "México", "Messico", "Mexico", "Meksyk"],
  BR: ["Brazil", "Brésil", "Brasilien", "Brasil", "Brasile", "Brazilië", "Brazylia"],
  AR: ["Argentina", "Argentine", "Argentinien", "Argentinië", "Argentyna"],
  CL: ["Chile", "Chili", "Cile"],
  CO: ["Colombia", "Colombie", "Kolumbien", "Kolumbia"],
  ZA: ["South Africa", "Afrique du Sud", "Südafrika", "Sudáfrica", "Sudafrica", "Zuid-Afrika", "Republika Południowej Afryki", "RSA"],
  MA: ["Morocco", "Maroc", "Marokko", "Marruecos", "Marocco", "Maroko"],
  TN: ["Tunisia", "Tunisie", "Tunesien", "Túnez", "Tunesië", "Tunezja"],
  DZ: ["Algeria", "Algérie", "Algerien", "Argelia", "Algerije", "Algieria"],
  SA: ["Saudi Arabia", "Arabie saoudite", "Saudi-Arabien", "Arabia Saudita", "Saoedi-Arabië", "Arabia Saudyjska"],
  TH: ["Thailand", "Thaïlande", "Tailandia", "Tailandia", "Thailandia", "Tajlandia"],
  MY: ["Malaysia", "Malaisie", "Malasia", "Malesia", "Maleisië", "Malezja"],
  ID: ["Indonesia", "Indonésie", "Indonesien", "Indonesië", "Indonezja"],
  PH: ["Philippines", "Philippinen", "Filipinas", "Filippine", "Filipijnen", "Filipiny"],
  VN: ["Vietnam", "Viet Nam", "Viêt Nam", "Wietnam"],
  RU: ["Russia", "Russian Federation", "Russie", "Russland", "Rusia", "Russia", "Rusland", "Rosja", "Rossiya"],
  GE: ["Georgia", "Géorgie", "Georgien", "Georgië", "Gruzja", "Sakartvelo"],
  AM: ["Armenia", "Arménie", "Armenien", "Armenië", "Hayastan"],
  RE: ["Réunion", "La Réunion", "Reunion"],
  GP: ["Guadeloupe"],
  MQ: ["Martinique"],
  GF: ["French Guiana", "Guyane", "Guyane française"],
  YT: ["Mayotte"],
  NC: ["New Caledonia", "Nouvelle-Calédonie"],
  PF: ["French Polynesia", "Polynésie française"],
  PR: ["Puerto Rico", "Porto Rico"],
}

/** The comparison key of a name: lower case, diacritics and the letters NFD cannot split
 *  ("ß", "ł", "ø", "æ") folded to ASCII, then everything but a-z dropped. */
export function countryKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ł/g, "l")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/đ/g, "d")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "")
}

const BY_KEY: Map<string, string> = (() => {
  const map = new Map<string, string>()
  for (const [iso, names] of Object.entries(NAMES)) {
    for (const name of names) {
      const key = countryKey(name)
      if (key !== "" && !map.has(key)) map.set(key, iso)
    }
  }
  return map
})()

/** The ISO-2 code a country name stands for ("Deutschland" -> "DE"), or null when the text is
 *  not a known country name. A bare two-letter code is NOT read here: "DE" or "IN" alone are
 *  ambiguous as text; `namesCountry` accepts the expected code itself. */
export function countryIsoFromName(text: string): string | null {
  // A line with a digit is a locality ("98000 Monaco", "Singapore 048616"), never a country line.
  if (/\d/.test(text)) return null
  const key = countryKey(text)
  if (key === "") return null
  return BY_KEY.get(key) ?? null
}

/** True when `text` is just the name of `iso`: its code ("DE", "U.S."), or any of its listed names
 *  and variants ("Germany", "Allemagne", "USA", "Royaume-Uni"). */
export function namesCountry(text: string, iso: string | null): boolean {
  const code = (iso ?? "").trim().toUpperCase()
  // A line with a digit is a locality ("98000 Monaco", "1234 Luxembourg"), never a country line.
  if (/\d/.test(text)) return false
  const key = countryKey(text)
  if (key === "" || code === "") return false
  if (key === code.toLowerCase()) return true
  return BY_KEY.get(key) === code
}
