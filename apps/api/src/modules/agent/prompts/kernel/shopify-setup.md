---
name: shopify-setup
type: skill
description: Create the store's Shopify app in the Dev Dashboard (or the Shopify CLI), then connect the store.
---

### Setting up Shopify

The steps, their pages and their values come from the setup definitions, never from memory: call `kernel__shopify_setup` (the Dev Dashboard, in the browser) or, if the person prefers the Shopify CLI, `kernel__shopify_app_toml` (it posts the app configuration file for this server and returns the CLI steps). The Shopify app must be on first (`kernel__config_apps`). Never edit the scopes or URLs of the file by hand: they must match what Liaison asks for.

**When a client exists** (`values.clientSource` `instance`: this server provides the Shopify app; `org`: the workspace already has its own), there is nothing to create. Do not mention the Dev Dashboard; post the Connect card (`kernel__request_secret` kind `oauth_connect`, app `shopify`, connection `shop`): the person enters their store's domain and approves. Only if they ask to use their own Shopify app, its client ID and secret go through `kernel__request_secret`: the workspace's own app then replaces the server's.

**Otherwise** walk `guide.steps` in order, one step per message, and follow `nextStep`. Say in one sentence why each step exists, give its pages (`links`) and its values in full, exactly, and wait for each to be done. Never write "the required scopes" instead of the values.
- A step with `who: "agent"` is yours: do it with the tool or command in its values (the person approves the card), never ask the person to switch a setting by hand.
- A step with `place: "own"` happens in the person's own terminal. An interactive login (the CLI's sign-in) is run by the person, never by you: give the command and what to choose at each prompt, then wait for "done".
- Step `distribution` gets a message of its own: the choice is permanent. Ask for the client ID and secret only once they say the app is installed, with `kernel__request_secret` kind `oauth_client` (app `shopify`, connection `shop`), never in the chat.

### Full order history

Without the `read_all_orders` grant Liaison sees only the store's last 60 days of orders. Drive it to the end:

- After the store connects, `kernel__setup_state` lists `missingProtectedScopes` on the Shopify connection while its grant lacks it. Follow the guide's `fullOrderHistory` step (with the answer to paste) for the request, and tell the person to tell you once Shopify approves.
- The app uses Shopify-managed installation: a store gets exactly the scopes of the app's released configuration, whatever the connect asks for. A reconnect alone never adds a scope the configuration lacks.
- When it is approved: do the `fullOrderHistorySetting` step. On the Shopify CLI path, call `kernel__shopify_app_toml` again (the file now lists `read_all_orders`) and have them replace the file and run `shopify app deploy`; on the Dev Dashboard path, have them add `read_all_orders` back to the Scopes and click Release if they took it out. Then post the Connect card again (`kernel__request_secret` kind `oauth_connect`, app `shopify`, connection `shop`, mode `org`) so they reconnect and approve.
- Never say it is granted until `kernel__setup_state` no longer lists it: Shopify's grant on reconnect is the only proof. If Shopify refuses the release (`shopify app deploy` or Release) because of `read_all_orders`, the approval is not through yet: turn the setting back off the same way (the value `false`), hand the file again without it, and pick it up once they confirm the approval.
- When the server provides the Shopify app (`clientSource: instance`), the request is the server operator's to make, not the person's.

Webhook subscriptions are not part of the app's setup; Liaison creates them when the store connects.
