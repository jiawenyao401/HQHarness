# Huaqing Switch desktop integration

HQHarness uses the companion **Huaqing Switch** application as its model source. Start Switch, configure a connection and select its default, then open a new HQHarness session. The Desktop model-provider editor and employee-login card are not loaded. Existing automation, workspaces and optional plugins retain their current composition.

## Discovery and ownership

Electron Main passes `HQHARNESS_MODEL_SOURCE=huaqing-switch` and the current user's absolute `.huaqing-switch/connector.json` path to the Harness process. The file must identify `huaqing-switch`, version 1 and exactly `http://127.0.0.1:17621`, with a 64-character hexadecimal local capability. Unix files must be regular, owned by the current user, not symlinks and inaccessible to group/other users. Discovery files and fetched metadata have size and time limits. Vendor credentials remain in Switch and do not enter Harness or the renderer.

The authenticated `/hq/manifest` response provides versioned connection IDs, native API paths and explicit context/output/image budgets. The plugin uses the official Harness/Pi Chat Completions, Responses and Anthropic Messages adapters. Cost metadata is unconfigured and is not billing data. Switch owns port 17621; Harness keeps its existing separate local endpoint.

Default selection synchronizes at startup and every five seconds for new sessions. Offline first launch uses `huaqing-switch/awaiting-connection`; configure Switch and start a new session. Changing the default preserves existing session IDs. Editing or deleting a connection invalidates the old version instead of silently changing a conversation's provider or model. A prepared call retains its manifest and local capability; subsequent calls reread discovery, allowing a Switch restart to rotate credentials without restarting HQHarness. Failed inference is not replayed or routed to a direct provider.

## Implementation and compatibility

The integration uses `src/main/huaqing-switch.ts`, the existing `hqharness-model-access` plugin and two patches for the pinned Harness `0.2.0-rc.2`. The LLM patch filters provider discovery and rejects direct-provider dispatch in Switch mode. The settings-models patch returns before registering credential/model UI in that mode; it keeps upstream behavior outside Desktop Switch mode. The plugin's renderer declaration is removed so its legacy employee-login editor is absent from the client graph. Existing AgentOS service sources remain for their standalone compatibility tests; Desktop no longer starts that bridge.

There is no new runtime dependency or lockfile change. `npm ci` must replay both patches, and package metadata must include `huaqing-switch.js`, `switch-connector.js` and `switch-profile.js`. Future Harness upgrades must requalify these seams against actual loader, adapter and settings behavior before retiring the patches.

## Validation

```sh
npm ci
npm run typecheck
npx --no-install vitest run test/huaqing-switch.test.mjs test/huaqing-switch-env.test.ts test/huaqing-switch-runtime.test.ts test/model-settings-render.test.mjs test/desktop-onboarding.test.ts test/model-access-harness.test.ts
npm test
npm run build
```

These tests are included by the existing Vitest configuration and Windows acceptance workflow. They cover discovery validation, native Pi profile creation, offline defaults, authenticated Harness startup and bootstrap registration, absence of the employee editor and direct-provider settings, existing onboarding, and the preserved standalone AgentOS adapter. A clean installation and passing tests do not establish installed Windows UI behavior or real upstream model access.

For three-protocol streaming, cancellation, credential rotation and connection-version acceptance, run `scripts/verify-harness-connector.mjs` from the Switch repository against a native Switch executable and this checkout. That test uses deterministic loopback provider fixtures, with no paid model request. The Windows acceptance workflow builds an unsigned installer and records its source commit and SHA256; installation and real model use on the target machine remain separate acceptance steps. No formal release is created by that workflow.
