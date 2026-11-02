# 本机 WPS 文档操作

Huaqing Desktop 的内置 `hqharness-wps` 插件通过本机 MCP 服务连接 WPS JS 加载项。客户端安装在哪台电脑，就操作那台电脑上打开的 WPS 文档；不使用 WPS365、云文档 API 或独立 Agent。文档内容通过当前会话的模型处理，不能将“文件保存在本机”解释为“内容不会发送给模型”。

## 首次启用

1. 先保存文档，完全退出 WPS。
2. 打开客户端的「设置 → 内置插件 → WPS 本机文档」，点击启用/修复并确认本机注册。
3. 重新打开 WPS 文档。如果 WPS 弹出“加载项已被修改，是否继续加载”，核对本产品的 HuaqingDesktop 加载项并由你确认。该对话框未处理前，WPS 不会执行入口脚本，其他命令也可能被模态窗口阻塞。
4. 刷新连接状态。注册成功、文档已连接、实际修改成功是三个不同状态。

不需要安装 Python、Node、MCP 服务或另一个助手。加载项需要 WPS 发行版实际支持 JS 加载项；WPS 本体由用户安装。macOS 与 Windows 使用各自用户的加载项目录，不改变宏策略，不替换其他加载项。该目录尚不存在时应先正常运行一次 WPS。

## 操作范围

公开工具为 `mcp__huaqing_wps__wps_use`。先用 `documents` 取得当前会话的文档句柄，再读取并使用返回的快照修改。

| 操作 | 范围 |
| --- | --- |
| `inspect` | Writer 正文片段、表格工作表元数据、演示文本形状；截断结果明确标记 |
| `sheet_read` / `sheet_write` | 明确工作表及矩形 A1 区域，每次最多 1000 格；值与公式分开，写前核对原值，写后回读 |
| `writer_replace` | 替换已观察正文中唯一匹配的文字；不操作页眉、批注等其他 story |
| `slide_text` | 通过已观察的 SlideID 与 Shape.Id 修改文字；不按当前选中形状重定向 |
| `save` | 保存绑定文档当前本机路径，每次单独确认，先备份磁盘原件；不接收任意输出路径 |
| `recover` | 对未确认结果重新读取，须由用户在原生对话框明确确认；不会重放旧修改 |

未保存的新文档可在 WPS 中操作；首次落盘请使用 WPS 的保存界面。最大本地文件为 256 MiB，不支持 UNC/设备路径、云 URL、任意宏、VBA、通用 JavaScript 或退出 WPS。某些复杂格式与 WPS 对象接口不可用的功能仍需 Computer Use。

### 公式计算范围

`formulas` 只接收以 `=` 开头的字符串矩阵，每条最长 4096 字符、表达式最多嵌套 32 层。支持数字、文字、布尔值、四则/幂/比较/拼接/百分比、A1 单元格引用，以及每个不超过 1000 格的静态矩形引用；支持中文工作表名、`'季度 汇总'!$A$1` 和成对单引号转义。参数使用英文逗号，不支持省略参数。清空单元格用 `values: [[null]]`，不要向 `formulas` 传 `null`。

函数白名单为：`SUM`、`AVERAGE`、`IF`、`COUNT`、`COUNTA`、`COUNTIF`、`COUNTIFS`、`SUMIF`、`SUMIFS`、`ROUND`、`MIN`、`MAX`、`INDEX`、`MATCH`、`XLOOKUP`、`VLOOKUP`、`HLOOKUP`、`AND`、`OR`、`NOT`、`ABS`、`INT`、`MOD`、`ROUNDUP`、`ROUNDDOWN`、`CONCAT`、`CONCATENATE`、`LEFT`、`RIGHT`、`MID`、`LEN`、`TRIM`、`LOWER`、`UPPER`、`IFERROR`、`SUMPRODUCT`、`COUNTBLANK`、`PRODUCT`、`SQRT`、`POWER`、`CEILING`、`FLOOR`、`TRUE`、`FALSE`。函数名不区分 ASCII 大小写，仍要求目标 WPS 版本实际支持相应内置函数。

外部工作簿/结构化引用 `[]`、URL（含引号内）、UNC/反斜杠路径、DDE 管道、命名范围、UDF/特殊函数命名空间、数组常量、整行/整列/3D 引用、动态引用与表达式返回值调用均拒绝；`WEBSERVICE`、`RTD`、`EXEC`、`INDIRECT`、`OFFSET`、`EVALUATE`、`LET`、`LAMBDA` 不在计算范围内。不能解析或不在白名单中的公式返回 `WPS_INVALID_INPUT`，应修改为支持的计算，不能换 GUI、脚本或另一条接口绕过执行。

这项检查只限制新写入的公式文本，不是完整计算沙箱；已有工作簿的宏、外链、UDF、计算事件及依赖重算不因此被隔离，动态数组行为仍取决于目标 WPS 的实际接口。它不能代替 WPS 原有安全策略和真实文档验收。

## 授权、保存与恢复

查看文件列表、读取文档及修改文档分别授权。会话授权 30 分钟有效，工作区外文档明确提示；read-only 模式禁止修改。紧急停止同时撤销 Browser/Computer/WPS 授权并取消排队任务，不关闭用户 WPS 文档。

写入是 WPS 内存操作，不宣称数据库事务或通用 Undo。表格 JavaScript 修改不能依靠普通 Undo 保证恢复。保存包含用户在同一文档的其他未保存编辑，因此每次保存都单独确认。磁盘文件在观察后改变、链接改指、文档路径改变、快照过期或目标内容变化时，旧保存/修改请求拒绝执行。

保存结果区分 WPS API 与文件核对：`verification: wps_api_and_local_file` 表示 WPS 报告已保存，且绑定本地文件存在、非空并取得摘要；`coverage: observed_content_only` 表示观察范围内回读通过，**不等于对完整排版和全部嵌入对象做了独立重开验证**。备份和操作日志位于当前 Desktop userData 的 `wps/backups` 与 `wps/operations`，不是用户工作区。保留恢复材料，不自动删除原件或猜测回滚。

断线、取消或超时后，已发出的原生调用可能仍会执行。文档会冻结后续写入，冻结跨客户端重启保留；必须先检查实际文档再 `recover`。不会自动改用 GUI、脚本或另一条 MCP 重放。临时修改、部分完成和未确认结果必须如实显示。

## 构建与验收

WPS 工具属于 Profile 组合及后端工具阶段：从当前安装的自有包读取，插件使用安装包内官方 MCP SDK；Main 管理私有 loopback、授权、文档队列与日志。客户端只增加设置 slot，不改变 HTML/bootstrap 顺序。Safe Mode 不加载 WPS 插件。

自动化测试覆盖模拟对象、真实 MCP HTTP/WebSocket、真实 Harness/PTC 路由与临时文件恢复；模拟对象不能替代真实 WPS。目标平台还须记录 WPS 版本、安装包版本、实际加载项连接、读写回读以及保存后重开结果。没有安装 WPS 的 Windows CI 只能验证包闭包和协议，不能声明 Windows WPS 三组件已验收。

注册布局参考 MIT `humoumou1215/wps-assistant` 固定提交 `dda67065086a46450d0aa72eab77954b61ba42d6`；完整许可随 `hqharness-wps/THIRD-PARTY-NOTICES.txt` 分发。未引入其 Agent runtime。研究依据见 [本地项目调研](wps-local-mcp-research.zh.md)、[官方接口调研](wps-official-mcp-research.zh.md) 和 [Harness 接入核对](wps-mcp-harness-integration.zh.md)。
