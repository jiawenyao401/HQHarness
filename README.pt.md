# HQHarness

<img src="build/brand-mark.svg" width="80" alt="HQHarness HQ logo" />

[English](README.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Русский](README.ru.md) · [Español](README.es.md) · [Português](README.pt.md)

Um espaço de trabalho local para desktop baseado no [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). HQHarness é uma adaptação de marca independente do [DataElement DSH Desktop](https://github.com/dataelement/dsh-desktop), baseada no commit `115a0b474cc2c4794316171c640a8898398591fe`.

O runtime incluído está fixado em `@deepseek-ai/dsh@0.2.0-rc.2`.

## Estado

Este repositório fornece código-fonte e processos de compilação nativa. Site de download, repositório de versões, identidade de assinatura e serviço de atualização do HQHarness ainda não foram configurados. Uma compilação ou artefato CI não comprova publicação, assinatura ou validação em todas as plataformas. Configure seus próprios serviços e certificados antes de distribuir; veja o [guia de publicação](docs/hqharness-release.md).

## Recursos

- Electron inicia o runtime e a interface web existentes do Harness
- Seleção de espaços de trabalho, provedores de modelos, perfis e sessões
- Importação/exportação `.dshpreset` e ferramentas PPTX, DOCX e XLSX
- Safe Mode, recuperação de plugins e diagnóstico de inicialização; se a interface normal não abrir, inicie com `--safe-mode`
- Telefone pareado por LAN ou Cloudflare Quick Tunnel opcional, com Pinggy como alternativa
- Menus nativos, temas e atualizações após configurar seu próprio serviço

Os nomes de provedores e identificadores de pacotes são mantidos por compatibilidade. HQHarness não é um produto oficial da DeepSeek ou da DataElement.

## Desenvolvimento

Use Node.js 24 ou superior e npm. Neste repositório:

```sh
npm ci
npm run dev
npm run typecheck
npm run build
npm test
git diff --check
```

postinstall precisa concluir os patches e a geração dos recursos de marca. Desenvolvimento usa `HQHarness Dev` e `hqharness-dev`; produção usa `HQHarness` e `hqharness`. Dados do DSH Desktop não são migrados automaticamente. Não altere o mesmo perfil em várias cópias simultaneamente.

## Pacotes nativos

Crie pacotes de desenvolvimento sem assinatura no sistema e na arquitetura correspondentes:

```sh
npm run package:dev:mac:arm64
npm run package:dev:mac:x64
npm run package:dev:win
```

Os alvos configurados são macOS DMG/ZIP e Windows x64 NSIS. Linux e Windows ARM64 não estão configurados. Pacotes de produção assinados exigem certificados próprios e validação do aplicativo instalado.

Veja [guia de desenvolvimento](docs/development.md), [marca](docs/brand-guidelines.md), [arquitetura](docs/architecture.md) e [PPT runtime](packages/ppt-runtime/README.md). Documentos históricos mantêm os identificadores dos protocolos originais. A [licença MIT](LICENSE) e o copyright original da DataElement são preservados; as dependências mantêm suas próprias licenças.
