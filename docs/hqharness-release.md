# HQHarness 发布指南

HQHarness 的发布仓库为私有仓库 `jiawenyao401/HQHarness`。更新服务、签名证书和官网尚未配置；未签名验收包须明确标为 Pre-release，不能视为已通过签名、公证或全部已安装应用验收。以下正式发布流程仍要求对应的签名和安装门禁。

## 发布配置

在 [`brand.config.json`](../brand.config.json) 中填写真实、由 HQHarness 维护者控制的配置：

| 字段 | 默认值 | 配置要求 |
| --- | --- | --- |
| `releaseRepository` | `jiawenyao401/HQHarness` | 自有 GitHub `owner/repo`，必须与执行 workflow 的仓库一致 |
| `publisherName` | `null` | 自有 Windows 签名证书的准确发行者名称 |
| `updateBaseUrl` | `null` | 自有 HTTPS 更新服务基址，按客户端的 metadata/archive/catalog 路径契约部署 |
| `desktopServiceUrl` | `null` | 自有桌面服务；未配置时不请求上游业务服务 |
| `supportUrl` | `null` | 实际支持入口；未配置时不展示虚构社区链接 |

执行 `npm run brand:prepare` 并重新构建，使配置进入应用和打包输入。启用更新前，必须同时修改 `package.json`：`build.publish` 使用 `generic` provider 和 `updateBaseUrl` 对应的 `latest/` feed；`build.win.signtoolOptions.publisherName` 与自有证书和品牌配置一致，且 `verifyUpdateCodeSignature=true`。`brand:prepare` 会强制校验这些条件，不匹配时阻止构建；它不会代替维护者填写配置。

发布验证器 `.github/scripts/validate-release-config.mjs` 在发布、回填和 Windows 签名前检查配置。发布目标必须是当前自有仓库，禁止使用 `dataelement/dsh-desktop`。没有目标仓库或匹配的发行者时，正式发布会停止；普通 PR 和 unsigned development 不需要签名凭据。

## CI 和手动模式

[HQHarness desktop installers](../.github/workflows/release.yml) 在 PR 中使用原生 macOS Apple Silicon、macOS Intel 和 Windows x64 runner，执行依赖安装、构建、测试、typecheck 及对应平台打包验证。每个目标必须通过 `scripts/verify-target.mjs`，不能在其他平台交叉生成可分发的原生安装包。

当前依赖资格基线保持 Harness `0.2.0-rc.2`，构建使用 Node.js 24：

| 依赖 | 锁定版本 | 资格与验收要求 |
| --- | --- | --- |
| Electron / native loader | `44.7.0` / `node-addon-require-builtin@0.1.9` | 精确配对验证 Node/V8 fingerprint；本次本机 macOS ARM64 probe 已通过。Windows x64 和 macOS Intel 必须分别通过原生 CI，不把本机结果作为其验收 |
| sharp | `0.35.5` | 同分支安全补丁；验证图片附件、品牌图标与 PPT 渲染 |
| MCP client / core | `2.2.0` / `2.2.0` | 限定 Harness MCP client 的 override；验证 HTTP 与 stdio 传输及工具调用 |
| image-size | `2.0.3` | 超出 PPTXGenJS 原声明的 1.x 范围；需模板、图片与真实 PPTX 输出验收 |
| http-cache-semantics / source-map-js | `4.3.0` / `1.2.2` | 同 major 更新；缓存公告存在上游争议，不把退出 audit 范围当作漏洞修复实证 |
| fflate / fast-uri | `0.8.3` / `3.1.8` | 确保 Office 内嵌压缩库副本也更新，验收真实文档转换与 URI 路径 |

`Electron43.7.9 + loader0.1.9` 曾在真实 probe 中被拒绝；不得跳过 fingerprint gate。后续升级也须重新执行精确配对、真实 Harness 子进程和安装后的应用验收。每次发布另存 `npm audit --json` 并核对运行时与构建依赖；audit 无运行时命中不替代功能、签名或平台验收。

手动 `workflow_dispatch` 的 `target` 可以是 `all`、`macos` 或 `windows`：

- `development`：默认模式，构建独立的 unsigned `HQHarness Dev`，仅保存 workflow artifacts。
- `signed`：填写不含 `v` 的 `signed_version`，签名所选平台并保存 artifacts；不发布到 GitHub 或外部服务。
- `prerelease`：填写不含 `v` 的 `prerelease_tag`；仅 `target=all` 且三个平台及签名安装验收全部通过时，发布到当前自有 GitHub 仓库，标记为 Pre-release。单平台只签名并保留 artifacts。
- `resign`：`target=windows`，填写 `unsigned_run_id` 和该产物准确的 `signed_version`，重新签名已保存的 Windows artifact，完成真实安装验收。
- `smoke`：`target=windows`，填写 `smoke_run_id`，重新验证已有最终 signed artifact。

正式发布由自有仓库的 `v*` tag 触发。GitHub Release 发布 job 等待两种 macOS 架构、公证、Windows 内部 PE 签名和最终安装验收成功，并先验证安装包和配置启用的更新 metadata。禁止复用已经公开的版本标签。

## macOS 自有签名与公证

创建以下自有仓库/环境 secrets：

- `HQHARN_CSC_LINK`：自有 Developer ID Application `.p12` 的 base64 或 HTTPS 来源
- `HQHARN_CSC_KEY_PASSWORD`：证书密码
- `HQHARN_APPLE_API_KEY`：Apple API `.p8` 内容
- `HQHARN_APPLE_API_KEY_ID`、`HQHARN_APPLE_API_ISSUER`、`HQHARN_APPLE_TEAM_ID`

workflow 将证书导入临时 keychain，签名 app 和 DMG，提交 Apple 公证、staple 并用 `codesign`、`spctl`、`stapler validate` 验证。临时证书和 keychain 在完成或失败后清理。没有自有有效证书和公证结果的文件不能声称已正式签名。

## Windows 自有签名与安装验收

当前签名适配采用 SafeNet UKey 和固定 SHA-256 的 Jsign，不借用上游设备、公司或 secrets。由维护者注册专用 macOS ARM64 self-hosted runner，标签为 `self-hosted`、`macOS`、`ARM64`、`hqharness-signing`，安装 SafeNet Authentication Client，并确认 `/usr/local/lib/libeTPkcs11.dylib` 可读。

创建受保护的 `hqharness-signing` environment 和 secret `HQHARN_WINDOWS_SIGNING_PIN`，另创建 repository variable `HQHARN_WINDOWS_PUBLISHER_NAME`，其值须精确等于 `brand.config.json.publisherName` 和自有证书发行者。设备或证书类型不同，应先实现并验证新的签名适配，不能绕过当前签名门禁。

GitHub-hosted Windows runner 构建 unsigned NSIS；专用 runner 下载并校验 artifact，提取 `win-unpacked.tar.gz`，从真实 `resources/app.asar/package.json` 校验应用名称、产品名称及目标版本，然后才开始签名。此检查适用于所有签名模式；`resign` 不依赖可缺省的 `latest.yml`，也不相信安装器文件名或旁路版本清单。随后按文件内容遍历所有 PE，保留第三方已有签名、签署未签名 PE，重新打包并签署安装器，然后重建 blockmap/metadata。PIN 仅在签名步骤写入权限为 `600` 的临时文件，并在退出时删除。

Windows 原生 runner 安装最终 signed artifact，验证发行者及每个 PE 的有效签名、Harness 启动、Office runtime、重复安装、失败升级恢复及 Profile 数据保留。这些检查通过之前不能发布。为 `hqharness-release` environment 配置保护规则并限制发布 tag/workflow 修改权限。

## 更新服务与资产备份

`updateBaseUrl` 与 `desktopServiceUrl` 必须同时配置，且仅安装后的生产版本支持更新。自有桌面服务需要实现客户端的 `GET v1/updates/check` 策略接口，返回 `{ updateAvailable: false }` 或 `{ updateAvailable: true, version, feedUrl }`；`feedUrl` 必须准确指向配置基址下的 `archive/<version>/`，客户端还会校验版本与预发布策略。服务端应按当前源码协议部署并完成请求/失败路径验收，静态文件站点不能替代此接口。

`updateBaseUrl=null` 时没有自动更新 feed，也不默认连接上游更新网站；安装包可通过配置的自有 GitHub Release 分发。更新地址启用后，必须部署 metadata、安装器、ZIP/blockmap 和版本 catalog，验证内容散列、签名与 macOS 双架构选择，再用已安装的 HQHarness 完成一次下载、重启安装和回滚验收。

已安装应用启动更新管理器时还会读取真实 `resources/app-update.yml` 并核对 feed；Windows 同时核对配置发行者。文件缺失、feed 不匹配或发行者不匹配会禁用运行时更新。因此 unsigned/default 包即使随后填入服务地址，也必须重新打包并完成签名更新验收才能启用更新。

现有发布 workflow 只写入当前自有 GitHub 仓库。不会自动镜像到 ModelScope、上传上游 bucket、设置上游 rollout 或发送 Feishu 业务通知。`.github/scripts/` 中保留的上游通知测试辅助代码未接入 HQHarness 工作流。

[HQHarness release archive backup](../.github/workflows/backfill-archive.yml) 仅在显式 dispatch 后下载自有仓库已存在的 release，运行资产校验，生成 SHA256SUMS 并保存 7 天 artifact。它不改变线上更新 catalog，不上传外部服务，不能替代长期备份。GitHub Release 是当前持久分发副本。后续接入自有存储须明确实际 API 与部署验证，不能填写一个不存在的服务地址就宣称已完成发布。

Development artifacts 保留 3 天、签名产物和备份保留 7 天、Windows unsigned 签名交接保留 1 天。过期后应重新构建；不能依赖已失效的 workflow artifacts。

## 发布前后验收

提交前执行 `npm run typecheck`、`npm run build`、`npm test` 和 `git diff --check`。发布前在各目标原生平台验证安装与首次启动、实际客户端 UI、模型配置、普通 Profile 和 Safe Mode、插件加载、Office/PPT 输出以及新数据目录。更新配置启用后再验收真实更新与签名发行者。源码测试、打包、安装、签名、公证、激活和正式发布分别记录结果，不能相互替代。

## Windows 安装包文件名

本机 Windows x64 执行 `npm run package:win`，验收工作流使用同一入口。签名发布在最终签名后生成交付文件名 `Huaqing-Desktop-<version>-x64-<sha256>-<timestamp>.exe`。SHA256 为最终 EXE 字节的 64 位小写十六进制摘要，时间为 UTC，格式为 `YYYYMMDDTHHMMSSZ`。同批 blockmap 与 `latest.yml` 使用该文件名。Windows 的安装目录与程序名仍为 HQHarness，以兼容现有安装。
