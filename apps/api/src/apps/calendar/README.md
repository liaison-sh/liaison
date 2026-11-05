# Calendar — bidirectional Google Calendar connector

Calendar is a Google Calendar connector with a month/week UI. Events created,
edited, or deleted here sync out to Google, and changes made in Google sync back
in (push webhook + a polling fallback). Personal connections are private to their
owner; org connections are visible to every org member, and writes to org
calendars are permission-gated by app role.

## Tools

| Tool | Scope | What it does |
|------|-------|--------------|
| `list_calendars` | `calendar:events:read` | List the connected Google calendars visible to the caller, selected or not, with their `selected` flag. |
| `list_events` | `calendar:events:read` | List events in a time window (recurring events expanded into occurrences). |
| `search_events` | `calendar:events:read` | Text search over title, description, location. |
| `create_event` | `calendar:events:write` | Create an event on a writable calendar (syncs to Google; `sendUpdates` disabled — attendees are not emailed). `conference: "google_meet"` creates a Google Meet and returns its `meetLink`. |
| `update_event` | `calendar:events:write` | Update an event: time, title, description, location, guests; `conference: "google_meet"` adds a Meet, `"none"` removes it. |
| `delete_event` | `calendar:events:write` | Delete an event. |
| `set_selected` | `calendar:events:write` | Toggle whether a calendar is synced (org calendars need admin scope). |
| `list_accounts` | `calendar:events:read` | List connected Calendar accounts for the Settings UI. |

**Video meetings.** A create or update with `conference` stores a conference request on the row
(`conference_request`: `add` / `remove`). The push sends it with `conferenceDataVersion=1`: a
`conferenceData.createRequest` (`hangoutsMeet`, `requestId` stable per row version) to add a
Meet, `conferenceData: null` to remove one; edits without `conference` leave Google's
conference untouched. The link Google answers (`hangoutLink`, else the video entry point) is
stored in `hangout_link`. The tool handler pushes such a change immediately so the result can
carry `meetLink`; the queued push job is delayed 60 s and only backs it up. A location holding
only a product name ("Google Meet") is turned into a real Meet request. Only Google accounts
connect, so Teams or Zoom links cannot be created.

**Editing a recurring meeting.** `update_event` accepts the master by its local id or by the
Google id `list_events` returns, and an edited occurrence by its own id. Any event of a series
needs `scope`: without it the call is refused with a message telling the agent to ask the
user. `"series"` edits the master; `"occurrence"` edits one instance: the exception row if it
exists, else a new row created for Google's instance id (`<master>_<YYYYMMDDTHHMMSSZ>`, or
`_<YYYYMMDD>` all-day) from `occurrenceStart`, checked against a simple repeat rule. The push
then updates that instance on Google, never the series. `delete_event` takes the same
scope: `"occurrence"` tombstones that instance (it reads as cancelled at once) and the push
DELETEs Google's instance id, after which the row stays as a cancelled exception; `"series"`
deletes the master. The web dialog sends `scope: "occurrence"` when saving or deleting an
occurrence row.

Recurring events store a master row plus exception rows; editing recurrence is
limited to none/daily/weekly/monthly. A complex inbound RRULE is preserved but
rendered read-only.

Occurrences are computed by `expandRecurrence` (`packages/shared/src/calendar-recurrence.ts`),
shared by the web calendar and the API: DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT and
UNTIL (all RFC 5545 forms), WEEKLY BYDAY lists, one MONTHLY BYMONTHDAY or ordinal BYDAY, and
EXDATE, in the series' time zone. Exception rows (`recurring_event_id` = the master's Google id)
replace the occurrence at their `original_start_time`. `list_events` returns only what the
window needs: plain events overlapping it, masters with an occurrence in it, and exceptions
whose original slot or own time touches it.

Disconnecting an account deletes its calendars, their events and sync log (the account row
stays, marked disconnected); reconnecting the address imports them again from Google.

## Connecting

Read [`docs/connecting-apps.md`](../../../../../docs/connecting-apps.md) first —
it covers the shared OAuth machinery (callback URL, client resolution, ownership,
token refresh). This section is the Calendar-specific runbook.

**Connection:** one `oauth2` connection named `google-calendar`. Scopes:
`openid` + `email` + `https://www.googleapis.com/auth/calendar.events` (read and
write events, and watch them for changes) +
`https://www.googleapis.com/auth/calendar.calendarlist.readonly` (list the
account's calendars to choose which to import). Nothing else is requested: the app
never reads calendar settings, sharing (ACL) or free/busy. A connection made before
the narrowing holds the broader `https://www.googleapis.com/auth/calendar` grant,
which covers both and keeps working without a reconnect. `calendar.events` is a
**Google-sensitive scope**: an *Internal* Google Workspace app, or a *verified
External* app, is required for anyone outside the GCP project's own workspace to
connect.

Disconnecting deletes the account's imported calendars, events and sync log, and
the stored tokens; Google is asked to revoke the grant unless another Liaison
connection (Mail, Tickets, Drive) still uses the same Google account.

### What the connection needs, and where each part comes from

| Thing | Where it comes from |
|---|---|
| OAuth client id + secret | The **shared Google integration client**, picked by the one resolver (`modules/apps/connections/oauth-client.ts`): (1) the workspace's Google client saved in **Settings → Mail Setup** (org `settings.integrations.google.oauthClient`); else (2) a client stored for this connection, the DB row `kernel.oauth_providers` named `calendar:google-calendar` (`PUT /api/connections/calendar/google-calendar/oauth-client` or `config apply`); else (3) the instance's client, env **`GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET`** (both or neither; not `GOOGLE_OAUTH_*`). Mail, Calendar and Tickets share the workspace client — configure it once. Each connected account keeps the client that minted its tokens (recorded at connect): saving another client moves an account only when it is reconnected. |
| The user's calendar access | Granted at consent time when the operator clicks **Connect via OAuth**. `access_type=offline` + `prompt=consent` are requested so a refresh token is always issued. Tokens are stored encrypted and refreshed automatically. |

> **Trap:** the env names are `GMAIL_OAUTH_*`, not `GOOGLE_CALENDAR_OAUTH_*` and
> not the generic `GOOGLE_OAUTH_*`. Setting a `GOOGLE_CALENDAR_*` pair does
> nothing — the resolver never reads it.

### Provisioning steps (once per workspace)

1. In Google Cloud Console, pick/create a project and create an **OAuth 2.0
   Client ID** of type *Web application* (or reuse the one you already set up for
   Gmail/Tickets — they share it).
2. Add `${BASE_URL}/api/connections/callback` to the client's **Authorized
   redirect URIs**. Exact scheme + host — a mismatch is `redirect_uri_mismatch`.
3. **Enable the Google Calendar API** on that project (APIs & Services → Library
   → Google Calendar API → Enable).
4. Set the **consent screen audience** (Google Auth Platform → Audience). Because
   `calendar` is a sensitive scope:
   - **Internal** — only members of the Workspace that owns the GCP project can
     connect. Simplest when the calendar account is in that same workspace.
   - **External + Testing** — anyone can connect, but only accounts added as
     **test users** pass consent. Going to *External + Production* with a
     sensitive scope requires Google verification.
5. Save the client id/secret via **Settings → Mail Setup** (per-org) or the
   `GMAIL_OAUTH_*` env, then click **Connect via OAuth** in Calendar settings.

**Ownership:** for a shared team calendar that agents must reach, connect it
**org-owned** (`mode: "org"`, needs `calendar:accounts:admin`). A user-owned
calendar returns `not_connected` for everyone else — see the isolation note in
the central doc. Selecting/deselecting an **org** calendar likewise requires the
admin scope; a member may toggle a personal calendar they own.

### Failure modes

| Symptom / code | Cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` at Google | `${BASE_URL}/api/connections/callback` not registered, or `BASE_URL` wrong | Register the exact callback URL (step 2); verify `BASE_URL`. |
| "No OAuth client configured" on Connect | No org Mail-Setup client, no `calendar:google-calendar` DB row, **and** no instance `GMAIL_OAUTH_*` pair | Configure the shared Google client in Settings → Mail Setup, `PUT …/oauth-client`, or set the `GMAIL_OAUTH_*` env. |
| Consent screen blocks the account | sensitive `calendar` scope + audience not covering that account | Set audience to Internal (same workspace) or add the account as an External **test user** (step 4). |
| Account shows `reauth-required` / repeated 401s | Google rejected the refresh token (`invalid_grant`) | Disconnect and reconnect the calendar account. |
| Tool returns `not_connected` for some users only | connection is user-owned; caller/agent is a different user | Reconnect **org-owned** (`mode: "org"`, needs `calendar:accounts:admin`). |
| A recurring event won't accept a recurrence edit | inbound RRULE is complex (unsupported by the none/daily/weekly/monthly editor) | Expected — the master is preserved read-only; edit recurrence in Google. |
