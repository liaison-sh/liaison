// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A large customer for the timeline's speed test, written by SQL in one org
 * (deleted with it): one company of 50 people with three years of history.
 * Mail 20 000 messages, tickets 500 with 1 500 notes, 40 deals with 600
 * subtasks, one weekly meeting over three years plus 300 single meetings.
 * Invoicing is a catalog app this database does not carry, so its documents
 * are not written here.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"

const K = drizzleSql.raw(schemaRef("kernel"))

export const SCALE = {
  people: 50,
  mailMessages: 20_000,
  tickets: 500,
  ticketNotes: 1_500,
  deals: 40,
  dealSubtasks: 600,
  singleMeetings: 300,
  years: 3,
} as const

export interface ScaleWorldInput {
  orgId: string
  userId: string
  companyId: string
  mailAccountId: string
  calendarId: string
  calaccess: string
  pipelineId: string
  stageId: string
  tag: string
}

export async function seedActivityScaleWorld(input: ScaleWorldInput): Promise<string[]> {
  return withSystemDb("activity-scale-seed", (tx) => seedIn(tx, input))
}

async function seedIn(tx: PrivilegedDb, input: ScaleWorldInput): Promise<string[]> {
  const { orgId, userId, companyId, tag } = input
  const span = `${SCALE.years * 365} days`
  const people = extractRows<{ id: string; email: string }>(
    await tx.execute(drizzleSql`
    INSERT INTO ${K}.contacts (org_id, handle, name, email, company_id, org_access, created_by)
    SELECT ${orgId}, '@scale-' || ${tag} || '-' || g, 'Person ' || g,
           'scale' || g || '-' || ${tag} || '@dealer.example', ${companyId}, 'editor', ${userId}
      FROM generate_series(1, ${SCALE.people}) g
    RETURNING id::text AS id, email`),
  )
  const ids = people.map((p) => p.id)
  // One conversation per person, and the messages spread over three years.
  await tx.execute(drizzleSql`
    INSERT INTO app_mail.conversations (org_id, account_id, owner_type, external_thread_id, subject, status, contact_id)
    SELECT ${orgId}, ${input.mailAccountId}, 'org', 'scale-' || c.id, 'Orders', 'open', c.id
      FROM ${K}.contacts c WHERE c.org_id = ${orgId} AND c.company_id = ${companyId}`)
  await tx.execute(drizzleSql`
    INSERT INTO app_mail.messages (org_id, conversation_id, account_id, external_message_id, direction,
                                   subject, sent_at, synced_at, owner_type)
    SELECT ${orgId}, cv.id, ${input.mailAccountId}, 'scale-m-' || cv.id || '-' || g,
           CASE WHEN g % 2 = 0 THEN 'inbound' ELSE 'outbound' END, 'Order ' || g,
           now() - (random() * ${span}::interval), now() - (random() * ${span}::interval),
           'org'
      FROM app_mail.conversations cv, generate_series(1, ${SCALE.mailMessages / SCALE.people}) g
     WHERE cv.org_id = ${orgId} AND cv.account_id = ${input.mailAccountId}`)
  await tx.execute(drizzleSql`
    INSERT INTO app_tickets.tickets (org_id, handle, subject, channel, reply_token, sla_target_seconds,
                                     status, contact_id, created_at, updated_at)
    SELECT ${orgId}, 'SC-' || g, 'Repair ' || g, 'email', 'scale-rt-' || ${tag} || '-' || g, 86400,
           CASE WHEN g % 3 = 0 THEN 'closed' ELSE 'open' END,
           (${`{${ids.join(",")}}`}::uuid[])[1 + (g % ${SCALE.people})],
           now() - (random() * ${span}::interval), now() - (random() * ${span}::interval)
      FROM generate_series(1, ${SCALE.tickets}) g`)
  await tx.execute(drizzleSql`
    INSERT INTO app_tickets.messages (org_id, ticket_id, kind, text_body, sent_at, created_at)
    SELECT ${orgId}, t.id, 'note', 'Called.', now(), t.created_at + (g || ' hours')::interval
      FROM app_tickets.tickets t, generate_series(1, ${SCALE.ticketNotes / SCALE.tickets}) g
     WHERE t.org_id = ${orgId}`)
  // Deals: a task each, with its own thread, and subtasks under them.
  await tx.execute(drizzleSql`
    INSERT INTO ${K}.threads (id, org_id, handle, created_by)
    SELECT gen_random_uuid(), ${orgId}, 'scale-deal-' || ${tag} || '-' || g, ${userId}
      FROM generate_series(1, ${SCALE.deals}) g`)
  await tx.execute(drizzleSql`
    INSERT INTO app_projects.tasks (org_id, project_id, status_id, title, number, thread_id, created_by,
                                    created_at, updated_at)
    SELECT ${orgId}, ${input.pipelineId}, ${input.stageId}, 'Deal ' || row_number() OVER (),
           1000 + row_number() OVER (), th.id, ${userId},
           now() - (random() * ${span}::interval), now()
      FROM ${K}.threads th WHERE th.org_id = ${orgId} AND th.handle LIKE ${`scale-deal-${tag}-%`}`)
  await tx.execute(drizzleSql`
    INSERT INTO app_projects.deals (task_id, org_id, company_id, contact_id, outcome, closed_at)
    SELECT t.id, ${orgId}, ${companyId}, (${`{${ids.join(",")}}`}::uuid[])[1 + (t.number % ${SCALE.people})],
           CASE WHEN t.number % 4 = 0 THEN 'won' ELSE 'open' END,
           CASE WHEN t.number % 4 = 0 THEN t.created_at + interval '30 days' END
      FROM app_projects.tasks t WHERE t.org_id = ${orgId} AND t.project_id = ${input.pipelineId}`)
  await tx.execute(drizzleSql`
    WITH parents AS (
      SELECT d.task_id, g FROM app_projects.deals d, generate_series(1, ${SCALE.dealSubtasks / SCALE.deals}) g
       WHERE d.org_id = ${orgId}
    ), th AS (
      INSERT INTO ${K}.threads (id, org_id, handle, created_by)
      SELECT gen_random_uuid(), ${orgId}, 'scale-sub-' || ${tag} || '-' || p.task_id || '-' || p.g, ${userId}
        FROM parents p
      RETURNING id, handle
    )
    INSERT INTO app_projects.tasks (org_id, project_id, parent_task_id, status_id, title, number, thread_id,
                                    created_by, created_at, updated_at)
    SELECT ${orgId}, ${input.pipelineId}, p.task_id, ${input.stageId}, 'Step ' || p.g,
           5000 + row_number() OVER (), th.id, ${userId},
           now() - (random() * ${span}::interval), now()
      FROM parents p JOIN th ON th.handle = 'scale-sub-' || ${tag} || '-' || p.task_id || '-' || p.g`)
  // Meetings: a weekly one with the first person over three years, and single ones.
  const first = people[0]?.email ?? ""
  await tx.execute(drizzleSql`
    INSERT INTO app_calendar.events (org_id, calendar_id, calaccess, google_event_id, title, status,
                                     start, "end", attendees, recurrence)
    VALUES (${orgId}, ${input.calendarId}, ${input.calaccess}, ${`scale-weekly-${tag}`}, 'Weekly call',
            'confirmed',
            jsonb_build_object('dateTime', to_char((now() - ${span}::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
            jsonb_build_object('dateTime', to_char((now() - ${span}::interval + interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
            jsonb_build_array(jsonb_build_object('email', ${first}::text)), '["RRULE:FREQ=WEEKLY"]'::jsonb)`)
  await tx.execute(drizzleSql`
    INSERT INTO app_calendar.events (org_id, calendar_id, calaccess, google_event_id, title, status,
                                     start, "end", attendees)
    SELECT ${orgId}, ${input.calendarId}, ${input.calaccess}, 'scale-single-' || ${tag} || '-' || g,
           'Visit ' || g, 'confirmed',
           jsonb_build_object('dateTime', to_char(s AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
           jsonb_build_object('dateTime', to_char((s + interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
           jsonb_build_array(jsonb_build_object('email', (${`{${people.map((p) => p.email).join(",")}}`}::text[])[1 + (g % ${SCALE.people})]))
      FROM generate_series(1, ${SCALE.singleMeetings}) g,
           LATERAL (SELECT now() - (random() * ${span}::interval) AS s) t`)
  await tx.execute(drizzleSql`ANALYZE app_mail.messages`)
  return ids
}
