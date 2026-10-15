# Embeddable Bob agent widget

`bob-agent-widget.js` is a dependency-free floating host widget. It creates a
launcher and panel inside a **closed shadow root**, so its styles and controls do
not collide with the host chatbot page. Guidance is always rendered with
`textContent` and labelled as untrusted review-only material.

## Browser usage

```html
<script src="/integrations/widget/bob-agent-widget.js"></script>
<script>
  const bob = BobAgentWidget.create({
    source: "my-host-chatbot",
    conversationId: "conversation-123",
    context: {
      scope: "demo",
      project: { projectName: "Task tracker", objective: "Keep tasks easy to verify" }
    },
    messages: [{ role: "assistant", text: "What are you building?" }],
    requestGuidance(payload) {
      // Call the host's own trusted server boundary here. Keep all credentials
      // on that server; this browser callback receives no Bob/provider secret.
      return fetch("/your-host-guidance-route", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      }).then((response) => response.json());
    }
  });

  bob.addMessage({ role: "user", text: "I want to add a task form." });
  bob.setContext({ scope: "review", projectName: "Task tracker" });
  bob.ask("What should I verify first?");
  bob.open();
  // bob.close();
  // bob.destroy();
</script>
```

The returned bridge exposes only `addMessage`, `setContext`, `ask`, `open`,
`close`, and `destroy`. `requestGuidance(payload)` is the host-supplied
boundary. The widget has no network client, shared Bob secret, or OpenRouter
key. The payload contains bounded context, messages, and the current question;
the host remains responsible for authentication, consent, and server-side
provider credentials.

If `requestGuidance` is missing, the panel shows a clear configuration state and
does not attempt a request. The guidance view supports both the generic adapter
shape (`nextAction`, `verification`) and the Chatbase-compatible aliases
(`nextStep`, `verificationNeeded`). It shows Reply, Next action, Lesson,
Clarification, and Verification cards for every response, including empty
sections.

## Browser smoke demo

Open `demo.html` from a local static server (for example, `npx serve .` from
this directory) and use the lower-right **Ask Bob** launcher. The page simulates
a host chatbot and uses a local delayed mock response, so no server or provider
credentials are required. Opening the file directly also works in browsers that
allow local scripts.
