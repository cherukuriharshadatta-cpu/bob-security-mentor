# Add Bob to a Chatbase agent

Bob integrates with Chatbase through a **Server Custom Action**. This keeps Bob
as a mentor service called by Chatbase; it does not pretend to be a second
Chatbase agent or inject an undocumented assistant message into the widget.

## Endpoint

```text
POST https://YOUR_BOB_HOST/v1/integrations/chatbase/mentor
Content-Type: application/json
x-bob-integration-secret: YOUR_SHARED_SECRET
```

Configure the same secret in Bob's server environment:

```powershell
$env:BOB_CHATBASE_SHARED_SECRET = "a-long-random-secret"
$env:OPENROUTER_API_KEY = "your-server-side-key"
$env:OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"
```

Never place either secret in a browser widget, Chatbase client action, source
repository, or committed JSON file. Put the endpoint behind HTTPS and an
authenticated deployment boundary before exposing it to Chatbase.

## Request contract

The adapter accepts declared custom-action inputs in either the top-level body
or an allowlisted `inputs` object:

```json
{
  "source": "chatbase",
  "agentId": "your-chatbase-agent-id",
  "conversationId": "conversation-id-from-your-action-context",
  "userId": "optional-user-id",
  "consent": true,
  "userMessage": "What should I verify before sharing this project?",
  "messages": [
    { "role": "user", "text": "Goal: Build a task tracker." },
    { "role": "assistant", "text": "Start with the task model." }
  ],
  "project": {
    "projectName": "Task tracker",
    "objective": "Keep personal data server-side"
  },
  "scope": "demo"
}
```

`messages` is optional because Chatbase custom actions only receive the fields
configured for that action. Do not claim Bob has the full transcript unless the
Chatbase configuration actually supplies it. `conversationId` is required to
keep Bob's context boundary explicit; do not use one shared fallback ID.

The adapter requires `consent: true` because the user message and any supplied
context leave Chatbase and may be sent to OpenRouter. The server bounds fields,
redacts obvious secrets before provider forwarding, and rejects unsupported
model assurance claims.

## Response contract

The endpoint returns a Chatbase-friendly JSON object:

```json
{
  "status": "success",
  "data": {
    "contractVersion": "agent-analysis.v1",
    "reply": "...",
    "nextStep": { "text": "...", "reason": "...", "untrusted": true },
    "lesson": { "title": "...", "text": "...", "untrusted": true },
    "clarification": { "question": "...", "reason": "...", "untrusted": true },
    "verificationNeeded": [],
    "limitations": [],
    "untrusted": true
  }
}
```

Use `reply` and `nextStep` in the Chatbase action's response. If using a
Server with UI (Widget) action, render `lesson`, `clarification`, and
`verificationNeeded` as review cards. Keep the `untrusted` label visible.

## Chatbase configuration

1. Create a Server Custom Action named something like `Ask_Bob_Mentor`.
2. Declare the action inputs for `agentId`, `conversationId`, `userMessage`,
   `consent`, and any optional project fields you want to send.
3. Point the action at the HTTPS Bob endpoint above.
4. Configure the integration secret as a server-side action header or through
   a trusted reverse proxy. Do not put it in client-side JavaScript.
5. If you need inline cards, choose Server with UI (Widget) and map Bob's
   response fields to the supported Chatbase widget primitives.
6. Test with synthetic content first. Verify that an absent consent flag,
   missing conversation ID, wrong secret, and provider outage fail safely.

Chatbase does not provide a documented generic assistant-message injection
mechanism here. Bob's result should be consumed by the custom action or shown
as a widget, not written into the conversation through an undocumented API.

## Generic host-side display card

`bob-mentor-card.js` is a dependency-free display helper for a host page or a
Chatbase-supported widget surface. It performs no network request and contains
no credential. Your trusted server or custom action must provide the already
validated response to it.

For a floating host integration, see
[`../embeddable/README.md`](../embeddable/README.md). It documents how the host
owns context/events and proxies requests server-side; the browser card remains
render-only.
