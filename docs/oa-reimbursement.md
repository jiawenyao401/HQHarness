# 客户端 OA 报销

华清桌面的普通会话内置华清 CLI 和 `oa-workflow-expense`。在会话中说明报销类型和目标 OA 连接。把材料放在当前工作区，或作为文件附件上传到同一会话。助手会加载报销 Skill，并通过 `huaqing_oa` 调用安装包内的 CLI。已有草稿可提供 OA 单据编号，以便先回读单据和票据状态。

例如，材料已在工作区时可以这样发起任务：

> 用已配置的 `oa-production` 连接，根据当前工作区的材料准备差旅报销草稿。先核对票据和单据字段，再保存草稿并回读。

## 首次连接

OA 连接使用组织授权的 OpenAPI 应用和已核实的 OA 操作者。请让 OA 管理员提供配置和受控凭据引用。华清桌面的模型登录与 OA 应用会话分别认证。可以先在会话中请助手检查已配置的 OA 连接和登录状态。

| 平台 | 默认 `config.json` 位置 |
| --- | --- |
| macOS | `~/Library/Application Support/huaqing/config/config.json` |
| Windows | `%APPDATA%\huaqing\config.json` |

`HUAQING_CONFIG_HOME` 可在受管部署中指定配置目录。配置格式见随包 Skill `oa-auth` 的 `references/connection-setup.md`。其中 `appKeyRef` 和 `appSecretRef` 保存凭据引用。通过受控文件、系统钥匙串或客户端启动环境注入实际凭据值。配置中的 `operatorId` 使用已核实的 OA 人员 ID 字符串。

确认连接与操作者后，可在会话中指定该 profile 建立 OA 应用会话。对外写入和实际提交由客户端请求单次确认。遇到处理结果未决时，沿用同一 profile 和执行标识回查原操作。

## 安装与升级

CLI、Skill 和参考资料随桌面版一起安装。客户端启动时从当前安装目录加载同一份制品。OA 配置、凭据和执行状态仍使用 CLI 的用户级目录，因此桌面更新可以替换程序和 Skill，并保留现有 OA 连接和状态。回退前按随包的 `huaqing-cli/docs/state-maintenance.md` 检查 SQLite schema 兼容性。安全模式用于恢复桌面运行，回到普通会话后可继续 OA 操作。
