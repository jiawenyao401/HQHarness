# HQHarness 品牌规范

HQHarness 是复用 DeepSeek Harness runtime 和 Web UI 的独立桌面宿主。产品名称统一为 `HQHarness`，开发应用使用 `HQHarness Dev`。不得在应用标题、菜单、启动页、恢复页或宣传文案中将本产品归属写成 DeepSeek 或 DataElement。

## 品牌输入

[`brand.config.json`](../brand.config.json) 管理产品名、应用标识、用户数据目录和可选服务地址。界面采用团队的 [`shadcn-neutral-v3`](shadcn-ui-unify/assets/neutral-theme.json)、`lucide-outline-v1` 和 `hqzy-logomark-v2`。品牌矢量的唯一输入是标准随附的 [`hqzyai-logomark.svg`](shadcn-ui-unify/assets/branding/hqzyai-logomark.svg)，SHA-256 为 `720d90e26fcd94a1000c5a40cd2dd042c07299f5bae601ba7e3052330e534c52`。蓝色渐变和 793:568 比例保持原样，favicon、侧栏、对话首页及平台图标使用同一输入；窗口标题和产品名仍为 HQHarness。主题采用中性黑白，不以品牌蓝色覆盖所有操作。旧深蓝/青绿配置保留兼容读取，不作为当前主题来源。

`npm run brand:prepare` 从权威输入生成 `.build/brand/` 下的 PNG、ICO、ICNS 和浅色/深色加载动画。postinstall、dev 和 build 会准备并安装品牌资源，生成目录不提交到 Git。不重复维护手工生成的图标副本；旧上游资源若仍用于历史参考，不应作为新安装包输入。

## UI 构建与兼容范围

`npm run ui:prepare` 从固定版本官方 `dsh-client-web`、共享 React/控件和可重放补丁重建前端壳，再生成品牌资源、字体和主题数据。单独修改 `ui-primitives/lib` 不会影响上游 npm 分发的冻结 seed，因此必须重建；不能只修改源码后声称安装包生效。原有 ModuleLoader 队列、bootstrap、模块图和 Cordis 激活顺序保留。浏览器构建沿用已发布壳的 Node API 拒绝 shim 和 Node 版本 `0.0.0` 定义，不给 renderer 增加 Node 能力。

颜色通过公开 `theme.overrideTokens` 生命周期接口接入，遵循原有 light/dark/system 偏好与存储键；控件、菜单、表单和弹窗保留 Harness 实现及事件契约，属于主题适配，不宣称已整体替换为官方 shadcn 组件。保留原生窗口按钮、拖动区、虚拟列表测量、编辑器/用户内容、文件类型业务图形、第三方商标及工作台自带图形。独立启动/恢复页保留离线系统字体和原 CSP，不把 Web 字体加载成功作为这些页面的验收结论。

Geist/Geist Mono 固定为 5.2.6，Noto Sans SC 固定为 5.3.1，Lucide React 固定为 1.57.0。所有字体分片离线随包分发，使用 Unicode ranges 和 swap；许可、文件摘要及版本记录随生成资源分发。字体遵循随附 OFL，Lucide 保留其 ISC/Feather MIT 声明；用户提供的 HQZY 图标不声明为这些开源许可。

## 产品身份

| 用途 | 生产 | 开发 |
| --- | --- | --- |
| 应用名称 | HQHarness | HQHarness Dev |
| Application ID | `app.hqharness.desktop` | `app.hqharness.desktop.dev` |
| 用户数据目录名 | `hqharness` | `hqharness-dev` |
| 安装包文件名前缀 | `hqharness-` | `hqharness-dev-` |

用户数据位于 Electron 对应平台的 per-user application data 目录。独立目录避免覆盖 DSH Desktop 的 Profile、插件和会话；本次改造不自动迁移上游数据。多个开发 worktree 默认仍可能共享 `hqharness-dev`，不得并行修改同一个 Profile。

`DSH_HOME`、`dsh.client`、`.dshpreset`、IPC 和 `@deepseek-ai/*` 包名属于上游兼容契约，保留这些技术标识。模型提供商名称按真实服务商展示，不能因品牌改造替换成 HQHarness。

## 链接与归属

未配置的官网、支持地址、更新地址、桌面服务、发布仓库和签名发行者保持 `null`。不能用上游官网、社区二维码、发布 bucket 或签名公司填补缺省值，也不能把未发布、未签名的本地构建描述为正式发行版。配置和发版流程见 [HQHarness 发布指南](hqharness-release.md)。

保留 [MIT LICENSE](../LICENSE) 中的 DataElement 原始版权，以及第三方依赖的许可证和必要声明。上游来源为 [dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop)，基线 commit `115a0b474cc2c4794316171c640a8898398591fe`。历史架构和协议文档可以保留上游技术名称；新产品文案应使用 HQHarness。
