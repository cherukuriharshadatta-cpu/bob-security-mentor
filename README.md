# Bob — AI Mentor Agent workspace + optional extension adapter

**Version 0.7.0: persistent standalone Bob Agent workspace, living intent ledger, animated evidence-driven security flow, conservative readiness signals, and optional Nemotron cloud mentor chat.**

Bob is a Chrome/Edge Manifest V3 extension beside one explicitly approved ChatGPT conversation. Bob never sends messages, fills inputs, clicks ChatGPT controls, or uses private APIs. Local mode sends no conversation data to a network service. Optional cloud mode sends approved context only after separate cloud consent through the Bob backend → OpenRouter → Nemotron. Bob's own buttons, memory editor, mentor composer, and user-triggered Markdown download are interactive.

Independent extension; not affiliated with or endorsed by OpenAI or ChatGPT. User consent does **not** override a website's terms on automated extraction. This development prototype is not a legal compliance guarantee or a store-ready release.

## Install or update

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. For a new installation, **Load unpacked** and select the folder containing `manifest.json`.
4. For an existing installation, click its **Reload** button. Confirm version **0.7.0**.
5. **Refresh your ChatGPT tab as well.** Reloading the extension alone leaves old content scripts on an existing page.
6. Open a saved conversation on `https://chatgpt.com/c/<id>` (or `/g/<slug>/c/<id>`).
7. Open **Bob**, read the terms/privacy notice, tick the checkbox, and select **Allow THIS CONVERSATION**.
8. Wait about two seconds for settled-page checks and initial capture.

## Run the standalone Bob Agent workspace

The standalone workspace is now the recommended hackathon demo. It owns the interface and animation, so it does not depend on another AI website's DOM. The extension remains an optional ChatGPT context adapter.

```powershell
$env:BOB_WEB_PORT = "4173"
# Optional persistence directory; defaults to .bob
$env:BOB_DATA_DIR = ".bob"
# Optional cloud provider settings; leave the key unset for local-only mode
# $env:OPENROUTER_API_KEY = "<your-server-side-key>"
# Optional Chatbase server-action authentication secret
# $env:BOB_CHATBASE_SHARED_SECRET = "<long-random-server-secret>"
$env:OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"
node server/workspace-server.mjs
```

Open `http://127.0.0.1:4173`. Bob starts with an empty workspace. Add a user brief or import an explicit `User:`/`Assistant:` transcript, then inspect the intent ledger, project flow, lessons, human-run checks, and local deterministic questions. If you enable the optional cloud checkbox, a question is sent only to the same-origin local Bob server; the server may forward the bounded workspace context to OpenRouter when `OPENROUTER_API_KEY` is configured. The workspace displays `providerConfigured` and `model` from `GET /health`; it never receives the API key. Cloud analysis is labelled untrusted guidance and is never merged into confirmed workspace evidence.

The workspace also has a pure model layer in `web/project.js`: use its brief/transcript import APIs to build a real workspace without scraping ChatGPT. When served by `server/workspace-server.mjs`, canonical workspace state is persisted locally under `.bob/` (or the directory named by `BOB_DATA_DIR`); opening the files directly remains session-local.

## Add Bob to a Chatbase agent

Bob can be called from a Chatbase Server Custom Action through
`POST /v1/integrations/chatbase/mentor`. Configure the action to send a stable
`agentId`, `conversationId`, `userMessage`, `consent: true`, and only the
bounded project/message fields you actually want Bob to review. Authenticate
the server-to-server request with `BOB_CHATBASE_SHARED_SECRET`; never expose
that secret or the OpenRouter key in a browser widget. Bob returns a compact
`status: "success"` response with an untrusted reply, suggested next step,
lesson, clarification, and human verification suggestions. See
`integrations/chatbase/README.md` for the exact request, response, and
Chatbase action setup. This uses documented custom-action/widget composition;
it does not rely on undocumented assistant-message injection.

No package installation or model download is needed for the extension. Cloud mode requires a server-side OpenRouter key and the local backend described in `server/README.md`; the key must never be entered into Bob or committed. No access to the ChatGPT home page, temporary chats without a saved conversation ID, share pages, or other AI sites is supported for capture.

## What this version does

- Captures loaded, rendered user/assistant messages inside the main conversation area after consent. It also supports ChatGPT thread roots marked with `data-testid="conversation-turn-*"` when no semantic `<main>` is present. When explicit role metadata is absent, the selected visual-layout fallback uses only visible blocks, geometry, and structural signals; it is labelled approximate and excludes ambiguous blocks rather than silently claiming certainty.
- The visual fallback also checks alignment on nearby parent rows, including common rendered flex/layout signals. A full-width text block can therefore be classified when its parent clearly identifies a right-aligned user bubble or left-aligned assistant row; centered ambiguous prose remains excluded.
- If the page provides screen-reader labels such as `You`, `Human`, `Assistant`, or `ChatGPT` in `sr-only` headings or accessible labels, Bob uses those labels before visual geometry and removes the label text from the captured message.
- A shared outer wrapper containing both user and assistant labels is rejected, preventing the two speakers from being merged into one captured message.
- Visible `You said:` and `ChatGPT said:` headings are treated as role labels and removed from the stored message body.
- Capture diagnostics include bounded role-rejection counts and reason codes, so a partial user/assistant capture can be debugged without exposing message text, classes, IDs, URLs, or secrets.
- Preserves message order, handles rendered descendants of `display: contents` wrappers, and supports a known explicit-role turn fallback.
- Fails visibly if it cannot find supported message markup. It does not silently fall back to scraping the whole page.
- Observes changes on a bounded throttle so ongoing streaming cannot indefinitely delay capture.
- Retains at most 40 recent messages, at most 1,800 characters each, plus 40 bounded change entries. This is **not full conversation history**. Earlier goals and labelled details can persist as project suggestions.
- Extracts simple, explicitly stated goals and labelled project fields, for example `Goal: Build a timer`, `Technology stack: Kotlin`, or `Features: Add tasks`.
- Maintains a structured project notebook: name, description, objective, audience, requirements, features, stack, design, architecture, milestones, tasks, issues, decisions, changes, next steps, experience, stage, and deployment readiness.
- Lets you correct or clear individual fields. Your edits override automatic suggestions; differing suggestions are shown for review. An edited value is **self-reported**, not proof Bob verified it.
- Provides saved Markdown preview and download. This is a snapshot, **not an automatically updated disk file**.
- Shows a local **Security & readiness** review across secrets, identity, validation, data access, abuse controls, errors, logging/privacy, dependencies, web sessions, and deployment configuration.
- Maintains a bounded **Intent ledger** from explicit user statements only. It tracks current, replaced, and uncertain goals/requirements/constraints/decisions with source turn, scope, confidence, and clarification cues. Assistant text cannot establish user intent.
- Shows an animated **Security flow** from project intent through features, inputs, authentication, data/secrets, and verification. Nodes are labelled Observed, Mentioned, Needs review, Self-reported, or Not verified; the flow never presents a local signal as proof of safety.
- Includes a standalone **Bob Agent workspace** with a local project model, explicit-role transcript import, evidence-labelled lessons, scope clarification, human-reported verification checklist, local mentor teaching, and optional same-origin cloud mentor requests.
- Provides a separate **Mentor chat** with Bob's visual states (idle, listening, thinking, speaking, concerned), local-rules mode, and optional cloud mode through the local Bob backend → OpenRouter → Nemotron.
- Persists the standalone workspace locally under `.bob/` through the loopback server, with debounced save, reload recovery, Markdown export, delete/reset, and explicit-role transcript import.
- Offers a private local-rules question box on the dashboard and a separate Bob chat composer. Neither writes to ChatGPT. Bob chat history is bounded and stored locally per approved conversation.

Simple local rules do not understand arbitrary intent, design a reliable roadmap, inspect an entire source tree, prove generated code is safe, diagnose code, or infer the impact of a requirement change. Optional Nemotron cloud responses improve reasoning but remain untrusted suggestions. The readiness review only scans bounded captured conversation text and explicit project fields; a topic being mentioned does not mean it is implemented. A field being present does not mean Bob has filled it intelligently. Unknowns remain blank. Assistant text never establishes that work is complete or deployed. See `PROJECT.md` for the cloud boundary.

## Consent, isolation, and deletion

The browser grants **site-level** content-script access to `https://chatgpt.com/*`. Conversation scoping and read-only behavior are enforced by this extension's code, not by a browser-enforced per-chat/read-only capability.

- No conversation-text capture before explicit versioned consent.
- Capture pauses on navigation, reload, or page hide. Returning to an approved conversation requires **Resume this conversation**; a different conversation needs its own approval.
- No account credentials, cookies, session tokens, hidden messages, sidebar history, input values, or private APIs are used.
- Each conversation has separate storage keys. Memory is scoped to this browser profile, not authenticated Bob accounts; people sharing a profile can access its data.
- **Pause** stops capture but keeps memory available to edit and export.
- **Revoke & delete local memory** also works while paused. It confirms deletion, notifies other Bob tabs, and leaves a minimal permission tombstone to block delayed saves. It does not erase previously downloaded files, backups, or copies elsewhere.
- Writes are queued and guarded with same-origin Web Locks, permission epochs, and navigation generations. Unsupported storage/locking environments fail closed with an error; no page `localStorage` fallback is used.
- External edits/capture from another Bob tab pause this tab, rather than silently racing. Unsaved editor fields are preserved until revocation/deletion.
- SPA navigation can leave old messages mounted. A conservative node-identity guard blocks capture until the old elements are gone. If it keeps blocking, refresh the conversation and activate again.
- Cloud consent is separate from conversation consent. Switching to Cloud AI or changing the backend revokes cloud permission. The extension only allows localhost backend URLs; use a secured authenticated deployment only after revisiting the consent and CORS model.
- Bob will not send an empty conversation to cloud AI. If the first capture has not succeeded, Mentor chat shows the capture error and waits.

## Run the Nemotron backend locally

From the repository root, set these environment variables only for the server process. The key value below is a placeholder; this workspace does not contain a real credential:

```powershell
$env:OPENROUTER_API_KEY = "your-server-side-key"
$env:OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"
$env:BOB_PORT = "8787"
node server/openrouter-proxy.mjs
```

Then reload the extension and ChatGPT tab, open Bob → **Settings**, test `http://127.0.0.1:8787`, then open **Mentor chat**, choose **Cloud AI**, review the separate terms, and enable cloud consent. The selected model is configurable because OpenRouter free-model availability and identifiers can change. Free tokens are still cloud processing; they do not make the conversation local or private.

## Privacy limits

Local mode makes no network requests to model providers or application servers. Cloud mode makes an explicit request to the configured local Bob backend, which may forward the approved context to OpenRouter. Bob never uses `chrome.storage.sync`, telemetry, GitHub, or a shared API key in the extension.

Local data is **not encrypted by Bob**. Browser-profile backups, OS compromise, privileged extensions, other people using the same profile, or exported files in OneDrive/Dropbox/iCloud can expose it. Bob does not guarantee reliable secret redaction. Do not enable it for sensitive conversations without reviewing these risks.

The panel uses a closed shadow root to isolate styles and limit casual host-page access, but shadow DOM is not a security boundary against the browser, privileged extensions, or a compromised device. The source page is untrusted; captured text is displayed as text, not executed.

## Checks

Run from this folder:

```text
node tests/smoke.mjs
node tests/lifecycle.mjs
node server/test.mjs
node tests/workspace-model.mjs
node server/workspace-test.mjs
node server/workspace-persistence-test.mjs
node --check src/core.js
node --check src/content.js
node --check server/openrouter-proxy.mjs
node --check server/workspace-server.mjs
node --check web/project.js
node --check web/app.js
```

The first suite checks the manifest, URL boundaries, synthetic DOM capture, current goals, bounded history, immutable edits, schema migration, security signals, and Markdown. The second runs real content/core code in a **mocked** DOM/storage environment to check consent, streaming, navigation, delayed callbacks, deletion races, cross-tab changes, and storage failure. The workspace-model suite checks explicit-role import, intent provenance, scope changes, immutable checks, lessons and safe export. The workspace-server suite checks the loopback static server, traversal/private-file blocking, origin/host restrictions and mocked cloud forwarding. Server checks use no live key unless you configure one yourself.

These tests do not validate Chrome's real layout, content-script Web Locks, stylesheet loading, downloads, or the current ChatGPT DOM. Follow `tests/MANUAL.md` in Chrome/Edge. No dedicated lint/typecheck tooling is installed; this is plain JavaScript with Node syntax checks and no build pipeline.

## If Bob still shows zero messages

After refreshing both extension and tab, approve a saved conversation and wait two seconds. Read the diagnostic under the status:

- **No supported main conversation container / message markers:** ChatGPT may have changed its markup. Do not grant broader permissions. Report the diagnostic and a redacted screenshot.
- **No readable rendered messages:** messages may be hidden or not yet loaded. Wait for a visible answer; Bob will not fetch or auto-scroll history.
- **Message elements from navigation still present:** refresh the current chat and activate again.
- **Storage/locking/stylesheet failure:** use the visible retry control or reload the extension and tab. Capture stays off on failure.

Earlier screenshots demonstrated zero observations but did not reveal the exact DOM structure. Version 0.7.0 includes bounded diagnostics, resilient capture, the intent ledger, the animated security flow, and a standalone persistent workspace; current ChatGPT markup still requires live browser confirmation after each extension reload.
