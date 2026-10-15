# Chrome/Edge manual acceptance checks

Use disposable conversations with synthetic content, not private projects or credentials. These steps have **not been run against a live ChatGPT tab by the agent**. The Node tests do not replace them.

## Installation and initial consent

1. Reload the unpacked extension, confirm **0.7.0**, then refresh the ChatGPT tab.
2. Open a saved conversation A. Verify the floating Bob button and styled panel appear.
3. Before accepting, verify status says paused and the Allow button is disabled.
4. Review the terms, checkbox, exact conversation key, local-only/no-AI disclosure and host-site-terms caveat.
5. In Chrome extension inspection tools (if available), inspect `chrome.storage.local` for this extension, not ChatGPT page storage. There should be no newly captured messages before consent. Do not paste production records into reports.

## Capture and changing requirements

1. In ChatGPT, manually send `Help me build a to-do app. Platform: Android. I am a beginner.` Let ChatGPT answer.
2. Approve Bob for conversation A and wait about two seconds. Expect a positive retained-message count or a specific capture diagnostic, not an unexplained zero.
3. Confirm the current goal refers to the user's project rather than assistant prose.
4. Manually send `Goal: Build a web habit tracker instead; Technology stack: JavaScript; Features: Daily check-ins`.
5. Expect the suggested goal/stack/features to update. Other unlabelled semantic details may remain unknown in this rule-based version.
6. Open Project memory & progress and type an unsaved correction while ChatGPT streams a reply. The typed input must not disappear.
7. Save the correction. Confirm it is labelled saved by you and future automatic observations do not overwrite it; differing suggestions should appear below the field.
8. Enter a multiline pending-task list, save, pause, refresh, open Bob. Confirm memory and line breaks persist, and capture remains paused until Resume.

## Boundaries and navigation

1. While A is active, navigate to a different saved chat B. Bob must pause, clear A from the panel, and require B approval.
2. B must not inherit A's saved goals, messages, or edits.
3. Return to A. Memory should load, but capture must remain paused until explicitly resumed.
4. Test a supported project/custom-GPT conversation route `/g/<slug>/c/<id>`.
5. Visit ChatGPT home or an unsupported route; activation must be unavailable.
6. If navigation leaves old message elements mounted, expect a conservative capture-blocked warning. Refresh the selected conversation and approve again.

7. If capture is partial, record only the redacted role counts and reason codes shown by Bob, such as `users matched/captured/rejected` and `assistants matched/captured/rejected`. Do not record message text or DOM attributes.

## Pause, export and delete

1. Pause Bob, then manually add a ChatGPT message. Bob's saved capture must not change until Resume.
2. While paused, edit project memory and save. Open Markdown memory and download it. Confirm it includes saved edits, provenance, recent messages and the capture-limit warning.
3. Confirm Markdown is a snapshot, not a live disk file. Keep downloads outside synced folders if that is your privacy requirement.
4. Choose Revoke & delete and cancel the confirmation: memory must remain.
5. Choose it again and confirm. Memory should disappear, a minimal revoked permission record may remain, and the conversation must require consent again. Exported files remain unchanged.

## Multiple tabs and errors

1. Open A in two tabs and activate each. Writes from another tab should pause capture in the receiving tab; no auto-resume.
2. Edit different fields in each tab. Confirm unsaved fields survive incoming changes and saves merge only the fields edited.
3. Revoke A from one tab while another is receiving a streaming reply. Both must stop; memory must not reappear.
4. Reload/disable the extension while a tab is active. An invalidated storage environment should stop safely, not write to page localStorage.
5. Confirm no unexpected network calls to external model providers, telemetry, or application servers originate from Bob. The extension loads its own bundled CSS resource.

## Record results

Record browser/version, extension version, pass/fail per section and any **redacted** diagnostic. Never include raw project memory, auth tokens or private conversation text. Actual stylesheet loading, Web Locks availability, live markup compatibility and downloads require this browser check.
