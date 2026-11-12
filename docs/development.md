# HQHarness development guide

This guide covers local development, validation, patch maintenance, and target-native packaging. For the runtime design, see [Architecture](architecture.md). For HQHarness configuration and formal releases, see the [HQHarness release guide](hqharness-release.md) and [release runbook](release-runbook.md).

## Prerequisites

- Node.js 24 or later
- npm
- macOS on Apple Silicon or Intel, or Windows x64

This baseline pins `@deepseek-ai/dsh@0.2.0-rc.2`. Windows packages run Harness in Electron Node mode, while macOS uses an Electron UtilityProcess. Both are independent of the Node.js version used to run development commands.

## Local setup

Run from your HQHarness checkout. The upstream baseline is `dataelement/dsh-desktop` commit `115a0b474cc2c4794316171c640a8898398591fe`; no HQHarness release repository is assumed.

```bash
npm ci
npm run dev
```

`npm ci` runs the repository's `postinstall` hook. It reapplies the tracked `patch-package` patches, rebuilds the pinned official Harness Web shell through `ui:prepare`, generates HQHarness assets under `.build/brand` from `docs/shadcn-ui-unify/assets/branding/hqzyai-logomark.svg` and `brand.config.json`, installs them into the pinned Harness frontend, and installs Electron.

Development builds use the separate application name `HQHarness Dev` and the separate user-data directory `hqharness-dev`, so they do not reuse production HQHarness data or the upstream DSH Desktop profile. Production HQHarness uses `hqharness`. Data is not automatically migrated from DSH Desktop. Multiple development worktrees still share that development profile by default; avoid running them at the same time when testing profile, plugin, migration, or recovery changes.

## Validation

Run the core checks before submitting a change:

```bash
npm test
npm run typecheck
npm run build
```

Static checks are not a substitute for runtime verification. Changes that affect startup, profiles, plugins, native dialogs, updates, mobile access, or packaging should also be exercised through the corresponding real application flow.

To exercise the Cloudflare-to-Pinggy fallback without disrupting the machine's network, start the development app with Cloudflare failure simulation enabled:

```bash
DSH_TUNNEL_FORCE_PINGGY=1 npm run dev
```

Then enable the temporary public tunnel from the phone connection screen. The tunnel status should report `pinggy`, and the generated URL should use a Pinggy hostname. This variable affects only the process started from that command; omit it on the next launch to restore the normal Cloudflare-first behavior.

Automatic fallback still happens only when Cloudflare fails to start. If a Cloudflare pairing link is already showing but the phone cannot open it, use **扫码打不开？换一条线路** / **Can't open? Try another link** on the pairing page to switch to Pinggy.

## Project map

```text
src/main/                 Electron main process and application orchestration
src/main/runtime/         Harness process lifecycle and diagnostics
src/main/state/           Profile consistency, repair, recovery, and Safe Mode
src/main/mobile/          Paired phone bridge and optional Cloudflare tunnel
src/main/update/          Installed-build update state and lifecycle
src/preload/              Narrow renderer-to-main IPC and desktop UI seams
src/shared/               Shared contracts and desktop menu definitions
packages/                 Bundled desktop support packages
patches/                  Reproducible patches for the pinned Harness packages
build/                    Packaged HTML, brand vector input, and Harness entry files
.build/brand/             Generated HQHarness icons and loaders (ignored by Git)
scripts/                  Build, signing, metadata, and target verification tools
test/                     Unit and source-contract regression coverage
.github/workflows/        Native CI, signing, release, and publication workflows
```

## Maintaining upstream patches

The desktop product intentionally reuses the upstream Harness UI. Desktop-specific provider onboarding, preset transfer, model selection, workspace, branding, and layout changes are captured under `patches/` rather than stored as untracked edits in `node_modules`.

When upgrading Harness:

1. Install the intended upstream version.
2. Verify the current Settings, Credentials, Provider Directory, workspace, and preset contracts.
3. Reapply or rewrite each desktop customization.
4. Regenerate the relevant `patch-package` patches.
5. Run the full automated suite.
6. Start the real app and exercise every affected user flow.

## Packaging

For the private distribution that bundles xasp OA skills, see the [OA build and acceptance instructions](oa-desktop.md).

Harness includes architecture-specific native dependencies. Build each installer on the operating system and architecture where it will run.

```bash
# macOS Apple Silicon, on an Apple Silicon Mac or runner
npm run package:mac:arm64

# macOS Intel, on an Intel Mac or runner
npm run package:mac:x64

# Windows x64 NSIS installer, on a Windows x64 machine or runner
npm run package:win
```

Do not invoke `electron-builder --win` from macOS or Linux for a distributable Windows package. The target verification scripts intentionally reject host/target mismatches.

For local unsigned development packages, use the corresponding `package:dev:*` command. Packages run Harness and package commands through the packaged Electron runtime (a utility process and the Helper in Node mode on macOS, the executable in Node mode on Windows); no standalone `node_modules/node` may be present under `app.asar.unpacked`. Verify the packaged native-module, pnpm and Harness smokes, then the final signed installer's separate installed-app smoke before handoff. Office preparation is included in dev, build and test: it fetches hash-locked native Python and wheels into `.build/office-runtime`, outside ASAR, and ships no second Node runtime. See [Office runtime](office-runtime.md). The locked Electron 44.7.0 and the explicit native loader override must remain compatible with the native loader: `scripts/verify-target.mjs` fails packaging when Electron in Node mode cannot load it, and changing Electron still requires a new Windows package qualification. Before packaging, `node scripts/probe-electron-node-runtime.mjs` boots Harness from the repository through Electron Node mode with a disposable `DSH_HOME` and checks an authenticated HTTP response; the Windows CI job runs it on every build.

After configuring your own release repository and signing credentials, formal release artifacts are built, signed, and published by the tag workflow. The default HQHarness configuration does not have those services or credentials. A local build or pull-request check is not formal release evidence.

## Contribution hygiene

- Never include real API keys in issues, logs, screenshots, fixtures, or test data.
- Preserve unrelated worktree changes.
- Keep temporary research, local reports, and internal working documents under the ignored `doc/` directory.
- Update all localized README files when changing user-visible facts.

### Desktop assistant identity

The normal and Safe Mode patches configure the same Huaqing Harness identity
using the pinned system-prompt service. The desktop Web surface describes
Huaqing Desktop and omits source-checkout guidance. Provider and model routing
identifiers, and explicit custom preset personas, retain their own semantics. Existing workspaces and
recorded messages are retained on upgrade.
