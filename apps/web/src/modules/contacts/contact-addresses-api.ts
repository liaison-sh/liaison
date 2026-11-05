// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The contact address book over REST (/api/contacts/:id/addresses). The
// kernel's own contact page is the one browser surface that verifies an
// address: app UIs reach the kernel through the host services, which refuse
// the verify route (framework/person-only-actions.ts).

export const ADDRESS_ROLES = ["billing", "delivery", "other"] as const
export type AddressRole = (typeof ADDRESS_ROLES)[number]
export const ADDRESS_SOURCES = ["purchase_order", "email", "phone_call", "other"] as const
export type AddressSource = (typeof ADDRESS_SOURCES)[number]

/** The text fields a person edits, in form order. */
export const ADDRESS_TEXT_FIELDS = [
  "label",
  "name",
  "company",
  "street1",
  "street2",
  "postalCode",
  "city",
  "region",
  "countryIso2",
  "phone",
  "email",
] as const
export type AddressTextField = (typeof ADDRESS_TEXT_FIELDS)[number]

export interface ContactAddress extends Record<AddressTextField, string | null> {
  id: string
  contactId: string
  role: AddressRole
  origin: string
  verified: boolean
  verifiedAt: string | null
  verifiedBy: string | null
  verifiedByName: string | null
  source: AddressSource | null
  sourceNote: string | null
  sourceFileId: string | null
  staleAt: string | null
  archivedAt: string | null
}

export type AddressDraft = { role: AddressRole } & Record<AddressTextField, string | null>

export interface VerifyInput {
  source: AddressSource
  note?: string
  fileId?: string
}

/** A file stored on the contact, offered as the verification's evidence. */
export interface ContactFile {
  id: string
  filename: string
}

/** A change fails inline (the section says so), never as the global toast. */
const QUIET = { suppressGlobalError: true } as const

export interface AddressesApi {
  getEnvelope: <T>(
    path: string,
    init?: { suppressGlobalError?: boolean },
  ) => Promise<{ data: T; meta?: Record<string, unknown> }>
  get: <T>(path: string, init?: { suppressGlobalError?: boolean }) => Promise<T>
  post: <T>(path: string, body?: unknown, init?: { suppressGlobalError?: boolean }) => Promise<T>
  patch: <T>(path: string, body?: unknown, init?: { suppressGlobalError?: boolean }) => Promise<T>
}

const base = (contactId: string) => `/contacts/${encodeURIComponent(contactId)}/addresses`
const one = (contactId: string, addressId: string) =>
  `${base(contactId)}/${encodeURIComponent(addressId)}`

export async function listAddresses(
  api: AddressesApi,
  contactId: string,
): Promise<{ rows: ContactAddress[]; canEdit: boolean }> {
  const envelope = await api.getEnvelope<ContactAddress[]>(base(contactId), QUIET)
  return { rows: envelope.data ?? [], canEdit: envelope.meta?.canEdit === true }
}

export function addAddress(
  api: AddressesApi,
  contactId: string,
  draft: AddressDraft,
): Promise<ContactAddress> {
  return api.post<ContactAddress>(base(contactId), draft, QUIET)
}

export function updateAddress(
  api: AddressesApi,
  contactId: string,
  addressId: string,
  patch: Partial<AddressDraft>,
): Promise<ContactAddress> {
  return api.patch<ContactAddress>(one(contactId, addressId), patch, QUIET)
}

export function archiveAddress(
  api: AddressesApi,
  contactId: string,
  addressId: string,
): Promise<ContactAddress> {
  return api.post<ContactAddress>(`${one(contactId, addressId)}/archive`, undefined, QUIET)
}

export function markAddressStale(
  api: AddressesApi,
  contactId: string,
  addressId: string,
  stale: boolean,
): Promise<ContactAddress> {
  return api.post<ContactAddress>(`${one(contactId, addressId)}/stale`, { stale }, QUIET)
}

export function verifyAddress(
  api: AddressesApi,
  contactId: string,
  addressId: string,
  input: VerifyInput,
): Promise<ContactAddress> {
  return api.post<ContactAddress>(`${one(contactId, addressId)}/verify`, input, QUIET)
}

/** The files stored on the contact (none when the list cannot be read). */
export async function listContactFiles(
  api: AddressesApi,
  contactId: string,
): Promise<ContactFile[]> {
  const query = new URLSearchParams({ app: "kernel", entityType: "contact", entityId: contactId })
  try {
    const rows = await api.get<ContactFile[]>(`/files?${query.toString()}`, QUIET)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/** One line for an address: name, company, street, postal code and city, region, country. */
export function addressLine(a: Partial<Record<AddressTextField, string | null>>): string {
  const cityLine = [a.postalCode, a.city].filter(Boolean).join(" ")
  return [a.name, a.company, a.street1, a.street2, cityLine, a.region, a.countryIso2]
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .join(", ")
}
