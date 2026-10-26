# HQHarness

<img src="docs/shadcn-ui-unify/assets/branding/hqzyai-logomark.svg" width="80" alt="HQZY logo" />

[English](README.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Русский](README.ru.md) · [Español](README.es.md) · [Português](README.pt.md)

Un espacio de trabajo de escritorio local basado en [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). HQHarness es una adaptación de marca independiente de [DataElement DSH Desktop](https://github.com/dataelement/dsh-desktop), basada en el commit `115a0b474cc2c4794316171c640a8898398591fe`.

El runtime incluido está fijado en `@deepseek-ai/dsh@0.2.0-rc.2`.

## Estado

Este repositorio ofrece código fuente y procesos de compilación nativa. HQHarness todavía no tiene sitio de descarga, repositorio de versiones, identidad de firma ni servicio de actualización configurados. Una compilación o un artefacto CI no demuestra publicación, firma ni validación de todas las plataformas. Configura tus propios servicios y certificados antes de distribuir; consulta la [guía de publicación](docs/hqharness-release.md).

## Funciones

- Electron inicia el runtime y la interfaz web existentes de Harness
- Selector de espacios de trabajo, conexiones de modelos con Huaqing Switch, perfiles y sesiones
- Importación/exportación `.dshpreset` y herramientas PPTX, DOCX y XLSX
- Safe Mode, recuperación de plugins y diagnóstico de inicio; si la interfaz normal no abre, inicia con `--safe-mode`
- Teléfono vinculado por LAN o Cloudflare Quick Tunnel opcional, con Pinggy como alternativa
- Menús nativos, temas y actualización al configurar un servicio propio

Los proveedores y los identificadores de paquetes conservan sus nombres por compatibilidad. HQHarness no es un producto oficial de DeepSeek ni de DataElement.

## Desarrollo

Usa Node.js 24 o posterior y npm. Desde este repositorio:

```sh
npm ci
npm run dev
npm run typecheck
npm run build
npm test
git diff --check
```

postinstall debe completar los parches y la generación de recursos de marca. Desarrollo usa `HQHarness Dev` y `hqharness-dev`; producción usa `HQHarness` y `hqharness`. Los datos de DSH Desktop no se migran automáticamente. No modifiques el mismo perfil desde varias copias a la vez.

## Paquetes nativos

Genera paquetes de desarrollo sin firma en el sistema y la arquitectura correspondientes:

```sh
npm run package:dev:mac:arm64
npm run package:dev:mac:x64
npm run package:dev:win
```

Los objetivos configurados son macOS DMG/ZIP y Windows x64 NSIS. Linux y Windows ARM64 no están configurados. Los paquetes de producción firmados requieren certificados propios y validación de la aplicación instalada.

Consulta [guía de desarrollo](docs/development.md), [marca](docs/brand-guidelines.md), [arquitectura](docs/architecture.md) y [PPT runtime](packages/ppt-runtime/README.md). Se conservan los identificadores de protocolos y documentos históricos del proyecto original. Se mantiene la [licencia MIT](LICENSE) y el copyright original de DataElement; las dependencias conservan sus propias licencias.
