# Bob cloud mentor backend

This directory contains the dependency-free Node 20+ backend for the hackathon cloud mode:

```text
Bob extension -> this backend -> OpenRouter -> selected model
```

The backend keeps the OpenRouter credential server-side. It does not write request data, prompts, provider responses, or conversations to disk, and it has no request logging. Secret redaction is local and best-effort; it must not be treated as a complete secret scanner.

## Run

From the repository root, set environment variables using the shell's normal environment mechanism. Do not commit a real key.

PowerShell:

```powershell
$env:OPENROUTER_API_KEY = "your-server-side-key"
$env:BOB_PORT = "8787"
$env:OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"
node server/openrouter-proxy.mjs
```

The process binds to `127.0.0.1` by default. `BOB_PORT` defaults to `8787`; port `0` is accepted for an ephemeral test listener. `OPENROUTER_MODEL` defaults to the current Nemotron free candidate shown above and can be changed without editing source. `OPENROUTER_API_KEY` is only required when handling a model request, so `/health` remains useful before configuration.

The persisted standalone workspace uses the same provider variables but a separate listener: `BOB_WEB_PORT` defaults to `4173`, and `BOB_DATA_DIR` optionally selects the local persistence directory (default `.bob`). Run `node server/workspace-server.mjs` from the repository root for the workspace UI. The workspace `GET /health` response is the same safe availability/model report described below.

No `npm install`, package manager, `.env` loader, or build step is required. `server/.env.example` documents the variables but is not read automatically.

## API

### `GET /health`

Returns a minimal no-store response without a credential:

```json
{"ok":true,"providerConfigured":false,"model":"nvidia/nemotron-3-super-120b-a12b:free"}
```

`providerConfigured` is a boolean derived from whether `OPENROUTER_API_KEY` is present. `model` is the configured `OPENROUTER_MODEL` value, defaulting to the Nemotron-family candidate above. The API key is never returned to the client.

### `OPTIONS /v1/mentor/respond`

Allowed browser origins are exactly `https://chatgpt.com` and `http://localhost` with an optional numeric local-development port. Other `Origin` values receive a `403` response without an `Access-Control-Allow-Origin` header. Requests without an `Origin` header are allowed for local server-to-server use and do not receive CORS headers.

### `POST /v1/mentor/respond`

Use `Content-Type: application/json` and send this shape:

```json
{
  "cloudConsent": true,
  "conversationKey": "chatgpt:example_123",
  "messages": [
    {"role": "user", "text": "I want to build a timer."},
    {"role": "assistant", "text": "What platform are you considering?"}
  ],
  "project": {
    "objective": "Build a timer",
    "technologyStack": "Web app"
  },
  "userMessage": "What should I build first?"
}
```

`cloudConsent` must be the boolean `true`. `conversationKey` must match `chatgpt:[A-Za-z0-9_-]+` or `workspace:[A-Za-z0-9_-]+`. There may be at most 40 conversation messages, and each message text and the latest `userMessage` may be at most 1,800 characters. Message roles are only `user` and `assistant`. Project values must be strings of at most 1,800 characters and project keys must be one of the known notebook fields: `projectName`, `description`, `objective`, `audience`, `requirements`, `features`, `technologyStack`, `designPreferences`, `architecture`, `completedMilestones`, `pendingTasks`, `knownIssues`, `decisions`, `recentChanges`, `nextSteps`, `experienceLevel`, `currentStage`, or `deploymentReadiness`.

The server rejects unknown request fields, invalid JSON, non-JSON content types, unsupported origins, oversized bodies, missing consent, invalid conversation keys, and out-of-bounds fields with safe JSON errors. It never returns an upstream error body or secret to the caller.

Successful responses are the structured object with these fields:

```text
reply
projectUnderstanding { whatIsBeingBuilt, why, targetUsers }
changedRequirements [{ change, impact, confidence }]
nextStep
securityReview [{ area, status, reason, recommendedAction }]
openQuestions[]
uncertainty[]
verificationNeeded[]
```

The request sent to OpenRouter uses `https://openrouter.ai/api/v1/chat/completions`, the configured model, a server-owned Bearer key, a system mentor prompt, and the redacted bounded reference data. It first requests a strict `json_schema`. A single `400` or `422` provider response is treated as a possible structured-output rejection and retried once with `response_format: {"type":"json_object"}`. No other retry is performed. Provider timeouts use a 25-second per-attempt limit.

Captured conversation and project text are explicitly marked as untrusted reference data in the system and user messages. They cannot grant tool access or override the mentor's constraints. The backend does not execute model output.

## Tests

Run the dependency-free tests from the repository root:

```text
node server/test.mjs
node server/workspace-persistence-test.mjs
```

The proxy test suite checks health, allowed and rejected CORS origins, validation boundaries, best-effort redaction, a successful structured response through a mocked `fetch`, structured-output fallback, and a mocked provider failure. The persistence suite checks local workspace save/load/export/delete behavior and path safety. These tests do not use a real OpenRouter key and do not claim a live OpenRouter test.

## Limitations

- This is a local hackathon proxy, not a production authentication, quota, abuse-prevention, or multi-tenant service. The endpoint has no user identity or session layer.
- CORS is an origin policy, not authentication. A deployment still needs an authenticated server boundary, HTTPS, rate limiting, operational secret management, and a review of privacy/retention obligations.
- Redaction recognizes common API-key/token/password assignments, Bearer tokens, `.env`-style secret assignments, and PEM private-key blocks. It can miss secrets and can redact ordinary text. Do not send sensitive material assuming it will be found.
- Data is held only in request-local memory while processing, but OpenRouter and its selected upstream provider process the approved cloud request under their own service terms and retention controls.
- The server does not prove correctness, security, test execution, deployment, or requirement completion. Model output is untrusted guidance and may be malformed or unavailable.
- The configured free model identifier and its structured-output support can change. A real OpenRouter key and provider account are required for a live request.
