# 桌面端 xasp OA

内置技能覆盖差旅报销、往返居住地报销、出差申请和业务接待报销。技能在普通 Harness Profile 中注册。桌面主进程按会话管理草稿，使用安装包内的 xasp CLI/SDK 直连 OA TEST。可在会话中核对材料、保存未提交草稿、补写已支持的字段并回查。

## 构建和验收

构建在本机原生目标上运行。先执行 `npm ci`，再指定能读取 [固定 xasp 提交](../scripts/xasp-runtime/lock.json) 的授权私有 checkout。构建只读取锁定提交中的业务源码和参考资料。Python 复用 Office 运行时，OA 依赖按目标及 SHA-256 校验。部署维护者设置 `XASP_REQUIRE_BUNDLE=1` 可让缺少源码的构建立即失败。未配置 xasp 输入的普通发行构建会生成禁用清单。

```sh
export XASP_SOURCE_ROOT=/path/to/authorized/xasp
export XASP_REQUIRE_BUNDLE=1
npm test
npm run typecheck
npm run package:dev:mac:arm64
```

Intel Mac 使用 `npm run package:dev:mac:x64`。在 Windows x64 的 PowerShell 中使用相同变量并运行原生打包：

```powershell
$env:XASP_SOURCE_ROOT = 'C:\path\to\authorized\xasp'
$env:XASP_REQUIRE_BUNDLE = '1'
npm test
npm run typecheck
npm run package:win
```

Windows 私有验收使用 [现有验收工作流](../.github/workflows/windows-acceptance.yml)。手工运行时选择 `xasp_bundle` 与 `draft_delivery`。工作流校验私有目标，原生打包及安装后运行包内 OA 探针。

在私有 HQHarness 仓库的「Settings → Secrets and variables → Actions」中，选择一种方式配置源码读取权限。

- `XASP_CHECKOUT_KEY` 使用专用 SSH 密钥。公钥添加到 `hqzyai/xasp` 的 Deploy keys，保留只读权限。私钥保存为 HQHarness 同名 Repository secret。
- `XASP_CHECKOUT_TOKEN` 使用 GitHub fine-grained token，资源所有者设为 `hqzyai`，仅选 `xasp` 仓库和 `Contents` 只读权限。令牌保存为 HQHarness 同名 Repository secret。

工作流要求两个密钥名中恰好配置一个。OA TEST 凭据由客户端设置保存。

双平台签名验收使用 [安装包工作流](../.github/workflows/release.yml)的手工 `signed` 模式，选择 `target=all` 和 `xasp_bundle`。签名及公证配置遵循 [发布指南](hqharness-release.md)。选择 `prerelease` 时，发布目标须与配置中的私有仓库一致。常规标签发布默认生成禁用清单。

构建默认使用 [锁文件](../scripts/xasp-runtime/lock.json)中可追溯到 xasp 验证记录的 TEST `wwb` 差旅报销绑定和发票来源码。部署维护者可以通过环境变量或同名 CI 变量 `XASP_TEST_WORKFLOW_CONFIG` 更新已核验的来源码。允许 `travelWorkflowBinding` 和 `homeInvoiceSourceFlag`。前者包含 `workflowId`、`formId`、`schemaSha256` 和可选 `invoiceSourceFlag`。流程编号、表单编号和 Schema 摘要须与锁定版本一致。缺少绑定的差旅报销和缺少来源码的往返居住地发票会在写入前报告缺项。

安装包验证器从实际资源目录调用随包 Python，运行四项业务的离线检查、原件文本解析、跨进程锁和模拟上传。验证器还从同一资源目录加载实际随包的 OA 执行器，模拟四项业务的草稿写入与回查，覆盖发票关联和写入结果未知时的恢复。真实 OA 验收须使用已核验身份和实际 TEST 材料，分别验证操作人、表单、附件、草稿编号与未提交状态。记录目标架构、安装包和回执状态即可。

运行 `node scripts/xasp-runtime/verify-installed.mjs <应用可执行文件>`，可在隔离的 Profile 中验证真实启动、四项技能发现、客户端模块注册及界面中的「添加 OA 原件」按钮。Windows 验收流程在安装与升级后执行此项检查。

## 使用

1. 在有权访问 OA TEST 的网络中打开「设置 → 内置插件 → OA 业务」。录入本次测试的应用凭据、测试账号和操作人姓名，保存前会查询并核验唯一的 OA 操作人。应用凭据使用系统加密存储。
2. 开启会话并调用对应的内置 OA 技能。用输入框旁的「添加 OA 原件」传入 PDF、图片等实际材料，保留原始字节。
3. 核对技能返回的输入缺口。报销须先确认与报销人匹配的收款信息，客户端会在上传前核对当前 OA TEST 的表单字段。在同一会话里，可以先附上原件，再发消息说明要核对的 OA 流程。使用上一轮原件保存草稿前，该流程须完成原件核对。上传新材料会替换待核对的批次。应用重启后，如需继续办理尚未保存的草稿，请重新附上原件。保存时确认系统弹窗中的环境、操作人和附件数量。仅在独立回查成功后，客户端才确认 OA 草稿已保存。
4. 在同一会话回查已有草稿。补写时可以指定三个报销流程的收款信息、往返居住地报销的居住城市，或出差申请指定行程段的目的地。桌面弹窗会列出拟补写的值，由用户确认后写入原未提交草稿。
5. 办理另一张同类草稿时开启新会话。桌面收到建单回执后立即保存 OA 草稿编号，用于同单回查。若回执未到，且 OA 保留了提交的标题，桌面会尝试用标题中的回查编号核验流程、操作人及完整表单。若回执未到且 OA 改写了标题，需要从 OA TEST 流程列表人工核对原单。此时保留当前会话及恢复状态。

往返居住地报销会先按票据时间检查行程顺序。OA 时间控件按小时显示，原票分钟保存在草稿备注中。备注与原票时间合计超过 OA 的 100 字限制时，客户端会提示精简备注。缺少到达时间时，只有 OA TEST 表单允许留空才可保存。回查核验后会列出仍需补齐的字段。

普通 Profile 的启动目录保持中立。程序从安装资源读取技能和执行器，在应用数据目录下保留私有会话任务、材料和恢复状态。Safe Mode 使用独立组合。凭据清除会删除当前本机授权，保留用于回查的草稿状态。
