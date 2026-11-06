---
title: Choose a model
description: "Pick the model an agent, conversation or routine runs on, add your own provider keys or server, and set reasoning level and Auto."
---

Every agent turn runs on a model. This page shows how a member picks one, and how an administrator decides which models the organization can use, with its own provider keys (bring your own key), OpenRouter, or its own server.

## Pick a model

Four places set a model. The most specific one wins.

| Where | How | Applies to |
| --- | --- | --- |
| A routine | **Agent model** on the routine | Every run of that routine. See [Schedule routines](../agents/routines.md). |
| A conversation | The model button in the composer | Messages in that conversation. |
| An agent | **Model** on the agent's **Settings** tab (administrators) | Conversations that do not name a model. |
| Auto | The organization's **Auto** setting | Everything left on **Auto**. |

If an agent's own model belongs to a provider the organization has no key for, the agent falls back to Auto, which picks among the providers the organization can use.

### Choose a model in a conversation

1. Click the model name in the composer.
2. Pick a model from the list. **Auto** is the first entry.
3. For a model that can think before answering, a **Reasoning** row appears under the list. Choose **Off**, **Low**, **Medium** or **High**.

A model that cannot switch reasoning off has no **Off**. A model without reasoning hides the row. The level is remembered per model in that conversation.

When neither the conversation nor the routine sets a level, the organization's **Default reasoning level** applies (see below). Without one, a model runs at its own default, which is **Off** for a model that can switch reasoning off.

A turn on **Auto** runs at the organization's **Default reasoning level** if one is set, otherwise at **High**, or the nearest level the model accepts. On the public demo, a confirmed visitor's **Auto** runs at **Low** on the demo's own key, so answers come quickly. On **Auto** the **Reasoning** row shows that level alone, marked **Set by Auto**, and cannot be changed (a model without reasoning shows **Off**). The level you choose applies when you picked the model yourself.

In the desktop app the menu can also show **Local models** (**Your Claude Code login**, for a conversation that runs on **This machine**) and **Models on** a computer's name (for a conversation that runs on **My computer**). Those are models the machine itself offers. See [Run work on your computer](../computers/run-work.md).

If the organization switched a model off, anything set to it moves to Auto on its next turn.

## Decide which models the organization can use

You need `kernel:org:admin`.

An agent or an MCP client makes the same changes with the `ai_models_get` and `ai_models_set` tools. A change through `ai_models_set` waits for approval.

1. Open **Settings › Models**. The page is titled **AI models**.
2. Under **Auto**, choose what **Auto runs**. The default option is the cheapest model with a key.
3. Under **Default reasoning level**, choose the **Reasoning level** for turns that set none: **Off**, **Low**, **Medium** or **High**. It applies to conversations, routines, agents and sub-agents without their own level, and to **Auto**. A level set on a conversation or routine still wins. A model that cannot run the chosen level runs at its own default (a model that cannot switch reasoning off never runs **Off**). **Built-in default** clears the setting.
4. Under **Models switched on**, use the switch on each row to turn a model on or off. Every picker in the product lists exactly these models, for members, agents and routines.
5. The table shows the **Model**, the price **In / out per M** tokens, the **Context** size and chips: **tools**, **no tools**, **reasoning** and **Auto**.

Auto cannot run a model that is switched off or has no key. The page then says which model Auto runs instead. To switch off the model Auto runs, first pick another model for Auto.

## Bring your own key

An organization can use its own account with each provider. Supported providers are Anthropic, OpenAI, Google, Mistral and OpenRouter.

1. Open **Settings › Models**.
2. Under **Providers**, find the provider. A provider without a usable key reads **Provider: add an API key**.
3. Click **Configure**, paste the **API key** and click **Save**. Liaison checks the key with the provider before it stores it, and refuses an invalid one.
4. The row then reads **Connected** with the last six characters of the key as a hint and **Last checked**. Click **Re-check** to test it again, or **Remove** and **Confirm** to delete it.

Keys are stored encrypted. A self-hosted instance needs `BYOK_ENCRYPTION_KEY` (64 hexadecimal characters, 32 bytes), which is required in production. If a key has been removed but a model still depends on it, the model shows **Key removed, not used**.

An instance operator can also set deployment-wide keys with the environment variables `LIAISON_ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` and `MISTRAL_API_KEY`. They apply when an organization has not added its own key, and show as **Deployment key**. See the [environment reference](../reference/env.md). `LIAISON_ANTHROPIC_CACHE_TTL` sets how long Anthropic prompt-cache entries last: `1h` (the default) or `5m`.

## Add models from OpenRouter

OpenRouter gives access to many models with one key.

1. Add an OpenRouter key under **Providers**, as above. Without it the catalogue is empty and says to add one first.
2. Click **Add from OpenRouter**.
3. Type in **Search OpenRouter models**. **Tool calling only** is on by default, because agents need tool calling to act. Without it a model can only answer.
4. Click **Switch on** next to a model. Liaison makes a test call, then adds it.

A model with no fixed price cannot be added, because OpenRouter prices it per request. OpenRouter requests only go to providers that neither store nor train on your data and that support tool calls. A new conversation starts with the provider that is cheapest for cached input, and providers whose cached input is not at least half price are skipped. Each conversation then stays with the provider that answered its first request, so its prompt cache keeps working. It moves to another provider only when that one is down, failing or rate-limited, and then stays with the next cheapest one. A blocked provider never serves a request (see below).

Liaison also times every agent step: how long the provider took to send its first token, and how many tokens per second it wrote. A provider whose median over its recent steps is slower than 2.5 seconds to the first token, or under 50 tokens per second, is tried last for new conversations, so a conversation starts with the cheapest provider that is fast enough. A provider with fewer than 5 timed steps is not judged yet. A conversation already on a provider stays there while it is merely slow, because moving re-reads the whole conversation without the cache; it moves only when its provider is at least twice that slow. A self-hosting operator changes these limits with `OPENROUTER_HOST_MAX_TTFT_MS`, `OPENROUTER_HOST_MIN_TOKENS_PER_SECOND` (0 turns the speed limit off) and `OPENROUTER_HOST_SPEED_MIN_SAMPLES`.

If OpenRouter cannot be reached, models already added keep working.

## Block an OpenRouter host

OpenRouter serves a model from several providers (hosts). **Blocked hosts**, on the **Models** page under **Providers**, lists the hosts OpenRouter never sends your organization's requests to. A conversation that was on a host you block moves to another one at its next request.

1. Type the host's name in **Host name**, as OpenRouter names it (for example `OpenInference`), and click **Block**. Case does not matter.
2. To unblock a host, click the **×** on its chip.
3. **Reset to default** goes back to the server's list.

Until you change it, the list is the server's default (`OpenInference`, set by the operator with `LIAISON_OPENROUTER_IGNORE_HOSTS`, see [Docker](../self-hosting/docker.md)). Once you change it, your list replaces the default; an empty list blocks no host. You can block up to 20 hosts. Only an administrator can change the list.

## Use your own model server

You can point Liaison at any server with an OpenAI-compatible address, such as Ollama, vLLM, LM Studio or llama.cpp.

1. Click **Add your own server**.
2. Enter the **Server address**, an optional **Key (optional)**, the **Model name** and the **Context window (tokens)**.
3. Click **Test and add**.
4. The result says either **Answered, and the tool call returned correctly**, or **Answered, but no tool call came back: this model can answer, not act.**

Your own server has no prices, so usage shows tokens only. Use **Remove server** to delete a server and its models. Addresses on link-local or metadata ranges are always refused. A server on a private or loopback address is accepted only when the operator sets `LIAISON_ALLOW_PRIVATE_MODEL_SERVERS=true`.

## Voice dictation model

Below the model list, **Voice dictation** sets the model that turns dictated speech into text in every composer. It needs an OpenRouter or Google AI key. Until one is added the microphone is not shown.

## Long conversations

An agent sends a conversation's earlier messages with every turn. Once they pass a size, it summarises the older part and keeps the newest messages word for word. Below **Voice dictation**, **Conversation history** sets that size for the whole organization.

- **Summarise conversation history after** is in thousands of tokens. The default is 256. The lowest is 32.
- A higher value keeps more of a conversation word for word and resets the prompt cache less often, but each turn carries more tokens.
- A model with a smaller context window uses less, so the conversation and its tools still fit.
- After a summary the next one waits until the conversation has grown by half that size again.

**Summarise idle conversations while the cache is warm** (on by default) summarises a long conversation shortly before the provider's prompt cache expires, when nobody has written in it since. The summary reuses the cached conversation, so it costs little, and the next message starts from a short conversation instead of re-reading the whole one. It runs on OpenRouter models and only for conversations above about 32,000 tokens. A new message before then cancels it.

A self-hosting operator sets the default size with `AGENT_HISTORY_BUDGET_TOKENS` and the cache lifetime assumed for an OpenRouter host with `AGENT_PROMPT_CACHE_TTL_S`. See [Environment variables](../reference/env.md).

## Models on your computer

Work that runs on your own computer uses the Claude models that computer's Claude sign-in offers, not the organization's keys. A routine's **Model** under **Runs on** and the **Model** in a new session are chosen from that list. A session also has a reasoning effort: **Low**, **Medium**, **High**, **Extra high** or **Max**. See [Sessions](../computers/sessions.md).

## Next steps

- [Create an agent](../agents/create-an-agent.md)
- [Tools agents can use](../agents/tools.md)
- [Admin settings](../admin/settings.md)
