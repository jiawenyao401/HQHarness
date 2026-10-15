# HQHarness

<img src="docs/shadcn-ui-unify/assets/branding/hqzyai-logomark.svg" width="80" alt="HQZY logo" />

[English](README.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Русский](README.ru.md) · [Español](README.es.md) · [Português](README.pt.md)

A local-first desktop workspace powered by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). HQHarness is an independent branding fork of [DataElement DSH Desktop](https://github.com/dataelement/dsh-desktop), based on commit `115a0b474cc2c4794316171c640a8898398591fe`.

The bundled runtime is pinned to `@deepseek-ai/dsh@0.2.0-rc.2`.

## Project status

This repository contains the HQHarness source and native build workflows. No HQHarness public download site, release repository, signing identity or update service has been configured. A source build or CI artifact does not establish that an installer has been released, signed or qualified on every platform. Configure your own endpoints and certificates before distribution; see the [HQHarness release guide](docs/hqharness-release.md).

## Features

- Electron host that starts the existing Harness runtime and Web UI
- Native workspace picker, model-provider configuration, profiles and sessions
- Portable `.dshpreset` import/export and bundled PPTX, DOCX and XLSX tooling
- Safe Mode (`--safe-mode` when the normal UI cannot open), plugin recovery and startup diagnostics
- Paired phone access over a local network or an optional Cloudflare Quick Tunnel, with Pinggy as a fallback
- Native menus, theme integration and an update flow enabled by your configured service

Model-provider names and upstream package identifiers remain unchanged for compatibility. HQHarness is not an official DeepSeek or DataElement product.

## Development

Use Node.js 24 or later and npm. From this checkout:

```sh
npm ci
npm run dev
```

`npm ci` must finish its postinstall steps, including patches and generated brand assets. Before submitting changes:

```sh
npm run typecheck
npm run build
npm test
git diff --check
```

Development uses `HQHarness Dev` and the `hqharness-dev` data directory; production uses `HQHarness` and `hqharness`. Existing DSH Desktop data is not migrated automatically. Do not run multiple development checkouts against the same profile concurrently.

## Native packaging

Build on the matching OS and architecture. These commands produce isolated unsigned development packages:

```sh
npm run package:dev:mac:arm64  # Apple Silicon Mac
npm run package:dev:mac:x64    # Intel Mac
npm run package:dev:win        # Windows x64
```

The target-native verification and packaged-runtime gates are mandatory. macOS DMG/ZIP and Windows x64 NSIS are the configured targets; Linux and Windows ARM64 distributions are not configured. Signed production packaging requires your own credentials and installed-app verification.

## Documentation and license

See the [development guide](docs/development.md), [brand guidelines](docs/brand-guidelines.md), [release guide](docs/hqharness-release.md), [architecture](docs/architecture.md), [preset format](docs/preset-packages.md) and [PPT runtime](packages/ppt-runtime/README.md). Historical design documents retain upstream names where they describe upstream protocols.

HQHarness retains the [MIT License](LICENSE) and original DataElement copyright attribution. DeepSeek Harness and bundled dependencies retain their own licenses and notices.
