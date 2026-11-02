# 本地 WPS MCP 开源方案调研

核对日期：2026-11-02。范围：让 Huaqing Desktop 的 Harness 通过 MCP 操作本机实际运行的 WPS Writer / 表格 / 演示，优先解决 Windows 的 GUI 自动化困难，同时审查 macOS 的可行性。本文只做源码和文档调研，没有安装、执行第三方服务器，没有启动或改动用户 WPS 文档。

## 结论

**有真实操作本机 WPS 的开源 MCP；但本次没有找到可以不加改造就按生产标准内置、并保证所有 Windows/macOS WPS 版本安装即用的项目。** 最有价值的两个输入是：

- **`humoumou1215/wps-assistant`：优先作为跨平台内置桥接层的 MIT 源码基础。** 它通过 WPS JS Add-in 连接真实已打开文档，按文档身份路由，已有 macOS WPS 12.1.28496 的实测记录。应抽取桥接/注册/对象访问部分，去掉其内嵌 Agent、模型配置和第二套助手界面，并补齐鉴权、窄工具及未知执行结果处理。它要求 WPS 能加载 JS Add-in；首次注册和宿主重启无法由“随包已有 Node”消除。[源码](https://github.com/humoumou1215/wps-assistant/blob/dda67065086a46450d0aa72eab77954b61ba42d6/addon/main.js)、[MIT](https://github.com/humoumou1215/wps-assistant/blob/dda67065086a46450d0aa72eab77954b61ba42d6/LICENSE)、[原生验证](https://github.com/humoumou1215/wps-assistant/blob/dda67065086a46450d0aa72eab77954b61ba42d6/skills/wps-api/references/macos-validation.md)。
- **`ELDment/wps-mcp` 1.2.0：功能和执行边界更完整的现成 MCP 候选。** Windows 是 COM，macOS 使用 WPS 安装包内的本地自动化驱动；有排队取消、单线程执行、保存备份和超时结果未知处理。它是 **AGPL-3.0-only**，不能当 MIT 依赖直接复制进本仓库；须先确定分发及修改方式能履行对应许可证义务，或者取得适合产品的另行许可。Mac 驱动存在性和协议兼容还需逐版本验收，项目实现不等于 WPS 官方稳定契约。[项目声明](https://github.com/ELDment/wps-mcp/blob/e8202c0d4d06b3503e054339dc3ed44756baf25b/pyproject.toml)、[许可证](https://github.com/ELDment/wps-mcp/blob/e8202c0d4d06b3503e054339dc3ed44756baf25b/LICENSE)、[Windows](https://github.com/ELDment/wps-mcp/blob/e8202c0d4d06b3503e054339dc3ed44756baf25b/src/wps_mcp/native/windows.py)、[macOS](https://github.com/ELDment/wps-mcp/blob/e8202c0d4d06b3503e054339dc3ed44756baf25b/src/wps_mcp/native/macos.py)。

**针对当前 Windows 故障，最小发布能力应先是“连接明确的已打开 WPS 文档，读取、修改、回读、另存副本”，而非给模型开放整套脚本和应用退出。** 如果当前 Windows WPS 可加载 JS Add-in，可以沿用同一桥接实现；如果只有 COM 可用，则提供独立 Windows COM 适配器，不能把 COM 宣称为 macOS 方案。以上是选型建议，不表示本仓库已经实现或验证了 WPS MCP。

## 1. 三种能力必须区分

| 能力 | 是否接触实际 WPS | 可以看到未保存内容 | 能否保持真实 WPS 计算/对象模型 | 本仓库关系 |
| --- | --- | --- | --- | --- |
| python-docx / openpyxl / python-pptx 文件编辑 | 否，只读写文件 | 否 | 不等于 WPS 的计算、排版和对象模型 | 已有 Office authoring 的主要能力，不应再包一层便宣称能控制 WPS |
| Windows COM MCP | 是，通过本机 WPS 注册的自动化对象 | 连接正确的现有实例后可以 | 受当前 WPS COM 实现影响 | 可用现有嵌入式 Python，但须补 Windows wheel/DLL 和原生验收 |
| WPS JS Add-in 或 Mac 内置 driver MCP | 是，在真实 WPS 中执行对象操作 | 可以，前提是绑定正确宿主/文档 | 受当前宿主 API 和版本影响 | Add-in 可复用现有 Node；Mac driver 是另一条平台实现，不能混称为 COM |

本仓库现有资源管线只证明随包 Python 和 Office 文件库可用；并没有因此获得 WPS COM / Add-in 能力。[现有 Office 文档](office-runtime.md)。`miku1130` 的文件模式实际导入上述三个文件库，默认就是 `file`；其 COM 分支另有明确实现，因此不能只按项目名判断能力。[模式与文件 handlers](https://github.com/miku1130/wps-editor-mcp/blob/2b80fcdc0f0e485576f4381bbd91d2fb7db89aee/server.py#L18)。

## 2. 核对过的项目快照

下表的日期为仓库最新提交时间，不是本地实机验收时间。后文均引用固定提交，避免同名分支变化后失去依据。

| 项目 / 快照 | 实际机制 | live 已打开文档 | 平台证据 | 内置判断 |
| --- | --- | --- | --- | --- |
| [wps-assistant](https://github.com/humoumou1215/wps-assistant/tree/dda67065086a46450d0aa72eab77954b61ba42d6)，0.1.22，2026-10-18 | TS MCP + WebSocket + WPS JSA Add-in | 是，`documentId → documentKey → wpsDocument` | 有 Mac ET/WPP 实测与 Writer 小范围 smoke；Windows 有注册/分发实现，仍须当前 Windows WPS 验收 | **优先抽取桥接层**；MIT、npm 锁，整应用含第二个 Agent |
| [ELDment/wps-mcp](https://github.com/ELDment/wps-mcp/tree/e8202c0d4d06b3503e054339dc3ed44756baf25b)，1.2.0，2026-10-30 | Windows COM；Mac Unix socket 内置 driver；Linux RPC | Win/Mac 是；Linux 为服务自管实例 | 实际有 Win/Mac backend 和 native tests；本次未在三平台运行 | **有条件的完整服务器候选**；AGPL-3.0-only；依赖锁较完整 |
| [hinora/office-mcp](https://github.com/hinora/office-mcp/tree/b5a5c0a949268f3f20c4b4fec2e84813fa588855)，0.1.0，2026-06-20 | Python MCP + pywin32 COM | 是，优先 GetActiveObject | Windows；无 Mac backend | **不直接内置**：快照无 LICENSE 和依赖锁，目标和退出策略需改造 |
| [miku1130/wps-editor-mcp](https://github.com/miku1130/wps-editor-mcp/tree/2b80fcdc0f0e485576f4381bbd91d2fb7db89aee)，2026-05-02 | 默认文件库；可选 COM | COM 不是安全的持续接管模式 | 文件模式跨平台；COM 是 Windows | **不选作 live WPS 基础**：重复现有文件能力，每调用可 Quit 应用 |
| [chayuan](https://github.com/zhgyuhuii/chayuan/tree/645491180f146c91c62a4438807ad58f3dbe35c4)，2026-10-28 | Node HTTP MCP sidecar + WPS Add-in 长轮询 | 是，由加载项接入宿主 | 有 Mac Add-in 部署与原生 bridge 实现；不是只有 Mac Node 进程 | **参考实现**：Apache-2.0，但整个文档助手范围很大，MCP 入口默认无 Token |

### 2.1 wps-assistant：最适合复用的 JSA 桥

**真实调用链。** `server.ts` 创建标准 MCP SDK 的 stdio / Streamable HTTP 服务器，同时启 HTTP 静态资源与 `/ws`。Add-in 上报当前宿主文档；工具持有 `documentId`，发 RPC 携带 `documentKey`。`addon/main.js` 每次重新解析绑定文档，再把 `Application`、`wps`、`variable`、`wpsDocument` 传入 `new Function`。它确实进入 WPS 宿主，能够访问已打开文档；不是 python-docx 封装。[server.ts](https://github.com/humoumou1215/wps-assistant/blob/dda67065086a46450d0aa72eab77954b61ba42d6/src/server.ts)、[tools.ts](https://github.com/humoumou1215/wps-assistant/blob/dda67065086a46450d0aa72eab77954b61ba42d6/src/tools.ts#L359)、[执行端](https://github.com/humoumou1215/wps-assistant/blob/dda67065086a46450d0aa72eab77954b61ba42d6/addon/main.js#L379)。

**Mac 支持不是只有宣传。** 上游记录 macOS / WPS Office 12.1.28496：ET 可读 `Value2` / `Formula`，`Range.Value` 赋值失败；WPP 文字、形状、表格读写通过；Writer 后续烟测覆盖一次性 DOCX 的读取、InsertAfter、回读、保存和关闭，没有跑完整 Writer 矩阵。这证明存在可工作的 Mac 路径，也同时证明 Office API 同名属性不能假定跨平台完全一致。记录里的 “Microsoft Excel/PowerPoint” 是 WPS 返回的对象名，不能只凭 `Application.Name` 判断实际进程归属。[详细原生记录](https://github.com/humoumou1215/wps-assistant/blob/dda67065086a46450d0aa72eab77954b61ba42d6/skills/wps-api/references/macos-validation.md)。

**部署有宿主接缝。** `addin-registration.ts` 为 ET/WPP/Writer 修改 `publish.xml`；macOS 另修改 Writer 的 `authaddin.json`。代码先校验原文件、留首次备份、临时文件提交，失败时保留恢复副本，并按自己的名称卸载条目，不清空其他加载项。这比直接覆盖整个配置更适合产品化，但仍应合入本产品的安装/升级/卸载生命周期，不直接运行 upstream install 脚本。其规范明确 Windows Writer 授权还需实机确认，静态资源 200 和模拟测试不等于宿主激活。[注册实现](https://github.com/humoumou1215/wps-assistant/blob/dda67065086a46450d0aa72eab77954b61ba42d6/src/addin-registration.ts)、[部署与验收边界](https://github.com/humoumou1215/wps-assistant/blob/dda67065086a46450d0aa72eab77954b61ba42d6/docs/spec.md#252-开发部署)。

**不能整体搬入 Huaqing。** 生产依赖含 `@earendil-works/pi-coding-agent@0.99.2`，服务启动会初始化它的资源，并且自带对话、变量规则、凭据和会话。它的模型脚本工具是面向“查询 → Variable → Transform → Render”的另一套助手产品；本仓库要求复用 Harness runtime。复用目标应限定在 Add-in、注册、宿主路由和必要纯逻辑，保留 MIT 声明；重新维护自己实际使用的最小依赖闭包。[依赖和入口](https://github.com/humoumou1215/wps-assistant/blob/dda67065086a46450d0aa72eab77954b61ba42d6/package.json)、[初始化](https://github.com/humoumou1215/wps-assistant/blob/dda67065086a46450d0aa72eab77954b61ba42d6/src/server.ts#L183)、[MIT 全文](https://github.com/humoumou1215/wps-assistant/blob/dda67065086a46450d0aa72eab77954b61ba42d6/LICENSE)。

**必须补的执行边界。** 它有变量修改队列和开始前 AbortSignal 检查；已经进入 WPS 的操作不会因取消自动撤销。RPC 45 秒超时只删除 pending 并返回错误，不能终止 Add-in 内已经开始的脚本。`new Function` 并非沙箱，静态只读检查也是 best effort。原服务器只绑定 loopback 并校验 Host/部分 Origin，没有每安装实例的 MCP/RPC 身份凭据；允许无 Origin 的 WebSocket 客户端。上述事实使它适合作为经审查的代码输入，不能把未改造 HTTP 服务直接作为产品默认常驻特权入口。[队列/RPC](https://github.com/humoumou1215/wps-assistant/blob/dda67065086a46450d0aa72eab77954b61ba42d6/src/tools.ts#L127)、[服务检查](https://github.com/humoumou1215/wps-assistant/blob/dda67065086a46450d0aa72eab77954b61ba42d6/src/server.ts#L61)、[上游安全边界](https://github.com/humoumou1215/wps-assistant/blob/dda67065086a46450d0aa72eab77954b61ba42d6/SECURITY.md)。

### 2.2 ELDment/wps-mcp：完整 MCP 候选，许可证及驱动契约要先落地

Windows `ComSession` 使用独立 STA worker，并 `CoInitializeEx(COINIT_APARTMENTTHREADED)`；先 `GetActiveObject`，允许启动时才回退 `Dispatch`。释放会话只释放 COM proxy/worker，不等于退出用户 WPS。它不是只读文件的伪 WPS MCP。[Windows backend](https://github.com/ELDment/wps-mcp/blob/e8202c0d4d06b3503e054339dc3ed44756baf25b/src/wps_mcp/native/windows.py)。

Mac 后端寻找 `wpsdriverlocal_(wps|et|wpp)_<数字>` Unix socket，检查真实 listener PID，经 HTTP `/session` 与 `/session/<id>/execute/script/evaluate` 在 WPS 内执行脚本，用 `CreateObject` 取得对应组件。没有 socket 时可从安装包模板复制一个临时引导文档来启动 WPS。发现多个进程且不能唯一绑定时要求 `WPS_DRIVER_SOCKET`，没有悄悄任选一个进程。探测还检查安装包是否包含 `wpsdriverlocal`、`wpsdriverbase` 等 framework；因此旧版或不同发行通道没有驱动时不能使用。[Mac backend](https://github.com/ELDment/wps-mcp/blob/e8202c0d4d06b3503e054339dc3ed44756baf25b/src/wps_mcp/native/macos.py)、[环境探测](https://github.com/ELDment/wps-mcp/blob/e8202c0d4d06b3503e054339dc3ed44756baf25b/src/wps_mcp/native/discovery.py)。

执行和文件保护较扎实：worker 能取消未开始的调用；native 调用超时会标记未完成工作并阻止追加工作；Mac 丢响应后进入 UnknownOutcome 状态，拒绝盲目重发。保存检查目标被其他已打开文档占用、覆盖参数、输出非空及 OOXML 主部件；已有目标保留恢复副本，结果未知时不擅自恢复覆盖。这些措施不构成 WPS 内存事务，也不能阻止另一个独立进程绕过本服务写同一文件。[worker](https://github.com/ELDment/wps-mcp/blob/e8202c0d4d06b3503e054339dc3ed44756baf25b/src/wps_mcp/native/worker.py)、[文档生命周期](https://github.com/ELDment/wps-mcp/blob/e8202c0d4d06b3503e054339dc3ed44756baf25b/src/wps_mcp/documents/service.py#L189)、[保存保护](https://github.com/ELDment/wps-mcp/blob/e8202c0d4d06b3503e054339dc3ed44756baf25b/src/wps_mcp/common/files.py)。

其撤销工具明确是 WPP 的 `ExecuteMso("Undo"/"Redo")` 与 `StartNewUndoEntry`，不能推广成三组件任意操作的可靠自动回滚。上游也要求同一 WPS 实例避免多个 MCP 服务同时连接。跨会话/跨产品同时接管和真实工作簿锁仍须宿主侧治理。[history.py](https://github.com/ELDment/wps-mcp/blob/e8202c0d4d06b3503e054339dc3ed44756baf25b/src/wps_mcp/presentation/history.py)、[README 多实例约束](https://github.com/ELDment/wps-mcp/blob/e8202c0d4d06b3503e054339dc3ed44756baf25b/README.md)。

供应链方面，Python ≥3.11，依赖含 MCP SDK 2.x、Pydantic、AnyIO、Windows pywin32、PDFium 与 Pillow；`uv.lock` 有具体版本、下载 URL 和哈希。需要核对本产品嵌入式 Python 的 ABI、目标 wheel 和动态库闭包，不能只复用已有 Python 路径便称依赖齐全。README 的 `uvx ...@latest` 适合个人试用，内置应固定提交/版本和 artifacts，构建时验哈希，运行时离线启动，不能让每台用户机器临时拉最新版。[pyproject](https://github.com/ELDment/wps-mcp/blob/e8202c0d4d06b3503e054339dc3ed44756baf25b/pyproject.toml)、[锁](https://github.com/ELDment/wps-mcp/blob/e8202c0d4d06b3503e054339dc3ed44756baf25b/uv.lock)。

### 2.3 hinora/office-mcp：确能接管现有 WPS，但不适合原样内置

Excel、Word、Slide 客户端均先遍历 `GetActiveObject` 的 ProgID，再回退 `Dispatch`。Excel 服务有单线程 STA executor，因此“只是调文件库”的判定不适用于它。但普通工具大量以 `ActiveWorkbook` / `ActiveSheet` / `ActiveDocument` 操作为目标；用户切标签、多个会话同时操作时要特别防止改错文档。[Excel client](https://github.com/hinora/office-mcp/blob/b5a5c0a949268f3f20c4b4fec2e84813fa588855/src/wps_excel_mcp/wps_client.py#L39)、[STA server](https://github.com/hinora/office-mcp/blob/b5a5c0a949268f3f20c4b4fec2e84813fa588855/src/wps_excel_mcp/server.py#L45)、[Word client](https://github.com/hinora/office-mcp/blob/b5a5c0a949268f3f20c4b4fec2e84813fa588855/src/wps_word_mcp/word_client.py)。

保存直接 `Save`/`SaveAs` 当前对象；Word 的应用退出是 `Quit(SaveChanges=0)`，Slide 退出是 `Quit()`。不能向 Agent 默认暴露这些退出方法，更不能在宿主卸载时沿用。快照根树及 pyproject 没有 LICENSE 或许可声明，也没有依赖锁，依赖是 `mcp>=1.0.0`、`pywin32>=306`、`websockets>=12.0`。公开源码不等于已经授予产品再分发许可，应取得明确授权之后再讨论 vendoring。它同时带 Outlook/WhatsApp/Web 工具，不应把六个 exe 全部带入来满足 WPS。[Word 退出](https://github.com/hinora/office-mcp/blob/b5a5c0a949268f3f20c4b4fec2e84813fa588855/src/wps_word_mcp/word_client.py#L156)、[Slide](https://github.com/hinora/office-mcp/blob/b5a5c0a949268f3f20c4b4fec2e84813fa588855/src/wps_slide_mcp/slide_client.py#L182)、[根目录](https://github.com/hinora/office-mcp/tree/b5a5c0a949268f3f20c4b4fec2e84813fa588855)、[依赖声明](https://github.com/hinora/office-mcp/blob/b5a5c0a949268f3f20c4b4fec2e84813fa588855/pyproject.toml)。

### 2.4 miku1130/wps-editor-mcp：MIT，但不适合接管用户正在工作的 WPS

文件模式默认，DOCX 写入可能新建 `Document()` 后覆盖指定路径；XLSX 使用 openpyxl 直接保存。COM `_get_wps_app` 只用 `Dispatch`，还会尝试 `Word.Application` / `Excel.Application` / `PowerPoint.Application`。读调用也会隐藏 app、打开路径、关闭对象，并在 finally 调 `app.Quit()`；写表格会 `Workbooks.Add()` 再 `SaveAs` 指定路径。不能证明 Dispatch 拿到的是本服务独占实例，因此不能安全照搬其 Quit 策略，更不能把 MS Office 回退结果宣称为 WPS 成功。[真实 handlers](https://github.com/miku1130/wps-editor-mcp/blob/2b80fcdc0f0e485576f4381bbd91d2fb7db89aee/server.py#L1222)。

许可证为 MIT；requirements 只有最低版本，没有锁和 wheel 哈希，且把 Windows pywin32/comtypes 与文件库同时列出、无平台 marker。macOS 的“可用”来自不依赖 WPS 的文件模式；COM 分支不能作为 Mac live WPS 实现。它没有提供足以抵消上述风险的会话所有权、未知结果恢复和跨服务文档锁。[MIT](https://github.com/miku1130/wps-editor-mcp/blob/2b80fcdc0f0e485576f4381bbd91d2fb7db89aee/LICENSE)、[requirements](https://github.com/miku1130/wps-editor-mcp/blob/2b80fcdc0f0e485576f4381bbd91d2fb7db89aee/requirements.txt)。

### 2.5 chayuan：真实 JSA + sidecar，可参考但范围过大

sidecar 的 `/agent/register`、`poll`、`result` 接入 WPS 内的 Add-in；表格 dispatcher 实际调用 WPS 对象。Mac 有三个宿主 jsaddons 部署脚本及 `open` 启动支持，故不只是“Mac 上可以跑 HTTP 服务器”。但已有 Mac 原生保存 fallback 用 AppleScript / System Events 点击中文“文件 → 保存”，又引入 GUI、语言和系统权限依赖；不能把这条 fallback 直接视作解决 GUI 困难的统一 MCP 方案。[sidecar](https://github.com/zhgyuhuii/chayuan/blob/645491180f146c91c62a4438807ad58f3dbe35c4/mcp-sidecar/server.mjs)、[WPS 表格执行](https://github.com/zhgyuhuii/chayuan/blob/645491180f146c91c62a4438807ad58f3dbe35c4/src/services/mcpBridge/spreadsheetDispatch.js)、[Mac 注册部署](https://github.com/zhgyuhuii/chayuan/blob/645491180f146c91c62a4438807ad58f3dbe35c4/scripts/deploy-mac-jsaddons.sh)、[原生 bridge](https://github.com/zhgyuhuii/chayuan/blob/645491180f146c91c62a4438807ad58f3dbe35c4/mcp-sidecar/lib/platformBridge.mjs#L278)。

项目 Apache-2.0，sidecar Node ≥18、未声明额外 npm 依赖；主要工具执行依赖整个 WPS Add-in 的分发与激活。当前 `/mcp` 无 Token，`checkAuth` 恒 true，CORS 为 `*`；部分敏感路由另验 Token，不能因此宣称 MCP 文档修改已有完整鉴权。独立 sidecar 能启动、`/healthz` 成功都不能替代 Add-in 在线和目标文档回读。[许可证](https://github.com/zhgyuhuii/chayuan/blob/645491180f146c91c62a4438807ad58f3dbe35c4/LICENSE)、[依赖](https://github.com/zhgyuhuii/chayuan/blob/645491180f146c91c62a4438807ad58f3dbe35c4/mcp-sidecar/package.json)、[MCP 安装说明](https://github.com/zhgyuhuii/chayuan/blob/645491180f146c91c62a4438807ad58f3dbe35c4/mcp-sidecar/README.md)、[入口检查](https://github.com/zhgyuhuii/chayuan/blob/645491180f146c91c62a4438807ad58f3dbe35c4/mcp-sidecar/server.mjs#L293)。

## 3. 免费版、专业版与“安装即用”的证据边界

上述项目源码能证明它们调用了何种 API，**不能证明所有 WPS 免费版都带相同 COM/JSA/driver 能力，也不能证明必须购买专业版**。本次没有得到可覆盖中国版/国际版、不同发行通道和所有组件的官方 SKU 对照；不能把“WPS installed”翻译为免费版无条件可用。最低准入应以真实探测和认证的 WPS 构建矩阵为准，并单独核对产品分发所需的 WPS 许可安排。

| 路线 | 安装器可自行携带 | 仍依赖用户/宿主 | 开箱状态应如何报告 |
| --- | --- | --- | --- |
| Windows COM | MCP 代码、固定 Python、pywin32 wheel 与必需 DLL | 已安装可用 WPS、COM 注册、同一交互桌面，目标组件可调用 | “COM 已探测 / 实例已绑定 / 文档已回读”，分阶段报告 |
| JSA Add-in | JS bundle、MCP bridge、注册/卸载代码、固定 Node 依赖 | WPS 有 JSA 加载能力、策略允许、注册生效，宿主重启/文档重开 | “已注册”与“Add-in 已在线”分开；后者才可执行 |
| macOS 内置 driver | Python/MCP 和对象适配代码 | WPS 包带所需 frameworks、socket 服务、文件沙箱访问许可 | “驱动存在”与“协议可握手、对象可读写”分开 |

Mac 的 COM 不可用；JSA 与内置 driver 是不同实现。Windows x64 的 wheel 存在也不证明当前 WPS 构建的 COM 行为正确；32/64 位组合、国际版、中国版和 Writer/ET/WPP 要分别验收。WPS 未安装、组件缺失、企业禁加载项、受保护/只读文档、文档被其他进程锁住、驱动不存在时，应返回具体能力缺失，而不是静默改用文件库或 MS Office。

## 4. 建议的生产集成边界

以下为本仓库的设计建议，不是上述项目已提供的保证。它与现有 Electron main/Harness/plugin 边界一致，实施时需进一步形成类型契约和真实平台验收。[架构](architecture.md)、[Patch / Plugin 规范](patch-plugin-contract.md)、[源码与产物规范](source-build-contract.md)。

1. **一个可选 WPS 宿主插件，一个由 Desktop main 管理的本机 broker。** Harness 会话调用 broker 的 MCP 接口；JSA Add-in 或 Windows COM worker 是具体 backend。Safe Mode 不加载可选 WPS 能力。不要新增 Agent runtime，不改变 renderer 权限，不把第二套助手托盘和常驻服务一起带入。
2. **优先复用 MIT JSA 桥，但对模型只暴露有限文档操作。** 首批为环境探测、列出已打开文档、绑定明确实例与文档、读表格/正文/幻灯片、有限写入、回读、另存副本。取消/退出 WPS、任意 Python/JS、VBA 宏、打印和自动覆盖原件不作为默认工具。未来确需高级脚本时单独界定权限与目标，不能把静态代码检查描述成沙箱。
3. **同一 WPS 实例所有写入共用串行执行和所有权。** 文档句柄含 broker instance、宿主 PID/连接代、组件和文档身份；重连后失效或重新绑定。每次执行重新解析对象并核对，不能以 UI 当前 Active* 为业务目标。跨会话写入按句柄排队；不靠每会话启动一个 MCP 进程来隔离，因为它们最终可能接到同一 WPS 实例。
4. **取消与回滚有真实含义。** 未开始工作可取消；已经发往 WPS 的 native 操作不得通过“停止生成”宣称撤销。超时/断链进入结果未知，冻结该实例的新写入，先读回实际状态并完成恢复；不能自动重试非幂等操作。Undo 仅在该构建已验证对应对象和分组行为时使用，不可无条件全局 Ctrl+Z，避免撤销用户自己的新操作。
5. **文件写入保留恢复入口。** 默认另存新副本；操作开始前记录原路径、只读/dirty 状态和可恢复副本，已有未保存内容不能只靠磁盘备份恢复。提交原件时明确覆盖范围，核对目标未被另一文档占用、磁盘身份没有被并发替换，回读关键对象并验证文件确实更新。Windows sharing violation/只读/另一个 WPS 进程持锁时返回错误；不强关用户应用、不删除锁文件。备份恢复不能在结果未知时与仍运行的写操作竞争。
6. **本机桥接必须有身份与来源校验。** 模型侧优先 stdio 或现有受控 IPC；Add-in 所需 loopback HTTP/WS 限制 Host、Origin、消息体大小与内容类型，并有每安装/每启动实例的凭据及请求身份。将加载项注册的静态资源与可写 RPC 权限分开。不能仅用“127.0.0.1”替代鉴权，更不能把端口映射到手机或公网。
7. **资源随安装版本走，运行时不联网安装。** JSA 的 bundle/注册名/协议版本配对；Python 路线固定提交、wheel、SHA-256 和目标平台闭包，记录 LICENSE/NOTICE/SBOM。升级重新定位当前安装资源、重握手并阻止旧 Add-in 发写请求；回滚保留原有用户数据和加载项。注册只修改本产品自己的条目，异常时保留原始配置和可定位的恢复副本。

**最小技术选择：** 当前 Windows 若 JSA 可用，优先做 MIT 桥的受控集成，Windows 和 Mac 共用文档层，按已验证 API 分平台适配；若当前 Windows 无法用 JSA，则首版 Windows COM 用同一 broker 契约实现，Mac 继续使用已验证 JSA。若希望采用 ELDment 的完整服务器以减少对象层开发，先解决 AGPL 分发方案或另行许可，并逐项验证 Mac 内置 driver；许可证、真实驱动支持和用户数据保护都是上线前条件，不能用“之后再处理”代替。

## 5. 上线验收与本次未覆盖内容

生产准入至少需要以下可丢弃 fixture 的真实安装包验收，不能只有 Python import、MCP initialize 或 HTML 200：

- Windows x64：记录 OS、WPS 完整版本/发行通道/位数和许可类型；Writer/ET/WPP 分别连接已打开和未保存文档，read → mutate → read-back → save-copy → reopen；确认目标和其他打开文档没有串写。
- macOS arm64/x64：对认证的 WPS 构建重跑上述流程，专测 `Value2` / Formula / 图表、Writer 注册和文件沙箱访问；采用 driver 时另测缺 framework、没有 socket、多个 PID、stale socket 和握手不兼容。
- 故障与并发：用户切活动页、同时两个 Harness 会话、第二个 MCP 服务、只读/锁定文件、未保存 dirty 内容、modal dialog、WPS 崩溃、Add-in 重连、broker 退出、操作超时、取消排队和已开始操作；核对没有假成功或盲目重放。
- 安装/升级/卸载：无 Node/Python 系统安装、首次离线启动、路径含中文/空格、重启后注册、旧 Add-in 缓存、缺插件/损坏资源、保留其他 Add-in、卸载移除自己的注册及 Safe Mode 不加载。

本次只完成上述仓库在固定提交的 README、许可证、依赖/锁、关键入口和 handlers 的只读审查。没有跑第三方测试、构建或 MCP，没有验证本机 WPS 版本，也没有 Windows 原机结果；免费版/专业版覆盖、每个 Office 对象 API、完整供应链审计、真实多进程工作簿锁和正式安装包验收均未完成。调研结论用于选型和界定工程范围，不能据此宣称功能已发布。
