# dsh-desktop-workbenches

HQHarness host plugin for the DataElem community's Awesome DSH Workbench market, local workbench state, navigation and the native conversation frame.

Market metadata comes exclusively from the published Awesome protocol v2 index. Runtime providers register their own component and runtime ID. A provider that wants to be recognized as the installed form of an Awesome entry must include the canonical GitHub URL in its registration descriptor's `repository` field.

The host does not bundle a separate catalog or third-party workbench packages. It installs, updates and uninstalls catalog entries on the user's request through Desktop's isolated-generation boundary (`desktopPnpm.installWorkbenchGeneration`) and records them in `market-installs.json`; see `docs/workbenches.md`.

## 两份 DataElem 上游规范与来源链接

开发和上架分成两份 DataElem 上游文档，内容不重复。下面的官网链接属于 **DataElem 的 DSH Desktop 项目**，不是 HQHarness 的支持或发布渠道。页面和 README 链接到上游阅读页，给 Agent 的指令链接到同一文档的 Markdown 原文。HQHarness 内附同一份原文的副本，离线路由会先展示上游归属和本机验证说明，再返回完整原文。

HQHarness 保留兼容的 Harness 包格式和插件协议。本地使用须记录实际验证的 HQHarness 版本、操作系统和架构；未测试的平台不声明兼容。公共市场投稿继续遵循 DataElem 上游验收要求，包括其要求的 DSH Desktop 实测，不将 HQHarness 的验证结果自动替代上游验收。

| 文档 | 官网阅读页（给人看） / Markdown（给 Agent） | 来源 | Desktop 离线副本 | 何时需要 |
|---|---|---|---|---|
| 工作台开发规范 | https://dshdesktop.com/workbench/docs/development/ ／ `development.md` | `docs/workbench-standard.zh.md` | `development-guide.zh.md`，`/api/desktop-workbenches/author-guide`（兼容别名 `/development-guide`） | 开发并在本机自测；只自己用时只需要这一份 |
| 工作台市场验收规范 | https://dshdesktop.com/workbench/docs/market-acceptance/ ／ `market-acceptance.md` | `docs/workbench-market-acceptance.zh.md` | `market-acceptance.zh.md`，`/api/desktop-workbenches/market-acceptance` | 想上架到工作台市场时 |

修改来源后：

```bash
node scripts/build-workbench-guide.mjs                          # 更新 Desktop 离线副本
node scripts/build-workbench-guide.mjs --site <官网仓库>/workbench  # 更新官网的两份文档和阅读页
```

两个命令都支持 `--check` / `--site-check` 检查是否一致。官网文档随官网部署发布；生成副本勿单独修改。收录 YAML 的字段以 GitHub 工作台市场仓库为准。
