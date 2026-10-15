# Embed Bob as a floating review agent

[`../widget/bob-agent-widget.js`](../widget/bob-agent-widget.js) is a
dependency-free floating widget for an authorized chatbot host. It owns only
the launcher, panel, bounded display state, and review-only presentation. It
does not discover a transcript, listen to Chatbase internals, call Bob
directly, or hold a shared provider credential.

## Host bridge

The host creates the widget with context and a server-proxy callback, then
keeps host events synchronized through the returned bridge:

```js
const bob = BobAgentWidget.create({
  source: "my-host-chatbot",
  conversationId: hostConversation.id,
  context: {
    scope: "demo",
    project: { projectName: "Task tracker", objective: "Keep tasks verifiable" }
  },
  messages: hostConversation.recentMessages,
  requestGuidance(payload) {
    // This is the host's same-origin route, never Bob/OpenRouter directly.
    return fetch("/api/bob/guidance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).then(response => response.json());
  }
});

hostEvents.on("user_message", event => {
  bob.addMessage({ role: "user", text: event.text });
});

hostEvents.on("assistant_message", event => {
  bob.addMessage({ role: "assistant", text: event.text });
});

hostEvents.on("context_changed", event => {
  bob.setContext(event.context);
});
```

The returned bridge exposes `addMessage`, `setContext`, `ask`, `open`,
`close`, and `destroy`. `requestGuidance(payload)` is the host-supplied
boundary; it is not a widget network method. The host decides which events
are meaningful (usually user/assistant messages, approved context changes, or
an explicit “Ask Bob” action). Do not forward every UI event or claim that a
partial message list is a full transcript.

The widget accepts both the generic response shape (`nextAction`,
`verification`) and Chatbase aliases (`nextStep`, `verificationNeeded`). Every
response field is displayed as untrusted review-only guidance. A human must
run suggested checks; Bob's output is not proof of code, tests, security, or
deployment readiness.

## Missing request state

`requestGuidance` is optional at creation time. If it is absent, the widget
shows a configuration error and `ask()` returns without making a request. A
host can therefore mount the launcher before its authenticated proxy is ready,
then create a new widget or provide the callback according to its own
lifecycle. Optional response sections may also be absent; the widget keeps
those sections visibly empty rather than inventing guidance.

## Server-side proxy

The browser must call a same-origin host route or another authenticated proxy.
That proxy should:

1. Authenticate the host user/session and apply the host's consent policy.
2. Build an allowlisted request with a stable `source` and
   `conversationId`, the latest `userMessage`, and only approved project and
   message fields.
3. Send the request server-to-server to Bob with
   `x-bob-integration-secret` from server environment configuration.
4. Return Bob's `status`/`data` response without exposing the shared secret or
   an OpenRouter key to the browser.

For a provider-neutral host, use `POST /v1/integrations/mentor`:

```json
{
  "source": "custom-host",
  "conversationId": "session-42",
  "consent": true,
  "userMessage": "What should I verify next?",
  "messages": [
    { "role": "user", "text": "Goal: Build a task tracker." }
  ],
  "project": { "objective": "Keep personal data server-side" },
  "capabilities": ["review"]
}
```

The generic adapter accepts at most 40 messages and 1,800 characters per
message. It rejects unknown fields, requires consent and a conversation ID,
and enforces a bounded context size. The widget itself also bounds messages to
40 entries and 2,000 characters before calling the host callback. Apply an
equal or stricter limit in the host proxy before the request leaves the
browser. If no transcript fields are configured, send only the latest user
message; never describe that as the full conversation.

## Chatbase / Server Custom Action

Chatbase is the context and event owner. Configure a **Server Custom Action**
for the event that should ask Bob (usually a user message or an explicit
button/action), then declare only the inputs Chatbase is allowed to provide:

- `agentId` and a stable `conversationId` from the action context;
- the latest `userMessage` and `consent: true`;
- optional bounded `messages` and project fields selected in the action.

Chatbase sends those action inputs to a trusted Bob endpoint. Put the
integration header on the server action or a trusted reverse proxy. Do not
put it in a Chatbase client action, the floating widget, HTML, or bundled
JavaScript. If the Chatbase action does not provide messages, Bob receives no
transcript beyond the explicit user message.

For inline UI, map the returned `data.reply`, `nextStep`, `lesson`, and
`verificationNeeded` fields into the supported Server with UI (Widget)
surface, or provide the response to the floating widget's host callback.
Chatbase does not need an undocumented assistant-message injection API: the
custom action owns the request and the widget owns the display.

See [`../chatbase/README.md`](../chatbase/README.md) for the Chatbase endpoint,
request/response examples, shared-secret setup, and failure cases. See
[`../generic/README.md`](../generic/README.md) for the provider-neutral
server-to-server contract. The bundled demo is available from the local
workspace server at `http://127.0.0.1:4173/widget-demo.html`; its host uses a
mock callback so it never needs a provider key.
