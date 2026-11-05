# Notifications

How Liaison tells a person that something needs them: the attention feed in the app, desktop
notifications, phone push and the email digest. Each person chooses, per group of events and per
channel, how they hear about it (Settings, Notifications), and can ask their agent to change it.

## Channels

| channel | what | where it is decided |
|-|-|-|
| in app | the attention feed and the bell | always on; it is the record |
| desktop | an OS notification from the desktop app or an open browser tab | see "Desktop" |
| push | APNs (iOS) or FCM (Android) to a registered phone | `apps/api/src/modules/push/` |
| email | the digest mail, at the user's digest cadence | `apps/api/src/modules/attention/digest-jobs.ts` |

## What interrupts you

A notification asks for your attention, so the phone, the computer banner and their sound are kept for
what asks for you directly:

- a direct message (a conversation without a title, or a room with only you and an agent), including
  an app's post there;
- an @mention of you;
- a reply in a reply thread you follow (you started it, replied in it or were mentioned in it);
- an approval only you, or your role, can decide, and an access request you can grant;
- a computer session of yours that needs you, is done or failed;
- a monitoring incident, if you are on call (see "On call").

Everything else goes to the feed (and the digest) quietly. A post in a channel is one of those: by
default a channel notifies its members only when it mentions them. To be told of every post of one
channel, switch on "Notify me of every message" in that channel's menu (it is yours only, stored in
`kernel.user_thread_state.notify_all_posts`, set with `PATCH /api/threads/:id/state` and
`notifyAllPosts`). The decision on a request you made (approved, denied, expired, access granted) and
new email also go to the feed quietly by default; each can be switched back on in the grid.

Urgency orders the feed and never makes noise by itself, and it does not cross quiet hours: only a
critical incident for the people on call does (see "Quiet hours"). Only the system marks an item urgent (an
approval for the person who decides it, an app's urgent kind, a critical incident); an agent's own
urgency on `notify_user` orders its note in the feed but never makes it urgent.

### Your own actions and your own agent

You are never notified about what you did, nor about your own agent's work done for you:

- your own messages, and a decision you made yourself;
- what your agent writes while it works: progress lines, its questions to other agents, and the posts it
  makes in other conversations because you asked (they land there unread);
- a line the system writes into a conversation (a routine starting, an edit to a request): it interrupts
  only a member it mentions. An app's post follows the rules of the room it lands in: in a direct
  conversation it notifies like a direct message, in a channel only when it mentions you.

When your agent finishes (the answer that ends its turn, or a routine's summary), you get one
notification carrying that answer, on the phone, the computer and in the feed, whether you waited or
left it running, and whether you asked in the app or from an outside client connected over MCP. A
turn that ends otherwise (it failed, ran out of time, was stopped, or was refused because the
workspace is out of agent usage) tells you the same way. Cards posted along the way ("Started on
<computer>") and an agent's answer to another agent do not. It is held back only while that very conversation is open in front of you (a focused
window or the phone app showing it); having asked a moment ago and moved on to another conversation
does not count. An approval your agent raises in the conversation you are reading does not notify you
either: its card is on your screen. Read elsewhere, it notifies you as any approval does.

## Groups and the grid

Every attention kind belongs to one group (`packages/shared/src/notifications/groups.ts`): direct
messages and mentions, replies in your threads, approvals and access requests (with a routine run
waiting for its owner's private mailbox, `routine_mailbox_wait`), decisions on your requests
(`approval_decision`, `scope_request_decided`), tickets tasks and knowledge, new email, agent and routine alerts, monitoring incidents, system alerts. The monitoring
app's `monitoring:incident.critical` and `monitoring:incident.warning` go to monitoring incidents (phone
and computer on by default, email off); any other app's `<app>:<kind>` falls in tickets tasks and
knowledge. Replies in your threads (channel posts), decisions on your requests and new email are in
the feed and the digest by default, not on the phone or the computer (see "What interrupts you"). The grid is one on/off per group and channel, stored as the differences
from the defaults in `kernel.user_preferences.notification_channels`; `GET`/`PATCH
/api/notifications/settings` read and write it. In Liaison is always on. The digest cadence decides
when email goes out; the email column decides what goes in it, and cadence "off" is every email cell off.

## New tickets

An inbox with **Notify on new ticket** switched on (off by default, [Tickets](apps/tickets.md#hear-about-new-tickets))
raises one `tickets:ticket.created` item for each new ticket, for the holders of `tickets:inboxes:admin`. It
belongs to the tickets tasks and knowledge group, so by default it reaches the feed and the email digest, not
the phone or the computer. To be interrupted, a person switches phone and computer on for that row, which also
turns them on for everything else in the group, such as another app's new orders. It is not urgent, so quiet
hours apply, and many at once reach the person as one summary.

## The router

`apps/api/src/modules/notifications/router.ts` decides the channels for one item and one person, and
every producer sends only through its decision (`RouterDecision`): the attention translator, the state
materializer (items computed from live data, routed the first time a person sees them), the digest,
push, the desktop emitter, the mail producer and `notify_user`. Its rules, in order:

- a per-app rule (Settings, Notifications, What each app sends) switched off silences the item on every
  channel, the feed included; mentions and system alerts cannot be silenced this way;
- mute means mute: a muted conversation, or a kind set to **Off**, is silenced on the phone, the
  computer and email, the urgent email included, whatever its group: a direct conversation, an
  @mention and an approval too. The item still lands in the feed, unread but quiet, and does not count
  toward the badge (`thread_muted`, `kind_muted`). An archived conversation quiets its channel posts
  only: a direct message or an @mention there still interrupts;
- a grid cell switched off silences that channel; a channel you opted into every post uses the direct
  messages cells for phone and computer;
- an incident reaches the phone and the computer only of the people on call; everyone else who can see
  it gets it in the feed and the digest, never as an urgent email (`not_on_call`);
- in quiet hours, phone and computer notifications are suppressed, not delayed: they stay in the feed
  and nothing replays them when the window opens; email waits for the next window, urgent email
  included. Only a critical incident for a person on call comes through;
- a message in the conversation you are in right now (on screen in a focused window or the phone app,
  or where you just posted or typed while a window of yours still has the focus) does not reach your
  phone or computer; your agent's finished answer and an approval it raised count only the conversation
  on screen;
- push needs a registered phone.

Critical monitoring incidents carry urgency 90, so they are urgent and come through quiet hours for the
people on call (unless the person switched the cell off). Warnings carry 60: during quiet hours they are
suppressed on phone and computer, not delayed, and stay in the feed.

## Mute

Muting silences on every channel. Two mutes exist:

- a conversation: **Mute** in its menu (`PATCH /api/threads/:id/state` with `isMuted`), or ask your
  agent (`thread_mute_set`);
- a kind: set it to **Off** under **How each kind reaches you** in Settings, Notifications. It is stored
  as `mutedGroups` in `kernel.user_preferences.notification_channels` and set with `PATCH
  /api/notifications/settings` and `mutedGroups: { <group>: true }`.

Either way the phone, the computer, the email digest and the urgent email stay silent. The item still
shows in the feed, unread, marked quiet (`metadata.quiet` on its `kernel.attention_events` row): the
badge and the digest skip it. A reply in a muted conversation gets its quiet row too.

Archiving a conversation is not muting it: its channel posts become quiet rows, but a direct message
or an @mention in it still interrupts.

## Quiet hours

Quiet hours are on for everyone by default: from 20:00 to 08:00 Monday to Friday and all of Saturday
and Sunday, until you set your own. They are the time outside your work hours (Settings, Notifications,
**Work hours**); saving work hours replaces the default. During quiet hours nothing interrupts you: no
phone notification or sound, no computer notification. Everything still lands in the feed and on the
badge, and email waits for the morning. Only a critical incident for the people on call comes through.

Quiet hours follow your time zone: the one you set (Settings, Notifications or your profile), or the
one your browser or the desktop or phone app reports at sign-in, which fills in a zone you never set
and never replaces one you chose (`PATCH /api/notifications/settings` with `detectedTimezone`).
Without one, your organization's, once an admin set it. Liaison never guesses: until a time zone is
known, the default quiet hours do not start and you are notified at any time, and the settings page
says so. Work hours you set yourself apply in the time zone you chose. Setting only a time zone keeps
the default window. A server can turn the default off with `NOTIFICATIONS_DEFAULT_QUIET_HOURS=off`:
people who never set work hours are then notified at any time.

## On call

Incidents and critical alerts interrupt only the people on call; everyone else who can see them gets
them in the feed. Until an admin picks people, the admins (holders of `kernel:org:admin`) are on call.
An admin picks the on-call people under **On call** in Settings, Notifications (`PUT
/api/notifications/on-call` with `userIds`, stored as `notificationsOnCall` in
`kernel.organizations.settings`); an empty list puts the admins back on call. Everyone can see the
list (`GET /api/notifications/on-call`). An organization with no list and no admin puts everyone who
can see incidents on call, as before, and the server logs a warning.

## Settings, Notifications

The one place to tune it all:

- **How each kind reaches you**: each group set to **Interrupt** (computer and phone), **Inbox only**
  or **Off** (muted);
- the grid, for the detail per channel, the email digest and approval reminders;
- **Work hours**, the days and the time zone: outside them are your quiet hours;
- **Muted conversations**, each with **Unmute**, and **Channels that notify you of every message**,
  each with **Mentions only** (`GET /api/notifications/conversations`);
- **On call**: who incidents interrupt; an admin edits it;
- what each app sends, your devices and this device.

Chat messages push from the message itself; everything else pushes from its attention row, so one event
never pushes twice. The lines an approval or access request writes into its conversation ("Approval request
request-N opened.", "Denied by X") are not chat messages: they never push as a reply or a mention.
The approvals row carries them (a pending approval to the people who can decide it, a decision or an
expiry to the requester), so they follow the approvals cells and quiet time, and nobody is told of a
decision they made themselves.

## Many at once: one summary

When a lot arrives for you at the same moment (an agent writing a note in 23 tasks in a minute),
your phone and computer do not get 23 notifications:

- the first 3 in a minute notify one by one, as usual;
- from the 4th, the rest wait, and you get one summary once things go quiet for 10 seconds (or a
  minute after the burst started, if it keeps going): "Ops Agent: 23 new messages in 23 tasks" when
  one person or agent sent most of them, "23 new messages in 4 conversations" otherwise, or "23 new
  notifications" when they are not all messages. The count includes the first 3;
- a newer summary replaces the previous one on the screen;
- every item stays in the app's feed, readable one by one. Email is not affected: the digest
  already groups everything in one mail.

A direct message, a mention of you, or an approval waiting for your decision still notifies on its
own and is not counted, unless it comes from the same person or agent as the burst (an agent that
mentions you in every note is one burst). An approval always notifies on its own. Right after a
summary, a single new message arrives as itself; a second one within the minute starts the next
summary. A summary of several conversations opens the app; a summary of one conversation opens it.

On the phone and the computer, notifications are also stacked by conversation (a task's discussion
is its own conversation), and a newer notification of a conversation replaces the older one there,
except a direct message, a mention or an approval, which keeps its own notification.
Nothing is lost: the feed has every message.

## Desktop

The server picks where a desktop notification shows: in every running desktop app of that person, or,
with none running, in the one browser tab they used last; never on a phone (push covers it). It is sent
once per item over the live connection and never replayed on reconnect. The desktop app raises native
OS notifications; clicking one brings Liaison to the front. A new message in the conversation you
are reading (open in the window that has the focus) does not notify; the same conversation left open
in a window behind other apps does.

Direct messages and mentions play the system's notification sound; other notifications are silent.
To turn the sound off, switch it off for Liaison in the system's notification settings.

The desktop app's icon shows the badge (see "The badge"): a badge on the dock (macOS) or the
launcher (Linux), and a small red overlay on the taskbar button (Windows), with the number up to 9
and a plain dot above. It goes away when nothing asks for you.

## New email

A Gmail message arriving in a personal mailbox (not a shared or support one, not IMAP), in the inbox,
unread, not in Promotions, Social, Updates or Forums, not from the account itself, and received in the
last 15 minutes, becomes one "New email from <sender>" item. The subject and body are never used: they
are encrypted. Messages written by the first import or a re-sync never notify. The item is in the feed
only by default; with new email switched on for the phone or the computer, several emails within two
minutes update one item, and each update alerts again, replacing the previous banner.

## Approval reminders

Each person also chooses how often their own agent reminds them of their requests still waiting for
a decision (`apps/api/src/modules/approvals/reminders.ts`): daily (the default, also for everyone who
never chose), every 3 days, weekly, or off. It is `approvalReminder` in the same
`notification_channels` column, stored only when it is not daily, and `approvalReminder` in
`GET`/`PATCH /api/notifications/settings`. The hourly sweep skips people who turned it off, and uses
each person's interval both as how long a request must wait and as how often they are reminded.

## Asking the agent

`notifications_get`, `notifications_set`, `notification_rules_set` and `thread_mute_set` let a person's
own agent read and change their settings in a conversation ("don't notify me on my phone for
tickets", "remind me weekly about my approvals"). They act only for the person in the conversation, never from a routine, a background run or
another agent; each change is audited and announced in the feed.

## Push setup, per server

A server sends iOS push only when all four are set (an unset or empty one disables iOS push and the
boot log names what is missing):

| env | value |
|-|-|
| `APNS_KEY_PATH` | path to the `.p8` token key inside the container; with the stock compose put it under `./data/apns/` and use `/var/lib/liaison/apns/AuthKey_<KEYID>.p8` |
| `APNS_KEY_ID` | the key id Apple shows for that key |
| `APNS_TEAM_ID` | the Apple developer team that owns the app |
| `APNS_BUNDLE_ID` | the app's bundle id, `sh.liaison.mobile` for the published app |

There is no sandbox switch. Each device token records its APNs environment when the app registers
it (`POST /api/push/tokens` with `environment`): an Xcode build reports `sandbox`, a TestFlight or App
Store build `production`, read from the app's provisioning profile by the app's own `LiaisonNative`
plugin. The sender picks the Apple host per token. If Apple answers `BadDeviceToken`, the sender tries
the other host once and, when that works, corrects the stored environment; a token is deleted only
when both hosts refuse it, or when Apple says it is unregistered.

The key, its id and the team belong to whoever publishes the app; a deployment only receives the
file and the four values from them.

Browser push (Web Push) needs all three of these; without them it stays off and the server logs one
warning at the first browser send:

| env | value |
|-|-|
| `VAPID_PUBLIC_KEY` | the public half of the server's VAPID key pair |
| `VAPID_PRIVATE_KEY` | the private half |
| `VAPID_SUBJECT` | a contact the push services can reach, `mailto:` or `https:` |

Generate the pair once per server with `bunx web-push generate-vapid-keys` and keep it: a new pair
invalidates every browser subscription made with the old one.

Android push needs `FCM_SERVICE_ACCOUNT_PATH` and `FCM_PROJECT_ID`, and a `google-services.json` in
the Android app; neither exists yet.

## What a push may say

`apps/api/src/modules/push/redact.ts`: a message carrying any required scope is pushed with no text
at all; only a message with no required scopes may carry a title and a short body. Every payload
carries the thread id, the deep link, the badge count and the server origin, so a tap on a
notification from another server than the one the app is set to is ignored. The origin is the server's `BASE_URL`: a phone set up with a different address for the same server (another hostname, an IP) opens the app on a tap but does not jump to the thread, so give people the `BASE_URL` address.

## A comment on a task

A message in a task's discussion (or in any conversation that belongs to a record, such as a
contact's discussion) is news of that record. Its push, its desktop notification and its row in
**Home** name the record, for example **Task: Fix the login page · Website**, and keep the writer's
name in the text. Opening it opens the task with that comment brought into view, not a bare
conversation. A message that carries required scopes still says nothing, but still opens the task.
If you can no longer see the task, it shows **Task not found**.

The record's name is only shown to people who can see the record themselves. Someone who is in the
conversation but cannot see the task (for example, someone @-mentioned into it without access to its
project) gets **New message in a thread** instead, and opening it opens the conversation. An
approval's thread is named after the approval, for example **Approval: Refund order 1042**.

## The badge

One badge, one meaning. The badge counts the unread things that ask for you, and shows the same
number on the phone's icon, the desktop app's icon, the browser tab title and Home:

- every unread message in a direct conversation (a direct message, a group direct message, a chat
  with an agent), unless you muted or archived it;
- an unread mention of you in a channel;
- an unread reply in a reply thread you follow;
- an approval you are asked to decide (another person's request they could approve themselves is
  left out, as Home folds it), an access request you can grant, a routine run waiting for your
  private mailbox, a computer session asking your permission;
- a critical alert (an app kind ending in `.critical`, such as a critical monitoring incident).

Channel messages that do not mention you, tickets, tasks, mail and the rest of Home are not counted;
Home shows a small dot when only those are waiting. The Messages entry keeps its own number: every
unread message in your conversations.

Every surface counts with one function (`countBadge`, `packages/shared/src/notifications/badge.ts`).
The server counts it for the phone (`computeBadgeCount`, `apps/api/src/modules/push/badge-count.ts`)
and answers it at `GET /api/notifications/badge`; the web app and the desktop app read that number
and follow your reads locally between two reads of it. The server reads at most 200 open approvals
per person for the badge, so past that the number stops rising; Home still lists every one.

## Read once, read everywhere

Reading something on any device clears it on the others.

- **Badge.** Each push carries the badge. After a read on any device, your iPhones also get a
  badge-only push a moment later (no banner, no sound; reads close together share one), so the icon
  drops without waiting for the next message. The same push follows the other things that lower the
  badge: someone else decides an approval you were asked to decide, a message of a direct
  conversation is deleted, you leave a conversation, an access request is granted or denied. It is
  never stored for a phone that is offline, so it cannot replace a real notification waiting there;
  the next notification carries the badge anyway.
- **Phone notifications.** Each push names the exact thing it announces: the message (a reply
  included), or the item (an approval, an alert, a session). Opening the app asks the server which of
  its notifications were read or resolved, on any device, and withdraws only those; the others stay,
  and the badge takes the server's number. A reply stays until its reply thread is read, even when
  its channel was. A notification the server cannot judge (a summary of several, or one from an
  older server) stays until you clear it. If the server cannot answer, nothing is removed.
- **Computer notifications.** A conversation read on any device takes its own notifications away in
  an open browser tab and from the browser's push notifications; a reply's notification goes when its
  reply thread is read.
- **What needs a new app version.** The badge, the badge-only push, the digest and the browser
  withdrawal work with the apps already installed. Withdrawing phone notifications when the app opens
  needs the phone app version that ships this change: an older phone app still clears everything when
  it opens. The desktop app does not withdraw its notifications from the system's notification center
  yet: that needs a later desktop app version, and until then they stay there until you clear them.
- **Reconnect.** A desktop app that reconnects gets the computer notifications of the last 15 minutes
  it missed, except what was read meanwhile.
- **Digest.** The digest email carries only what is still unread when it is sent. A row read before
  the send leaves the digest.
