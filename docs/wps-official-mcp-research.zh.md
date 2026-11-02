# 本机 WPS 自动化：官方接口与 MCP 边界调研

调研日期：2026-11-02。目标是 **Huaqing Desktop 安装在哪台电脑，就控制该电脑正在运行的 WPS；文档文件保留在本机**。目标平台为 Windows x64、macOS arm64。官方研究最初只核查公开文档、官方人员回复及官方分发文件，未做实机验收；后续主代理已在 macOS WPS 12.1.28496 取得注册采纳、原生确认框及资源加载阶段的真实证据，见第 6 节。当前项目的真实 WPS API 读写、保存及重开验收尚未通过，不能据加载阶段证据宣称三件套接入成功。未连接真实账号或上传用户文档。

## 结论

官方已经提供可操作本机文档的 WPS JavaScript 加载项及对象模型。适合本需求的方向是 **本机 MCP → 本机桥接 → WPS 加载项/桌面对象模型**；不能用 WPS 365 云端 MCP 代替，也不能把 Windows COM 包装成 macOS 能力。这里的 MCP 桥接须由项目实现并独立验收；本次查到的官方 Office 桌面开发文档没有给出一个可直接连接、覆盖文字/表格/演示三件套的官方本机 MCP 服务地址。[客户端开发概述](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-client-dev-introduction)、[加载项概述](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/addin-overview)、[官方 MCP 定位](https://open.wps.cn/documents/app-integration-dev/mcp-server/introduction)

**macOS 的 JS 加载项确实存在，不能判为“不支持 Mac”。** 官方客户端概述列出 MacOS；官方社区中带“@金山办公”标识的技术支持与反馈人员也直接确认了 Mac 加载项行为。但公开加载项部署文档仍主要列 Windows/Linux，缺少能直接用于双平台交付的当前版本、发行渠道、arm64、三组件 API 兼容矩阵。选定具体 WPS 版本并完成真实验收，才可以承诺产品支持。[客户端平台说明](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-client-dev-introduction)、[Mac 加载项官方技术支持回复](https://forum.wps.cn/topic/47533)、[Mac 加载项官方限制回复](https://bbs.wps.cn/topic/90097)

## 1. 四种名称相近的能力

| 能力 | 控制对象与连接方式 | 对本需求的判断 |
| --- | --- | --- |
| WPS Office JS 加载项 | 加载项运行在 WPS 宿主中，通过 `window.wps` 和对象模型交互；官方另提供 `WpsInvoke.InvokeAsHttp` 调用指定加载项方法 | 与本机文档目标匹配，需要本机 MCP 桥及目标实例绑定。它本身不是 MCP。 |
| WPS 原生/C++ 集成、Windows COM 路线 | 本机桌面应用及其对象模型；官方 C++ 文档区分进程内调用与进程外调用，进程内方案注明仅 Windows | 可作为 Windows 适配路线；不能由此推导 macOS COM 或两个平台拥有完全相同的 ABI。 |
| WPS 365 MCP | `openapi.wps.cn` 的远程服务，封装 365 OpenAPI、访问云端业务数据 | 不符合“控制本机已打开文档”的目标。 |
| WPS 笔记 MCP | 笔记客户端提供本地 Streamable HTTP 服务 | 属于笔记产品，不是 Office 三件套自动化。 |

依据：[加载项开发说明](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/wps-addin-development-instructions)、[C++ 集成概述](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/c-app-integration-wps-guide/c-app-integration-overview)、[365 MCP 简介](https://open.wps.cn/documents/app-integration-dev/mcp-server/introduction)、[笔记 MCP 管理员教程](https://bbs.wps.cn/topic/97117)。

这里“文件保留本机”指文件存取与 WPS 执行地点；如果 Harness 使用远程模型，交给模型的正文或选区仍会进入该模型请求。MCP 运行在本机不会自动改变 Harness 的模型数据流。这是架构推论，不是 WPS 声称提供的额外隐私保证。

## 2. 本机接口的官方支持证据

### Windows x64 与 macOS arm64

| 核查点 | 官方可确认的事实 | 不能据此承诺的内容 |
| --- | --- | --- |
| 总体平台 | 当前客户端开发概述列出 Windows、Linux、MacOS、鸿蒙，允许通过加载项、宏及原生集成扩展 WPS | 所有接入方式都同时覆盖四个平台、所有 CPU 与所有 WPS 版本 |
| 加载项概述 | 官方称其可创作、格式化和操控文字、电子表格、演示文稿；该页平台描述仍只写 Windows/Linux | 不能只依据这一旧描述认定 Mac 没有加载项，也不能当作最新 Mac 支持矩阵 |
| Mac 第一方旁证 | 官方技术支持 2025-03-05 确认 Mac 6.13.0 起支持加载项；2026-09-09 确认 build 28492 起上线 58890 本机服务。另有旧版调试器与本地图标限制回复 | 历史最低版本及安装通信服务不等于当前发行渠道、arm64 与三组件 API 全量兼容合同，也不证明某个加载项已激活 |
| publish 部署 | 官方推荐 `wpsjs publish` / `publish.xml`；旧 `jsplugins.xml` 模式自 `12.1.0.16910` 起受限。支持条目仍为 Windows 企业版 20200425 分支后、Linux 企业版 20200530 分支后 | 不应把历史条目当成 2026 年最低版本承诺；没有当前 Mac publish 部署矩阵 |
| 安装渠道 | 可用性页要求安装包带加载项能力，个人用户下载官网最新包，企业用户联系项目负责人 | 未证明个人版全部渠道、企业版全部 SKU、Mac App Store/官网包具有相同能力 |

来源：[当前客户端概述](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-client-dev-introduction)、[加载项概述](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/addin-overview)、[Mac 加载项与配置目录官方回复](https://bbs.wps.cn/topic/50515)、[Mac 58890 服务版本官方回复](https://bbs.wps.cn/topic/76294)、[Mac 调试器官方回复](https://forum.wps.cn/topic/47533)、[Mac 图标限制官方回复](https://bbs.wps.cn/topic/90097)、[部署规则](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/wps-addin-development-instructions)、[安装包可用性](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/addin-api/wps-addin-availability)。

可用性页仍包含修改 `oem.ini` 的旧启用步骤，而概述与开发说明已经提示新版本限制并推荐 publish。生产安装器不能机械照抄旧启用步骤、覆盖用户配置或修改 WPS 程序目录，应针对被支持的 WPS 发行版采用经过验证的注册方式。这个判断来自上述官方文档之间的版本差异。[旧可用性说明](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/addin-api/wps-addin-availability)、[新版部署边界](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/addin-overview)

### 已打开文档与三件套

官方对象模型提供当前活动文档及已打开文档集合，因此本机加载项可以直接访问宿主中的文档对象。桥接实现应把这些对象转换为有期限的文档标识，不能把“当前活动文档”当成始终不变的目标。[Writer Application / Documents](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wps/Application/obj)、[ET Application / Workbooks](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/et/Application/obj)

| 组件 | 官方已公开能力示例 | 保存与恢复边界 |
| --- | --- | --- |
| 文字 Writer / `wps` | 文档、选区、文字/格式对象；`UndoRecord` 示例直接修改 `Selection.Range.Text` | `Document.Save()` 保存；未保存过的文档会弹出另存为对话框。`Document.Undo()` 有成功布尔值；支持自定义撤消记录分组。 |
| 电子表格 ET / `et` | `Range.Value2` 可读写；`Formula` 可写，访问打开工作簿及工作表 | `Workbook.SaveCopyAs()` 可以保存副本且不修改内存中的打开工作簿。**`Application.Undo()` 明确不能撤消 JavaScript 命令。** |
| 演示 WPP / `wpp` | `TextRange.Text` 可读写；可访问幻灯片及形状文本 | `Presentation.Save()` 写盘；同名文件可能无提示覆盖。`Saved = msoTrue` 仅改变标记，不会写盘。本次未找到能证明任意一组 WPP API 写操作可事务撤销的官方契约。 |

对应方法：[Writer Save](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wps/Document/member/Save)、[Writer Undo](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wps/Document/member/Undo)、[Writer 自定义撤消记录](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wps/UndoRecord/member/StartCustomRecord)、[ET Value2](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/et/Range/member/Value2)、[ET SaveCopyAs](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/et/Workbook/member/SaveCopyAs)、[ET Undo 限制](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/et/Application/member/Undo)、[WPP 文本读写](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wpp/TextRange/member/Text)、[WPP Save](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wpp/Presentation/member/Save)。这些是 API 文档能力，不代表已经通过本次双平台运行验收。

### 登录、许可、费用与外部调用

本地加载项的官方前置条件是安装 WPS、具备加载项能力、开发时使用 Node.js 和 `wpsjs`。首次创建教程同时提到个人版，不能据此声称本地加载项只允许企业账号。公开页面没有清楚列出“外部本机 MCP 控制三组件”所需的商业授权、分发授权或收费表；不能把没找到价格表写成免费。[创建首个加载项](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/generate-the-first-wps-addin)、[安装包要求](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/addin-api/wps-addin-availability)

官方 `WpsInvoke.InvokeAsHttp(type, name, func, params, callback)` 允许外部网页调用指定组件加载项的方法；`type` 区分文字、表格、演示。文档注明首次启动需用户允许，回调状态区分成功、上次请求未完成、未允许执行。这是一个有用户交互与忙碌状态的调用机制，不是已公布的通用 MCP 或文档事务接口。本次官方 `wps_sdk.js` 相对链接返回 404，不能将该链接当成已经确认可分发的生产 SDK 文件。[外部调用和回调说明](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/wps-addin-development-instructions)

官方 C++ 文档说明 Application 是控制 WPS 的根对象，调用返回值决定操作是否成功，且区分进程内与跨进程集成；它没有提供本需求下 Windows x64/macOS arm64 的完整统一原生 SDK 合同。官方宏 `CreateObject` 也能创建 `kwps.application`、`ket.application`、`kwpp.application` 对象，但这是 WPS 宏环境接口说明，不能当成 Node.js、Python 或 macOS 外部进程都拥有同一个 COM 入口的证据。[C++ 集成合同](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/c-app-integration-wps-guide/c-app-integration-overview)、[宏 CreateObject](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/macro-editor-api/function/createobject)

## 3. 双平台生产接入必须补齐的合同

以下是依据官方接口边界提出的生产接入要求。仓库实现和模拟测试的证据范围与真实 WPS 验收分开记录，当前原生验收进度见第 6 节：

1. **绑定本机实例和文档。** 连接握手返回 WPS 组件、版本/build、实例与文档标识、实际路径、只读/未保存状态。写入必须指向明确文档与范围；用户切换活动标签页后不能改到另一份文件。多 WPS 实例及多文档必须有明确路由。
2. **方法按能力探测开放。** MCP 提供固定、受校验的读写工具；握手不能仅证明桥在线，还要证明对应 WPS 加载项在线且必要方法可用。平台缺方法时返回结构化不支持，不能把属性赋值没报错当成完成。
3. **写入顺序与并发。** 对同一目标文档串行执行修改；多 Agent 或用户同时编辑时校验目标及相关内容是否变化。官方外部调用已有“上一请求未完成”状态，公开文档未给出跨工具事务、CAS、幂等或并发隔离保证，桥必须自行处理重复请求和结果不明的超时。
4. **保存与恢复分开实现。** 写入后回读验证；保存后检查实际磁盘结果。未命名文档、只读文档、权限不足、另存为弹框、同名覆盖都须有明确出口。不能向用户承诺三组件统一 Ctrl+Z；特别是 ET JavaScript 修改应建立独立的恢复策略。磁盘副本还不等于保留用户尚未保存的内存状态。
5. **随宿主交付。** MCP 桥属于现有 Harness 的本机工具，沿用当前运行时；WPS 加载项只承担对象模型操作与事件。注册、更新、卸载要保留用户已有加载项配置；签名与安装资源需要在各自原生安装包验收。

验证应使用可丢弃样本，至少覆盖 Windows x64、Mac arm64 的 Writer/ET/WPP 各一次“已打开文件发现 → 精确读取 → 修改 → 回读 → 保存 → 重开核对”，再覆盖多文档切换、未保存修改、只读、撤销/恢复、桥断线、调用中 WPS 退出与重启。不能用 MCP `tools/list` 成功或源码模拟测试替代这些步骤。

## 4. 云端与笔记 MCP 的排除记录

### WPS 365 MCP 2.0

官方说明它封装 WPS 365 OpenAPI，版本日志记载 2026-01-08 发布 2.0。连接采用远程 Streamable HTTP 与 `Authorization: Bearer <access_token>`；例如云文档地址为 `https://openapi.wps.cn/mcp/v2/kso-yundoc/message`。接入指南要求创建应用、申请权限及用户令牌；它没有把本地路径或已打开 WPS 实例作为输入。[MCP 定位](https://open.wps.cn/documents/app-integration-dev/mcp-server/introduction)、[版本记录](https://open.wps.cn/documents/app-integration-dev/mcp-server/change-log)、[对接指南](https://open.wps.cn/documents/app-integration-dev/mcp-server/use-guide)

公开工具边界如下，不能扩写为本机 Office 编辑能力：

- 云文档：搜索、正文/评论提取、元数据、分享和权限管理；清单未列出正文排版编辑工具。[云文档工具与服务地址](https://open.wps.cn/documents/app-integration-dev/mcp-server/tools/mcp_kso-yundoc)
- 多维表格：创建/改名工作表、读取/创建/更新记录；官方明确仅适用于多维表格，不能用来编辑普通 `.xlsx`。用户授权地址为 `https://openapi.wps.cn/mcp/v2/kso-dbsheet/message`。[多维表格工具](https://open.wps.cn/documents/app-integration-dev/mcp-server/tools/mcp_kso-dbsheet)
- 智能文档：向云端智能文档导入 Markdown 节点，地址为 `https://openapi.wps.cn/mcp/v2/kso-airpage/message`；不是本地 Writer 或 PPT 对象模型。[智能文档工具](https://open.wps.cn/documents/app-integration-dev/mcp-server/tools/mcp_kso-airpage)

365 用户授权文档说明登录、授权回调、令牌交换及刷新；这不是复用本机 WPS 登录态。MCP 页面没有给出本需求可直接采用的固定价格或三件套编辑 SLA；公开 WebOffice 计费页适用于其在线预览编辑产品，不能作为本地加载项或所有 MCP 的价格。[365 用户授权](https://open.wps.cn/documents/app-integration-dev/wps365/server/certification-authorization/user-authorization/flow)、[用户令牌接口](https://open.wps.cn/documents/app-integration-dev/wps365/server/certification-authorization/get-token/get-user-access-token)、[WebOffice 定价适用范围](https://open.wps.cn/documents/app-integration-dev/docs-center/price/detail)

金山文档另有官方 CDN 分发的 `kdocs` v2.7.1 技能包，其 `SKILL.md` 明确为在线云文档 CLI，提供本地文件上传为云文档的流程；它与上面的 365 MCP 清单也不是同一能力目录。本次只下载并阅读说明文件，没有运行安装或上传。该包可作为“云端路线不满足本任务”的直接分发证据，不将社区流传的 SkillHub MCP 地址当成已核实的本机服务。[官方 v2.7.1 技能包](https://wpsai.wpscdn.cn/skillhub/pro/v2.7.1/kdocs.zip)（本次文件 SHA-256：`7ec3b30f6b9da9563b79a458ac301f90ff043f086cea8a35b1f99f2c541963eb`）。

### WPS 笔记本地 MCP

官方社区管理员教程给出的地址是 `http://127.0.0.1:18930/mcp`，传输为 Streamable HTTP，使用笔记客户端创建的 Bearer Token，要求客户端启动并登录。能力围绕笔记、块、图片、搜索和编辑；教程标为实验功能，可能调整或下线。它不证明文字/表格/演示三件套有同样的服务，也不能替代本任务的桌面桥。[笔记 MCP 管理员教程](https://bbs.wps.cn/topic/97117)

## 5. 当前可作出的选择与阻塞项

建议按 **本机 WPS 对象模型的 MCP 适配** 选型。双平台共用工具契约，平台适配独立验收；优先确认官方 JS 加载项作为双平台共同接口的具体 WPS 版本，Windows 需要 COM 时将其明确限定为 Windows 后端。无需因此另建 Agent runtime 或云文档前端。

尚不能用公开资料消除的交付阻塞项：

- 官方本机 Office 三件套 MCP 的可直接采用产品、支持期限与接口契约，本次未找到。
- 当前 Windows x64 / Mac arm64 各发行渠道的最低 WPS 版本、加载项注册规则、组件与方法差异。
- 本地外部自动化、加载项分发的准确账号/商业许可要求与费用。
- 各组件保存、恢复、多实例及用户并行编辑的真实行为；尤其是 ET 的 JavaScript 撤销限制。

当前仍缺双平台安装包、三组件真实文档读写、保存后重开，以及用户并行编辑和故障恢复的原生验收结果。第 6 节的加载阶段取证不消除这些交付阻塞项。

## 6. macOS 加载阶段取证与当前验收边界

以下本机事实由主代理在本次任务的 macOS WPS 12.1.28496 真实运行中观察，属于项目验收记录，不是官方产品能力保证。只记录阶段和现象，不公开私有连接地址、凭据或文档内容。

| 取证阶段 | 已确认事实 | 证据能支持的范围 |
| --- | --- | --- |
| WPS 加载项管理器 | 实际显示 `HuaqingDesktopWPS` 为在线模式且已启用 | WPS 已采纳该条注册；不能据此证明脚本执行、桥连接或 API 可用 |
| Native4 资源请求 | 真实 WPS 请求了 `ribbon.xml`、`manifest.xml`、`index.html`、`main.js` | 原生宿主曾进入资源获取阶段；HTTP 请求不等于脚本成功执行或 peer 已建立 |
| Native5 零 HTTP 排障 | 发现无标题原生模态框，提示加载项 `HuaqingDesktopWPS` 已被修改、询问是否继续加载；另开表格时出现对话框打开期间命令不可执行的提示 | 该次零请求已查明在等待 WPS 原生加载确认，不能归因于缺少许可证、隐藏证书步骤或脚本资源未提供 |
| 当前恢复状态 | 已取消旧条目的本次加载；自动审批审查拒绝了继续加载确认，未绕过该拒绝。等待用户明确同意后，再测试最新 bundle | 当前最新 bundle 尚未完成真实 WPS 连接及 API 操作验收 |

只观察主文档窗口的辅助功能树曾漏掉上述无标题模态框。后续原生验收必须枚举 WPS 的实际窗口与对话框，先核对是否存在待处理确认，再解释零 HTTP、无 peer 或命令忙碌。不能用修改安全设置、覆盖授权记录或自动接受原生确认来掩盖这一状态。官方人员也曾说明加载项变更确认与“工具 → WPS 加载项”管理入口，但该社区回复不是本次 Mac 模态框的替代证据。[官方变更确认说明](https://bbs.wps.cn/topic/45699)

官方人员明确说明，Mac 的 `wpsjs debug` 使用沙盒中的 `publish.xml`，通过本机服务加载资源与通信；本次没有查到 Mac JSA 必须额外安装证书、开启全局安全开关或购买某个企业 SKU 的官方要求。当前原生确认现象也不足以推导这些要求。[Mac 在线与离线加载说明](https://bbs.wps.cn/topic/54791)、[加载项安装包要求](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/addin-api/wps-addin-availability)

### 官方脚手架与本项目入口的证据范围

官方开发文档推荐 `wpsjs`。本次只读下载并校验 npm 发布包 `wpsjs@2.2.3` 的 SHA-512 integrity，未安装或执行该包；其中普通 Writer 模板 `packages/@wps-jsapi/wps/manifest.xml` 使用以下结构。它说明 `JsPlugin` 也用于普通加载项模板，不能把它限定为自定义函数清单。[官方工具包说明](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/wps-addin-development-instructions)、[固定版本 npm 包](https://registry.npmjs.org/wpsjs/-/wpsjs-2.2.3.tgz)

```xml
<JsPlugin>
  <ApiVersion>1.0.0</ApiVersion>
  <Name>HelloWps</Name>
  <Description>addon Description</Description>
</JsPlugin>
```

项目已采用该 `JsPlugin` 结构，并由 Main 为各组件提供对应名称。项目桥使用自身的有限操作 JSON 协议，不将第三方任意脚本执行能力作为本机文档接口；这些属于本项目实现，不能标为官方 MCP 协议。[加载项清单](../packages/hqharness-wps/addin/manifest.xml)、[Main 资源服务](../src/main/wps/service.ts)、[有限操作适配器](../packages/hqharness-wps/addin/adapter.js)

为兼容 WPS 可能生成自己的 HTML 入口，服务将适配器与主脚本组合成单一 `main.js`，在拼接边界显式插入分号，提供不依赖页面 URL 的组件连接上下文，并提前定义 ribbon 回调。对应行为测试取得实际 HTTP 响应后在 Node VM 中执行；环境使用 `about:blank`、空 `document.currentScript`，禁止动态代码生成，检查三个组件各自的模拟 WebSocket 与握手。[入口实现](../src/main/wps/service.ts)、[HTTP 与 VM 行为测试](../test/wps-mcp-service.test.mjs)

该 VM 测试执行的是实际服务脚本，WPS 对象和 WebSocket 则为测试替身；它可发现拼接语法、入口上下文和握手回归，不能替代真实 WPS 的脚本执行、对象模型调用或保存验证。当前没有可宣称 Writer、ET、WPP 已通过“读取 → 修改 → 回读 → 保存 → 重开”的本项目原生结果。
