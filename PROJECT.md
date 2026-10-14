# AI Mentor — product direction and current scope

## Intended outcome

Bob should become a patient development mentor: understand a beginner's project, teach one step at a time, retain decisions, adapt to requirement changes, and guide testing and deployment. Its interface remains an opt-in, read-only companion attached to one chosen ChatGPT conversation. It must never claim to have modified code, run tests, or deployed anything itself.

## Implemented foundation (0.4.5)

- Explicit versioned consent, per-conversation capture gates, local storage, pause and revocation.
- Capture diagnostics, ordered bounded messages and navigation guards.
- Editable structured project notebook, manual progress fields and Markdown snapshot export.
- Reference-inspired workspace UI with project brief, milestone cards, local Ask Bob box, and security/readiness signals.
- Conservative review signals for secrets, auth, validation, data access, rate limiting, errors, logging/PII, dependencies, web sessions, and deployment configuration.
- Separate automatic suggestions and user corrections, with provenance and verification limitations.
- Separate Dashboard, Mentor chat, and Settings views with animated Bob orb states and reduced-motion support.
- Optional cloud-consent path for a local Bob backend that forwards to a configurable OpenRouter Nemotron-family model; no shared provider key in the extension.
- Dependency-free Node backend with bounded input, best-effort redaction, structured-output validation, timeout/error handling, no request persistence/logging, and a no-key test suite.
- Visual-layout fallback for ChatGPT pages without explicit role markers, with parent-row alignment signals, approximate labeling, ambiguity exclusion, and conservative SPA-root navigation guards.
- Accessible-label capture path for rendered `sr-only`/`visually-hidden` speaker labels, with bounded ancestor selection and label-text removal.
- Shared multi-speaker wrapper rejection so user and assistant content cannot be merged into one message.
- Visible speaker-heading handling so `You said:` and `ChatGPT said:` are not stored as conversation text.
- Live capture state distinguishes successful, partial assistant-only, failed, stale, and waiting captures; cloud sending is blocked unless the latest capture includes a user message.
- Bounded diagnostic counters show whether user or assistant labels were matched, captured, or rejected and why, without exposing conversation text.
- Dashboard includes a Shrike-inspired animated evidence map: project intent → feature flow → inputs → auth boundary → data/secrets → verification. Animation is reduced-motion aware and security states remain explicitly evidence-labeled.
- Node regression tests over DOM fixtures and simulated extension lifecycle.

**Not implemented or not verified:** a live OpenRouter request with a real hackathon key, semantic requirement comparison quality, personalized lesson quality, automatic roadmap generation quality, code execution, actual progress verification, live disk-file updates, other AI websites, production authentication/quotas for a remote deployment, GitHub sync, or a production legal/store-review process.

The security review is not a security scanner for the user's repository. It reads only bounded conversation text and explicit project fields. It can highlight that a control was discussed or that risky language appeared; it cannot prove that code implements the control safely. A future file-aware review must be separately authorized and designed to avoid reading unrelated files or secrets.

## Selected experimental inference direction

For the hackathon prototype, use **OpenRouter as the hosted inference gateway**, with an available free NVIDIA Nemotron-family model as the initial candidate. The exact OpenRouter model ID remains configuration, not source code, because free-model availability, limits, and identifiers can change.

This is a cloud-processing mode, even when the model is free. Approved conversation context will leave the device and be processed by OpenRouter and its selected upstream provider. Free credits do not make the data local or automatically private. The consent UI and privacy notice must say this before the first AI request.

The extension must not contain a shared OpenRouter key. The implemented hackathon shape is:

```text
Bob extension → Bob mentor backend → OpenRouter → selected model
```

The backend keeps `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` in environment configuration, uses an ephemeral request path, redacts obvious secrets before forwarding, avoids raw prompt/response logs, validates structured model output, and preserves the local-only fallback when the service is unavailable. The extension has only localhost host permissions for this development proxy; it does not call OpenRouter directly.

OpenRouter's normalized chat-completions API supports a `model`, `messages`, and optional structured-output response format; model support must be checked for the selected free model before relying on strict JSON schemas. The initial model response will be treated as untrusted suggestions, never as verified security or deployment results.

## Previous inference decision context

An LLM is needed for the intelligent teaching described in the project brief. Keeping only the Markdown local is insufficient if prompts containing the conversation go to a cloud model.

1. **On-device model:** remains an optional future privacy mode, not the default, because users should not have to download model weights or have high RAM/storage requirements.
2. **Cloud model:** selected for the hackathon prototype with explicit consent. Requires an authenticated backend, provider disclosure, retention/deletion controls, quotas, and server-held secrets. Never put a shared API key in the extension. This is no longer local-only processing.

No OpenRouter key or provider account has been provisioned in this workspace. The backend and extension connection are implemented and tested with mocks; a real provider response still requires a key and local configuration.

## Model-backed slice boundary

The current model-backed slice:

- Feed only the approved conversation's bounded context and saved project memory.
- Treat captured conversation and Markdown as untrusted reference data, not instructions to execute tools or override privacy rules.
- Request a schema-validated plan/update containing the current intent, uncertainty, changed requirements, impacts, and one beginner-friendly next step.
- Keep observations, suggestions, user-confirmed decisions, and externally verified results separate.
- Surface conflicts with saved corrections rather than silently rewriting them.
- Reject stale model responses after pause, navigation, revocation, or newer edits; support cancellation and visible errors.
- Never infer psychological or sensitive profiles. Do not declare deployment readiness based only on another assistant's assertion.
- Keep memory isolated by conversation; cross-conversation reuse must be a separate explicit import/share action, not an automatic merge.

## Publishing gates

- Confirm real Chrome/Edge operation against current ChatGPT markup.
- Review host-site terms, especially automated extraction. User permission is not permission from the host service.
- Review the final privacy/terms text with the operator's identity, contact details, data disclosures and applicable legal requirements. The prototype notice is not a professionally reviewed commercial agreement.
- Review Chrome Web Store permissions, privacy disclosures and branding.
- Assess minors/student-data obligations before targeting children or schools.
- Security review and privacy testing; do not promise that local storage or private GitHub means complete confidentiality.
