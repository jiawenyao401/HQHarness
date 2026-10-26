# HQHarness model access

Desktop now uses **Huaqing Switch** as its sole model source. The main process sets `HQHARNESS_MODEL_SOURCE=huaqing-switch` and points to the current user's private `.huaqing-switch/connector.json`. The plugin uses official Harness/Pi adapters, authenticates to `127.0.0.1:17621`, and never reads a vendor API key. Its former renderer login/model editor is no longer loaded.

Default selections synchronize from Switch for new sessions. Connection IDs are versioned; changing the default preserves existing sessions, and editing/deleting a connection invalidates the old version. Missing service/configuration produces a clear error with no direct-provider fallback. See [the desktop integration contract](../../docs/huaqing-switch-integration.md).

## Previous AgentOS integration

The implementation below remains source-compatible for explicitly selected legacy deployments. Desktop does not instantiate the old main-process bridge or expose its editor.

The Models settings footer uses the desktop main-process bridge to sign in and claim finite AgentOS access. Account tokens and real virtual keys never enter this package, the renderer, or Harness settings.

The host registers the existing Harness pi-ai adapter with a fixed model catalog and a rotating local capability. Its OpenAI wire conversion, image attachments, streaming and tool calls remain upstream implementations. A user may explicitly save this provider as the default for new sessions; existing sessions retain their selections.

AgentOS owns expiry, renewal, model restrictions, employee/team budgets and billing. The adapter disables automatic failed-request retries. Image and tool capabilities must be verified and enabled by the server deployment. The client does not infer them from the model name.
