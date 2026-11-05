// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A contact's address book (kernel.contact_addresses, migration 0253): list,
// add, update, archive, mark stale, verify.
//
// Visibility is the database's: every call runs under the caller's own RLS, so
// an address is seen exactly when its contact is, and written only when its
// contact is editable by the caller (the 0124 / 0117 patterns). A contact the
// caller cannot see reads as missing (404), one they see but may not edit is a
// 403, and nobody learns more than reading the contact would tell them.
//
// Verification is a person's act. `verifyAddress` takes the verifier's user id
// and the basis they checked the address against (a purchase order, an email,
// a phone call), optionally with a note and a file; the caller decides who that
// person is (the REST route: the signed-in person; the agent tool: the person
// who approved the card). Nothing else here sets it: adding an address always
// stores it unverified, and changing any location field (name, company,
// street, city, postal code, region, country) clears the verification, since
// what was checked is no longer what is stored.

import { and, asc, sql as drizzleSql, eq, isNull } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { RlsClient, RlsTx } from "~/db"
import { extractRows } from "~/db"
import {
  type ContactAddressOrigin,
  type ContactAddressRole,
  type ContactAddressSource,
  contactAddresses,
  contacts,
  files,
  users,
} from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import { UUID_RE } from "~/lib/uuid"

type Db = RlsClient | RlsTx

const KERNEL = drizzleSql.raw(quoteIdent(schemaRef("kernel")))
/** The sharing resource type of a contact (kernel.resource_grants). */
const CONTACT_RESOURCE = "kernel.contact"

export const ADDRESS_ROLES = ["billing", "delivery", "other"] as const
export const ADDRESS_SOURCES = ["purchase_order", "email", "phone_call", "other"] as const
/** Longest text accepted in one address field, in characters. */
export const ADDRESS_FIELD_MAX = 200
/** Longest verification note, in characters. */
export const ADDRESS_NOTE_MAX = 1000

const field = z.string().trim().max(ADDRESS_FIELD_MAX)

/** The editable fields of an address (all optional: a patch sets only what it names). */
export const addressFieldsSchema = z.object({
  role: z.enum(ADDRESS_ROLES).optional(),
  label: field.nullable().optional(),
  name: field.nullable().optional(),
  company: field.nullable().optional(),
  street1: field.nullable().optional(),
  street2: field.nullable().optional(),
  city: field.nullable().optional(),
  postalCode: field.nullable().optional(),
  region: field.nullable().optional(),
  countryIso2: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "a two-letter country code (ISO 3166-1 alpha-2)")
    .nullable()
    .optional(),
  phone: field.nullable().optional(),
  email: field.nullable().optional(),
})
export type AddressFields = z.infer<typeof addressFieldsSchema>

export const verifyAddressSchema = z.object({
  source: z.enum(ADDRESS_SOURCES),
  note: z.string().trim().max(ADDRESS_NOTE_MAX).optional(),
  fileId: z.string().uuid().optional(),
})
export type VerifyAddressParams = z.infer<typeof verifyAddressSchema>

type TextField = Exclude<keyof AddressFields, "role">

/** The fields that say WHERE the address is: changing one clears the verification. */
export const LOCATION_FIELDS = [
  "name",
  "company",
  "street1",
  "street2",
  "city",
  "postalCode",
  "region",
  "countryIso2",
] as const satisfies readonly TextField[]

const TEXT_FIELDS = [
  "label",
  ...LOCATION_FIELDS,
  "phone",
  "email",
] as const satisfies readonly TextField[]

export interface ContactAddress {
  id: string
  contactId: string
  role: ContactAddressRole
  label: string | null
  name: string | null
  company: string | null
  street1: string | null
  street2: string | null
  city: string | null
  postalCode: string | null
  region: string | null
  countryIso2: string | null
  phone: string | null
  email: string | null
  origin: ContactAddressOrigin
  verified: boolean
  verifiedAt: Date | null
  verifiedBy: string | null
  /** The verifier's name, when the reader can see that user. */
  verifiedByName: string | null
  source: ContactAddressSource | null
  sourceNote: string | null
  sourceFileId: string | null
  staleAt: Date | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}

const columns = {
  id: contactAddresses.id,
  contactId: contactAddresses.contactId,
  role: contactAddresses.role,
  label: contactAddresses.label,
  name: contactAddresses.name,
  company: contactAddresses.company,
  street1: contactAddresses.street1,
  street2: contactAddresses.street2,
  city: contactAddresses.city,
  postalCode: contactAddresses.postalCode,
  region: contactAddresses.region,
  countryIso2: contactAddresses.countryIso2,
  phone: contactAddresses.phone,
  email: contactAddresses.email,
  origin: contactAddresses.origin,
  verifiedAt: contactAddresses.verifiedAt,
  verifiedBy: contactAddresses.verifiedBy,
  verifiedByName: users.name,
  source: contactAddresses.source,
  sourceNote: contactAddresses.sourceNote,
  sourceFileId: contactAddresses.sourceFileId,
  staleAt: contactAddresses.staleAt,
  createdBy: contactAddresses.createdBy,
  createdAt: contactAddresses.createdAt,
  updatedAt: contactAddresses.updatedAt,
  archivedAt: contactAddresses.archivedAt,
}

type Row = Omit<ContactAddress, "verified">

function toContactAddress(row: Row): ContactAddress {
  return { ...row, verified: row.verifiedAt !== null }
}

/** An empty string stores as no value. */
function addressFieldText(value: string | null | undefined): string | null {
  if (value == null) return null
  const v = value.trim()
  return v === "" ? null : v
}

/** A field's stored form: trimmed, empty as null, the country code upper case. */
function storedAddressField(key: TextField, value: string | null | undefined): string | null {
  const v = addressFieldText(value)
  return key === "countryIso2" && v !== null ? v.toUpperCase() : v
}

/** One line a person reads: "Name, Company, Street 1, Street 2, 75001 Paris, Region, FR". */
export function formatAddressLine(
  a: Partial<Record<(typeof LOCATION_FIELDS)[number], string | null>>,
): string {
  const cityLine = [a.postalCode, a.city].filter(Boolean).join(" ")
  const parts = [a.name, a.company, a.street1, a.street2, cityLine, a.region, a.countryIso2]
  return parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join(", ")
}

/** Whether the caller sees the contact, and may edit it (the 0253 write policy, asked of the database). */
async function contactAddressAccess(
  db: Db,
  orgId: string,
  contactId: string,
): Promise<"none" | "read" | "edit"> {
  if (!UUID_RE.test(contactId)) return "none"
  const rows = extractRows<{ editable: boolean }>(
    await db.execute(drizzleSql`
      SELECT (
        c.org_access = 'editor'
        OR c.owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
        OR ${KERNEL}.resource_grant_role(${CONTACT_RESOURCE}, c.id) = 'editor'
      ) AS editable
        FROM ${contacts} c
       WHERE c.id = ${contactId} AND c.org_id = ${orgId}
       LIMIT 1`),
  )
  const row = rows[0]
  if (!row) return "none"
  return row.editable ? "edit" : "read"
}

/** Whether the caller may change this contact's addresses (false when they only see it, or not at all). */
export async function addressBookEditable(
  db: Db,
  params: { orgId: string; contactId: string },
): Promise<boolean> {
  return (await contactAddressAccess(db, params.orgId, params.contactId)) === "edit"
}

async function requireAddressContact(db: Db, orgId: string, contactId: string, write: boolean) {
  const access = await contactAddressAccess(db, orgId, contactId)
  if (access === "none") throw new HTTPException(404, { message: "Contact not found" })
  if (write && access !== "edit") {
    throw new HTTPException(403, { message: "You cannot edit this contact's addresses" })
  }
}

async function readContactAddress(
  db: Db,
  orgId: string,
  contactId: string,
  addressId: string,
): Promise<ContactAddress | null> {
  if (!UUID_RE.test(addressId)) return null
  const [row] = await db
    .select(columns)
    .from(contactAddresses)
    .leftJoin(users, eq(users.id, contactAddresses.verifiedBy))
    .where(
      and(
        eq(contactAddresses.id, addressId),
        eq(contactAddresses.orgId, orgId),
        eq(contactAddresses.contactId, contactId),
      ),
    )
    .limit(1)
  return row ? toContactAddress(row) : null
}

/** One address of a contact the caller can see; 404 otherwise. */
export async function getAddress(
  db: Db,
  params: { orgId: string; contactId: string; addressId: string },
): Promise<ContactAddress> {
  await requireAddressContact(db, params.orgId, params.contactId, false)
  const found = await readContactAddress(db, params.orgId, params.contactId, params.addressId)
  if (!found) throw new HTTPException(404, { message: "Address not found" })
  return found
}

/**
 * The addresses of a contact the caller can see, verified first, then by
 * role and age. Archived ones only when asked for.
 */
export async function listAddresses(
  db: Db,
  params: {
    orgId: string
    contactId: string
    role?: ContactAddressRole
    includeArchived?: boolean
  },
): Promise<ContactAddress[]> {
  await requireAddressContact(db, params.orgId, params.contactId, false)
  const rows = await db
    .select(columns)
    .from(contactAddresses)
    .leftJoin(users, eq(users.id, contactAddresses.verifiedBy))
    .where(
      and(
        eq(contactAddresses.orgId, params.orgId),
        eq(contactAddresses.contactId, params.contactId),
        params.role ? eq(contactAddresses.role, params.role) : undefined,
        params.includeArchived ? undefined : isNull(contactAddresses.archivedAt),
      ),
    )
    .orderBy(
      drizzleSql`(${contactAddresses.verifiedAt} IS NULL)`,
      asc(contactAddresses.role),
      asc(contactAddresses.createdAt),
    )
  return rows.map(toContactAddress)
}

function addressHasLocation(fields: AddressFields): boolean {
  return LOCATION_FIELDS.some((k) => addressFieldText(fields[k]) !== null)
}

/**
 * Add an address to a contact. Always UNVERIFIED: verification is only ever
 * `verifyAddress`. An identical active address of the same role (every text
 * field equal) is returned as it is rather than duplicated.
 */
export async function addAddress(
  db: Db,
  params: {
    orgId: string
    userId: string
    contactId: string
    fields: AddressFields
    origin?: ContactAddressOrigin
  },
): Promise<{ address: ContactAddress; created: boolean }> {
  await requireAddressContact(db, params.orgId, params.contactId, true)
  if (!addressHasLocation(params.fields)) {
    throw new HTTPException(422, {
      message: "An address needs at least one of name, company, street, city or postal code",
    })
  }
  const role = params.fields.role ?? "delivery"
  const values = Object.fromEntries(
    TEXT_FIELDS.map((k) => [k, storedAddressField(k, params.fields[k])]),
  ) as Record<(typeof TEXT_FIELDS)[number], string | null>
  const existing = await listAddresses(db, {
    orgId: params.orgId,
    contactId: params.contactId,
    role,
  })
  const same = existing.find((a) => TEXT_FIELDS.every((k) => a[k] === values[k]))
  if (same) return { address: same, created: false }

  const [inserted] = await db
    .insert(contactAddresses)
    .values({
      orgId: params.orgId,
      contactId: params.contactId,
      role,
      ...values,
      origin: params.origin ?? "manual",
      createdBy: UUID_RE.test(params.userId) ? params.userId : null,
    })
    .returning({ id: contactAddresses.id })
  const address = inserted
    ? await readContactAddress(db, params.orgId, params.contactId, inserted.id)
    : null
  if (!address) throw new HTTPException(500, { message: "The address was not saved" })
  return { address, created: true }
}

/** The verification columns, all cleared (the CHECK wants them set together or not at all). */
const CLEARED_VERIFICATION = {
  verifiedAt: null,
  verifiedBy: null,
  source: null,
  sourceNote: null,
  sourceFileId: null,
} as const

async function updateAddressRow(
  db: Db,
  orgId: string,
  contactId: string,
  addressId: string,
  set: Partial<typeof contactAddresses.$inferInsert>,
): Promise<ContactAddress> {
  const [updated] = await db
    .update(contactAddresses)
    .set({ ...set, updatedAt: new Date() })
    .where(
      and(
        eq(contactAddresses.id, addressId),
        eq(contactAddresses.orgId, orgId),
        eq(contactAddresses.contactId, contactId),
      ),
    )
    .returning({ id: contactAddresses.id })
  // RLS hides a row the caller may not write: the update then matches nothing.
  if (!updated)
    throw new HTTPException(403, { message: "You cannot edit this contact's addresses" })
  const address = await readContactAddress(db, orgId, contactId, addressId)
  if (!address) throw new HTTPException(404, { message: "Address not found" })
  return address
}

/**
 * Change an address. Only the fields the patch names change. When a location
 * field changes, the verification (and a stale mark) is cleared: what a person
 * checked is no longer what is stored. `clearVerification` clears it whatever
 * changed (the agent tool: an agent's edit is never a verified one).
 */
export async function updateAddress(
  db: Db,
  params: {
    orgId: string
    contactId: string
    addressId: string
    patch: AddressFields
    clearVerification?: boolean
  },
): Promise<{ address: ContactAddress; changed: boolean; verificationCleared: boolean }> {
  await requireAddressContact(db, params.orgId, params.contactId, true)
  const current = await readContactAddress(db, params.orgId, params.contactId, params.addressId)
  if (!current) throw new HTTPException(404, { message: "Address not found" })
  if (current.archivedAt) throw new HTTPException(409, { message: "This address is archived" })

  const set: Partial<typeof contactAddresses.$inferInsert> = {}
  for (const k of TEXT_FIELDS) {
    if (params.patch[k] === undefined) continue
    const next = storedAddressField(k, params.patch[k])
    if (next !== current[k]) set[k] = next
  }
  if (params.patch.role !== undefined && params.patch.role !== current.role) {
    set.role = params.patch.role
  }
  const changed = Object.keys(set).length > 0
  if (!changed) return { address: current, changed: false, verificationCleared: false }

  const after = { ...current, ...set }
  if (!LOCATION_FIELDS.some((k) => addressFieldText(after[k]) !== null)) {
    throw new HTTPException(422, {
      message: "An address needs at least one of name, company, street, city or postal code",
    })
  }
  const locationChanged = LOCATION_FIELDS.some((k) => k in set)
  const clear = current.verified && (locationChanged || params.clearVerification === true)
  if (clear) Object.assign(set, CLEARED_VERIFICATION)
  if (locationChanged) set.staleAt = null
  const address = await updateAddressRow(db, params.orgId, params.contactId, params.addressId, set)
  return { address, changed: true, verificationCleared: clear }
}

/** Archive an address (it leaves the list; the row is kept). */
export async function archiveAddress(
  db: Db,
  params: { orgId: string; contactId: string; addressId: string },
): Promise<ContactAddress> {
  await requireAddressContact(db, params.orgId, params.contactId, true)
  const current = await readContactAddress(db, params.orgId, params.contactId, params.addressId)
  if (!current) throw new HTTPException(404, { message: "Address not found" })
  if (current.archivedAt) return current
  return updateAddressRow(db, params.orgId, params.contactId, params.addressId, {
    archivedAt: new Date(),
  })
}

/** Mark an address as possibly out of date (`stale: true`), or take the mark off. */
export async function markAddressStale(
  db: Db,
  params: { orgId: string; contactId: string; addressId: string; stale: boolean },
): Promise<ContactAddress> {
  await requireAddressContact(db, params.orgId, params.contactId, true)
  const current = await readContactAddress(db, params.orgId, params.contactId, params.addressId)
  if (!current) throw new HTTPException(404, { message: "Address not found" })
  if (current.archivedAt) throw new HTTPException(409, { message: "This address is archived" })
  return updateAddressRow(db, params.orgId, params.contactId, params.addressId, {
    staleAt: params.stale ? new Date() : null,
  })
}

/** A file the caller can read (kernel.files under their RLS), with its name. */
export async function readableFile(
  db: Db,
  orgId: string,
  fileId: string,
): Promise<{ id: string; filename: string } | null> {
  if (!UUID_RE.test(fileId)) return null
  const [row] = await db
    .select({ id: files.id, filename: files.filename })
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.orgId, orgId)))
    .limit(1)
  return row ?? null
}

/**
 * Checks a verification could be recorded by the caller: the contact is
 * editable, the address exists and is not archived, and the source file (when
 * given) is one the caller can read. Throws the HTTP error otherwise.
 */
export async function assertVerifiable(
  db: Db,
  params: { orgId: string; contactId: string; addressId: string; fileId?: string },
): Promise<ContactAddress> {
  await requireAddressContact(db, params.orgId, params.contactId, true)
  const current = await readContactAddress(db, params.orgId, params.contactId, params.addressId)
  if (!current) throw new HTTPException(404, { message: "Address not found" })
  if (current.archivedAt) throw new HTTPException(409, { message: "This address is archived" })
  if (params.fileId && !(await readableFile(db, params.orgId, params.fileId))) {
    throw new HTTPException(422, {
      message: "The source file was not found, or you cannot read it",
    })
  }
  return current
}

/**
 * Record that a PERSON checked this address against `source`. The caller
 * passes the person: never an agent, an app or a mail flow (see the header).
 * Clears a stale mark: the address was just confirmed.
 */
export async function verifyAddress(
  db: Db,
  params: {
    orgId: string
    contactId: string
    addressId: string
    verifierUserId: string
    verification: VerifyAddressParams
  },
): Promise<ContactAddress> {
  if (!UUID_RE.test(params.verifierUserId)) {
    throw new HTTPException(403, { message: "Only a person can verify an address" })
  }
  const { source, note, fileId } = params.verification
  await assertVerifiable(db, { ...params, fileId })
  return updateAddressRow(db, params.orgId, params.contactId, params.addressId, {
    verifiedAt: new Date(),
    verifiedBy: params.verifierUserId,
    source,
    sourceNote: addressFieldText(note),
    sourceFileId: fileId ?? null,
    staleAt: null,
  })
}
