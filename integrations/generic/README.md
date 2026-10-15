# Bob generic integration contract

Bob's guidance is provider-neutral: an integration supplies a bounded question
and optional project context, then consumes review-only guidance. Use the generic
server-to-server endpoint:

```text
POST /v1/integrations/mentor
Content-Type: application/json
x-bob-integration-secret: YOUR_SHARED_SECRET
```

Set the same secret in `BOB_GENERIC_SHARED_SECRET`. The request requires a
`source`, `conversationId`, `userMessage`, and `consent: true`; bounded
`messages`, `project`, `scope`, `userId`, and `capabilities` are optional.

The endpoint normalizes this envelope to the standalone `agent-analysis.v1`
guidance contract without exposing the selected model provider to the caller.

An integration adapter may normalize its own action fields to that contract.
It must require a stable conversation identifier and explicit consent, reject
unknown or oversized fields, and authenticate server-to-server calls with a
shared secret kept out of browser code. The secret and provider credentials
must never be copied into the provider payload.

Successful adapter responses use this provider-neutral envelope:

```json
{
  "status": "success",
  "data": {
    "contractVersion": "agent-analysis.v1",
    "source": "custom-host",
    "conversationId": "conversation-123",
    "reply": "...",
    "nextAction": { "text": "...", "reason": "...", "untrusted": true },
    "lesson": { "title": "...", "text": "...", "untrusted": true },
    "clarification": { "question": "...", "reason": "...", "untrusted": true },
    "verification": { "suggestions": [], "limitations": [], "untrusted": true },
    "untrusted": true
  }
}
```

Every model-derived field is untrusted guidance. Hosts should display it as a
suggestion and retain human verification boundaries; it is not evidence that
code, tests, security, deployment, or readiness has been proved.
