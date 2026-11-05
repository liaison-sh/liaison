// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A test stack's stand-in for the EU VIES VAT service, as seen from sandboxed apps.
//
// An app checks a VAT number by fetching VIES's REST API through the sandbox egress bridge
// (`https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{cc}/vat/{number}`). A test that runs
// that check against the live service depends on it being up and on what it says about a
// made-up number, so it passes or fails with the network. With `LIAISON_TEST_VIES_STUB=1`, read
// only when NODE_ENV is test, the bridge answers those requests here instead, in VIES's own
// response shape: the numbers below are valid, every other well-formed number is invalid, and
// `{cc}000000001` answers a member-state outage (MS_UNAVAILABLE) for the "not verified" path.
// Never read elsewhere; a deployment's VIES traffic is untouched.
import { env } from "~/lib/env"

const VIES_HOST = "ec.europa.eu"
const VIES_PATH = /^\/taxation_customs\/vies\/rest-api\/ms\/([A-Z]{2})\/vat\/([0-9A-Z]+)$/

/** Fictional, real-shaped registrations the stand-in reports as valid. */
export const TEST_VIES_REGISTRY: Readonly<Record<string, { name: string; address: string }>> = {
  DE000000000: {
    name: "Tonwerk Audio GmbH",
    address: "Industriestrasse 12, 80807 München, Germany",
  },
  DE298765432: { name: "Klangwerk GmbH", address: "Rheinallee 4, 40545 Düsseldorf, Germany" },
  IT00000000000: { name: "Suono Studio S.r.l.", address: "Via Roma 1, 20121 Milano, Italy" },
}

/** A number the stand-in answers with a member-state outage, for any country code. */
export const TEST_VIES_OUTAGE_NUMBER = "000000001"

export function testViesStubEnabled(
  nodeEnv: string = env.NODE_ENV,
  value: string | undefined = process.env.LIAISON_TEST_VIES_STUB,
): boolean {
  return nodeEnv === "test" && value === "1"
}

/** The stand-in's answer to a VIES REST request, or null for any other request. */
export function maybeTestViesResponse(
  url: string,
  enabled: boolean = testViesStubEnabled(),
): Response | null {
  if (!enabled) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.hostname !== VIES_HOST) return null
  const m = VIES_PATH.exec(u.pathname)
  if (!m) return null
  const cc = m[1]!
  const number = m[2]!
  const requestDate = new Date().toISOString()
  const body =
    number === TEST_VIES_OUTAGE_NUMBER
      ? {
          isValid: false,
          requestDate,
          userError: "MS_UNAVAILABLE",
          name: null,
          address: null,
          vatNumber: number,
        }
      : (() => {
          const record = TEST_VIES_REGISTRY[`${cc}${number}`]
          return record
            ? {
                isValid: true,
                requestDate,
                userError: "VALID",
                name: record.name,
                address: record.address,
                vatNumber: number,
              }
            : {
                isValid: false,
                requestDate,
                userError: "INVALID",
                name: "---",
                address: "---",
                vatNumber: number,
              }
        })()
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}
