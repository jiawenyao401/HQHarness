# Huaqing Switch desktop integration

2026-10-22. Desktop model configuration is owned by the companion **Huaqing Switch** application. Start Switch, add a connection and select its default, then open a new HQHarness session. Client model configuration and employee-login editors are hidden. The existing model selector can only resolve models advertised by Switch.

## Ownership

- `src/main/huaqing-switch.ts` supplies the backend source and the absolute discovery path in the current user home. No vendor key or new HTTP proxy is created in Electron.
- Preload exposes only the fixed model-source label. The existing settings-models package returns before mounting its editor in this mode.
- `packages/hqharness-model-access` dispatches to `huaqing-switch.js`; official Harness/Pi adapters handle the original protocols. Three native APIs are supported: Chat Completions, Responses, and Anthropic Messages.
- The dsh-llm patch filters provider discovery and rejects all direct-provider dispatch. Old sessions do not silently change models. All upstream changes are replayed through patch-package at npm postinstall.

## Discovery and session behavior

Read `.huaqing-switch/connector.json` from the current OS user home. It must identify `huaqing-switch`, version 1 and the exact endpoint `http://127.0.0.1:17621`, with a 64-character local access token. Unix files must be owned by this user with no group/other permissions, regular files and not symlinks. Discovery and manifest sizes/timeouts are bounded. No credentials may be redirected to another endpoint.

The authenticated manifest provides versioned connection IDs, native API paths and explicit local token/image budgets. These budgets are configured by the operator, not inferred provider limits. Cost is unconfigured and must not be treated as billing data.

Default model selection synchronizes on startup and every five seconds. With Switch offline at first launch, the selection is `huaqing-switch/awaiting-connection`; configure Switch and start a new session. Existing prepared calls retain their manifest snapshot and token. Later calls reread the file, so a Switch restart rotates local credentials without restarting Harness.

Changing a default affects new sessions. Editing/deleting a connection invalidates old pinned IDs rather than silently replacing the provider/model inside a conversation. Failures do not retry against another provider. The runtime retains its own random local port; 17621 belongs only to Switch.

## Validation

The final macOS arm64 package was built, opened with an isolated user-data directory, and checked for the fixed source and absent model configuration section. Its ASAR contains the new connector and both replayable policy seams.

Six targeted test files passed 35 tests, including offline startup default, empty default, discovery validation, existing onboarding and real focused-client runtime. Node TypeScript checking, build, target verification and electron-builder directory packaging passed. A source-only clean copy passed full npm ci with postinstall patch replay; standard build regenerates required Office/PPT payloads before runtime tests.

The companion Switch repository contains `scripts/verify-harness-connector.mjs`: actual native Switch and actual Harness/Pi runtime against a deterministic local API fixture, covering three protocols, streaming tool calls, cancellation, authentication, token rotation and connection pinning. This is not a real paid-model request. Windows/Linux native acceptance and formal signing/release remain separate checks.

Evidence and full Switch operations documentation: `/Users/jiawy/Documents/预研/Huaqing Model Connection/validation/` and `docs/huaqing-harness-integration.md` in that repository. Existing unrelated working changes in this HQHarness checkout were preserved.
