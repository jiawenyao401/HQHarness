# HQHarness team model access

The built-in `hqharness-model-access` plugin adds a card to **Settings → Models** and a managed provider to the existing Harness LLM service. It uses the official Pi AI adapter; sessions, tools and model message conversion remain owned by Harness.

## Policy

- An authenticated AgentOS employee claims one three-hour lease for the administrator-selected `DeepSeek-V41-Flash` logical model. A system administrator account cannot claim employee access.
- During the original final ten minutes, an active model request or a model request within the last ten minutes triggers one automatic renewal. Opening the application alone does not trigger renewal. The maximum deadline is the original issue time plus six hours.
- AgentOS validates ownership, the renewal window and the single-renewal limit atomically. Retrying a lost response cannot move the deadline. The existing user/team budgets and rate limits remain authoritative; renewal updates only expiry.
- Expiry, revocation and account disablement stop access. Requests are bounded to five minutes and the lease deadline. A failed request is never automatically replayed through another model or after a tool operation.
- Claims use durable idempotency IDs. AgentOS limits concurrent active leases and claim frequency. Signing out stops local use immediately; a failed remote revocation remains visible and is retried on the next login, with server expiry as the final bound.

## Credentials and transport

The Electron main process owns account tokens, virtual keys, renewal and the fixed AgentOS inference route. `safeStorage` encrypts the local credential file. If OS encryption is unavailable, storage fails without a plaintext fallback. A damaged file is preserved; the explicit recovery action backs it up before resetting only the team-login state.

The renderer receives named IPC operations and redacted status. Harness receives a random loopback address and a local capability token, never the AgentOS account token or virtual key. The bridge checks the exact Host, rejects browser Origin headers, and accepts only its managed-model query and chat-completions route. Restarting Harness rotates the capability and cancels requests from the previous instance.

AgentOS stores only key hashes in lease rows. The short-lived preimage needed for idempotent claim recovery is sealed with its existing AES-GCM provider-credential cipher and a lease-specific authenticated context. The existing KEK rotation mechanism applies. A bounded reconciler removes expired preimages, completes pending revocations, and retires abandoned issuance reservations. It does not issue or renew access in the background.

## Configuration and login

Configure the BFF root, `/api`, or `/web-api` URL in Settings → Models. Production connections require system-trusted HTTPS. The user-authorized test service is `http://192.168.2.11:5001`; private HTTP requires an explicit test checkbox, and the server must mark its grants as test grants. This exception does not disable TLS validation.

This implementation uses AgentOS's existing password-login API when that API is enabled. Passwords are used once and are not persisted. An OIDC-only deployment reports that password login is disabled; browser PKCE login is not implemented in this plugin. Do not advertise SSO support for this version.

Claiming access can set the team provider as the default for **new sessions**. An existing session can select it through the existing model selector. Existing providers and credentials are retained. Client cost estimates are not the team billing record.

## Backend and model qualification

The AgentOS changes add schema version 31 and `/desktop/model-access` control/inference routes. Deployment requires a real active logical model ID, verified context and output limits, and the existing gateway's authenticated, fail-closed usage-preflight callback. The BFF checks the durable deadline at the public inference route and at direct gateway preflight; a client countdown alone is insufficient.

Image input and tool-call capabilities default to unverified. Enable them only after testing the actual model deployment. Browser automation requires reliable tool calls; screenshot-based Computer Use also requires image understanding. The model's display name does not establish either capability.

The implementation and UI being present does not establish that the target BFF is deployed, a usable model exists, or Windows installation has passed native acceptance. Record those results separately. The current environment inspection and verification results are kept in the task's local validation report.
