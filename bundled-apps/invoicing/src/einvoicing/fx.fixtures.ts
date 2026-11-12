// SPDX-License-Identifier: FSL-1.1-ALv2
// Recorded responses of the ECB data API (`/service/data/EXR/D.<CCY>.EUR.SP00.A`,
// `format=csvdata`), recorded 2026-10-14. Public reference rates: nothing to anonymise.

/** USD per EUR, 2026-10-01 to 2026-10-02: one CSV row per business day. */
export const ECB_USD_CSV =
  'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_CONF,OBS_PRE_BREAK,OBS_COM,TIME_FORMAT,BREAKS,COLLECTION,COMPILING_ORG,DISS_ORG,DOM_SER_IDS,PUBL_ECB,PUBL_MU,PUBL_PUBLIC,UNIT_INDEX_BASE,COMPILATION,COVERAGE,DECIMALS,NAT_TITLE,SOURCE_AGENCY,SOURCE_PUB,TITLE,TITLE_COMPL,UNIT,UNIT_MULT\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-01,1.1298,A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,US dollar/Euro ECB reference exchange rate,"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)",USD,0\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-02,1.1225,A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,US dollar/Euro ECB reference exchange rate,"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)",USD,0\n'

/** A window with no business day (a weekend): the API answers 200 with an empty body. */
export const ECB_EMPTY_200 = { status: 200, body: "" }
