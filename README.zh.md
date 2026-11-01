# HQHarness

<img src="docs/shadcn-ui-unify/assets/branding/hqzyai-logomark.svg" width="80" alt="HQZY logo" />

[English](README.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Русский](README.ru.md) · [Español](README.es.md) · [Português](README.pt.md)

HQHarness 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的本地优先桌面工作区，独立品牌化自 [DataElement DSH Desktop](https://github.com/dataelement/dsh-desktop)。上游基线为 `115a0b474cc2c4794316171c640a8898398591fe`。

内置 runtime 固定为 `@deepseek-ai/dsh@0.2.0-rc.2`。

## 当前状态

仓库提供 HQHarness 源码及原生构建流水线。尚未配置 HQHarness 官网、发布仓库、签名身份或更新服务。源码构建成功或获得 CI 产物，不等于已正式发布、已签名或已完成各平台验收。对外分发前须配置自有地址与证书，见 [HQHarness 发布指南](docs/hqharness-release.md)。

## 功能

- Electron 自动启动现有 Harness runtime 与 Web UI
- 内置 Browser Use 与 Computer Use；网络任务优先浏览器，本机文件任务优先桌面应用，支持明确的本轮脚本/API 指令，见[工具路由说明](docs/desktop-automation.md)
- 原生工作区选择、Huaqing Switch 模型连接、Profile 和会话管理
- `.dshpreset` 预设导入导出，内置 PPTX、DOCX、XLSX 工具
- Safe Mode、插件恢复与启动诊断；正常界面无法打开时可使用 `--safe-mode` 启动
- 手机配对，支持局域网与可选 Cloudflare Quick Tunnel 临时公网隧道，Pinggy 作为后备线路
- 原生菜单、主题适配；配置自有服务后可启用更新流程

模型服务商名称和上游包标识保留，以维持兼容性。HQHarness 为独立项目，产品归属不代表 DeepSeek 或 DataElement。

## 本地开发与验收

使用 Node.js 24 或更高版本及 npm，在当前仓库执行：

```sh
npm ci
npm run dev
```

`npm ci` 的 postinstall 必须完整成功，包括补丁及品牌资源生成。提交前执行：

```sh
npm run typecheck
npm run build
npm test
git diff --check
```

开发应用为 `HQHarness Dev`，数据目录为 `hqharness-dev`；生产应用为 `HQHarness`，数据目录为 `hqharness`。不会自动迁移已有 DSH Desktop 用户数据。多个开发副本不得同时修改同一 Profile。

## 原生打包

以下命令产生独立、未签名的开发安装包；须在对应系统与架构运行：

```sh
npm run package:dev:mac:arm64  # Apple Silicon Mac
npm run package:dev:mac:x64    # Intel Mac
npm run package:dev:win        # Windows x64
```

必须通过原生目标检查与安装包 runtime 验证。当前打包目标是 macOS DMG/ZIP 与 Windows x64 NSIS；未配置 Linux 和 Windows ARM64 分发。正式签名包须使用自有证书，并完成安装后的应用验收。

## 文档与许可

参见 [开发指南](docs/development.md)、[品牌规范](docs/brand-guidelines.md)、[发布指南](docs/hqharness-release.md)、[架构](docs/architecture.md)、[预设格式](docs/preset-packages.md) 和 [PPT runtime](packages/ppt-runtime/README.md)。历史设计文档中描述上游协议的名称予以保留。

HQHarness 保留 [MIT 许可](LICENSE) 及 DataElement 原始版权归属。DeepSeek Harness 和第三方依赖继续适用各自的许可与声明。
