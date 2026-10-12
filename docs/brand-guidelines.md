# HQHarness 品牌规范

HQHarness 是复用 DeepSeek Harness runtime 和 Web UI 的独立桌面宿主。产品名称统一为 `HQHarness`，开发应用使用 `HQHarness Dev`。不得在应用标题、菜单、启动页、恢复页或宣传文案中将本产品归属写成 DeepSeek 或 DataElement。

## 品牌输入

[`brand.config.json`](../brand.config.json) 管理产品名、应用标识、用户数据目录、颜色和可选服务地址。[`build/brand-mark.svg`](../build/brand-mark.svg) 是 HQ 标识的权威矢量输入。主色为深蓝 `#13283F`，强调色为青绿 `#14B8A6`；深色背景上的标识使用浅色，正文和操作标签须保持可读性。

`npm run brand:prepare` 从权威输入生成 `.build/brand/` 下的 PNG、ICO、ICNS 和浅色/深色加载动画。postinstall、dev 和 build 会准备并安装品牌资源，生成目录不提交到 Git。不重复维护手工生成的图标副本；旧上游资源若仍用于历史参考，不应作为新安装包输入。

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
