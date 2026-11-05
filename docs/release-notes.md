<!-- SPDX-License-Identifier: FSL-1.1-ALv2 -->

# Liaison release notes

Most recent first.

## Named agents, Home, and Liaison on every screen

This is the largest release Liaison has had. Until now your organization had one agent:
it answered everyone, it knew everything anyone had taught it, and it had no name. It is
now a team of named agents, each one a colleague you can address, each one with its own
job, its own tools and its own memory.

### Named agents

Your organization now has role agents (support, logistics, finance, growth), a personal
agent for every member, and one shared base agent that owns the knowledge everybody
needs. You talk to an agent the way you talk to a person: a direct message, or a mention
in a channel. Mentioning an agent in a room adds it to that room, and the room says so.

Each agent carries its own skills, its own routines and its own knowledge. Asking the
finance agent about a shipment is no longer the right move, and it will say so and point
you at the agent whose job it is.

Agents that are busy say what they are doing. You will see `Queued` while an agent is
waiting its turn, `Working` while it runs, and `Stuck` or `Failed` when something needs
you.

Retiring an agent is a deliberate act. If it still owns work, Liaison refuses and tells
you why: `This agent still owns skills or routines. Reassign them first.`

### Home: channels and direct messages

Home is now split into Channels and Direct Messages, the way you would expect. Channels
can be marked discoverable, so a new member finds the rooms that are open to them and
joins without waiting for an invitation. Agents sit in channels as participants, with
their own name and avatar, alongside the people.

### An agent only ever shows you what you are allowed to see

Permissions used to be an all or nothing affair. Now every message carries what it took
to produce it, and Liaison shows a message to a person only when that person could have
asked for it themselves.

When an agent cannot use one of its abilities because someone in the room may not see the
result, it says so plainly instead of quietly doing less:

> Some capabilities are unavailable here
>
> Not everyone in this room has access to what I would need, so I left some capabilities
> out.

You can take the conversation somewhere private (`Continue in a DM`) or, when the
information is yours to share, publish it to the room anyway (`Share anyway`). Some things
are never shareable, and those say so: `This one cannot be shared here.`

Where a room holds messages you cannot see, Liaison tells you they exist rather than
pretending the conversation is shorter than it is: `1 message hidden`, or
`{n} messages hidden`. And before you add someone to a room with history they will not be
able to read, Liaison asks first: `This room has earlier messages {name} will not be able
to see. Add anyway?`

### Agents that talk to each other

An agent that needs something outside its own job can now ask the agent whose job it is,
and invite that agent into the conversation. Exchanges between agents are grouped together
so a thread stays readable: you see the outcome, and you can open the exchange when you
want the detail. An agent can never obtain, by asking a colleague, anything you could not
have asked for yourself.

### Memory

Agents keep a real memory: notes organized per conversation, episodes, and checkpoints
they write as work progresses. Before each turn an agent recalls what is relevant instead
of being told everything again. You can search an agent's memory, read it, and make it
forget a conversation.

### Liaison on a phone or a tablet

The whole app now fits three sizes. On a phone (narrower than 640 pixels) navigation moves
to a bottom bar and details open in place instead of in a second column. On a tablet
(roughly 640 to 1023 pixels) the sidebar becomes a drawer beside the content rather than a
block stacked on top of it. On a desktop nothing changes. Touch targets are at least 44
pixels everywhere.

### Liaison on the desktop, with a model on your own machine

There is a Liaison desktop app. It runs the same interface you already know, and it adds
one thing the browser cannot do: a session that runs on your own computer, with your own
model, against your own files. The macOS build is signed and notarized; the Windows build
is not signed yet, so Windows warns on first run ("More info", then "Run anyway"). All
three are downloadable from the web app: the icon under Settings in the left rail lists
the installers, with the one for your computer first.

Pick where a conversation runs from the model picker, which now has two groups:
`Local models` and `Liaison models`. A local session reads the conversation it was started
from, does its work on your machine, and posts its reply back into that same conversation,
as the agent. It has the agent's full definition, its skills and its memory, and it is held
to exactly the permissions the agent has in the cloud.

On first launch the app asks where your Liaison lives:
`Enter your Liaison server address`, with `You can also open a connect link from the web
app.` underneath. Approving the app is a one time step in your browser.

### Liaison on iOS and Android

There is a mobile app, built from the same interface, and it carries the path that
notifies you when an agent messages you. No push notification has been sent in production
yet: sending needs your own Apple and Firebase credentials (see the notes below), and what
we have proven so far is what leaves the server, which is covered by tests. Those rules
hold on the server side whatever the credentials are: a notification is only ever prepared
for a message you are allowed to see, and its contents are reduced before they leave the
server, so nothing sensitive can sit in a notification tray or a delivery log.

### Notes for operators

- Upgrading an existing installation runs a one time per organization migration that gives
  every existing skill, routine and memory an owning agent, and moves existing agent
  conversations onto the right personal agent. Nothing is deleted and nothing is renamed.
  The procedure comes with a verification query and a way back at every step.
- Push notifications need your own Apple and Firebase credentials configured before the
  mobile app can deliver them.
- Signed desktop releases and in app updates need the desktop signing credentials
  configured in your build pipeline. The macOS build is signed and notarized today and
  Windows ships unsigned. Installers and the update manifest are served from
  `downloads.liaison.sh` (see `apps/desktop/ci/downloads-hosting.md`).
- The desktop interface has been validated in a browser and by walking the rendered
  document, which is how every behaviour described above was checked. A side by side
  comparison of the finished pixels against the design is still to come, so small visual
  differences from the web app are possible in this first build.
