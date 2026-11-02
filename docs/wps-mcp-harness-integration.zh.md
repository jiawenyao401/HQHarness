# 内置本地 WPS MCP：Harness 接入边界与生产验收

本文记录 2026-11-02 对当前工作区的静态核查，面向后续选型和实现。当前产品为 Huaqing Desktop 0.1.11；**尚未选择、安装或运行任何第三方 WPS MCP，也未实现 WPS 能力**。已读取根、`packages/`、`build/`、`src/main/` 的 `AGENTS.md` 及 [Patch 与 Plugin 规范](patch-plugin-contract.md)。现有 WIP 未被修改。

用户已确认范围：Harness 安装在哪台机器，就控制该机的 WPS 和本地文档；不接入 WPS 云文档、云账号或远程文档服务。本文的 HTTP 选项仅指本机 loopback 传输，不扩大这一产品范围。

结论：可以在现有 Electron 宿主与 Harness 工具系统中接入，无需新增 Agent runtime。生产方案应由 Main 管理本地 WPS 服务、授权和停止，由安装包内置的薄 Harness 插件注册结构化文档工具。WPS 结构化操作应成为默认 GUI 路由中的明确例外；通用文件操作仍遵循现有路由。直接在 Desktop YAML 中添加一个通用 `mcp-client` stdio 行，只能完成连接和工具发现，不能满足会话文件范围、应用所有权、写入恢复与停止验收。

## 1. 已核实的版本与接口

以下路径与行号均针对本次工作区快照；`node_modules` 是已安装发布包的实现证据，升级或重新安装后应按锁文件重新核对。

| 事项 | 可核实结论 | 证据 |
| --- | --- | --- |
| 产品版本 | `hqharness@0.1.11`，`productName: Huaqing Desktop` | `package.json:2`、`:356` |
| Harness MCP bridge | `@deepseek-ai/dsh-mcp-client@0.2.0-rc.2` | `package-lock.json:3713` |
| 实际 MCP SDK | bridge 自身 manifest 声明 `2.0.0`，但根 override 和锁文件将实际安装版本固定为 **`@modelcontextprotocol/client@2.2.0`**；从 bridge manifest 的 `createRequire(...).resolve()` 也指向根 SDK | `package.json:347`、`package-lock.json:8349`、`node_modules/@deepseek-ai/dsh-mcp-client/package.json` |
| 公共导出 | 根入口导出 `Config`、`apply`、`createMcpToolDefinition`、`inject`、`name`；声明中存在的 `publicToolName`、`syncTools`、`startConnection` 不等于根入口公开导出 | `node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js:835`、包 `exports` |
| 传输 | 支持 `stdio` 和 `streamable-http`；不存在经验证的 `sse` 配置别名 | 同上 `:38`、`:780` |
| 工具身份 | 本地配置的 `serverName` 与上游 `rawName` 构成身份；模型名称通常为 `mcp__<serverName>__<rawName>`，不合法字符或超过 64 字符会规范化并附 hash | 同上 `:85`、`:96` |
| 工具来源 | `tools/list` 返回实际 schema，调用时使用原始 `tool.name`；不通过模型名称反推 wire name | 同上 `:127` |
| 注册 API | `ctx.tools.register(definition)`、`get(name, agent)`、`guard(...)` 公开；scope-local 工具可遮蔽全局同名工具 | `node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts:630`、`:645`、`:681` |
| 拦截点 | `tools/pre-execute` 可 ask/deny/cancel；最终 guard 是单调拒绝，其他插件无法 force-allow 已被拒绝的调用 | 同上 `:36`、`:515` |
| 调用上下文 | 包含 `agent`、`signal`、registry token、parent token；Agent 的会话身份可从 `exec.agent.session.header.id` 取得；Agent 缺失不能默认为任意本机访问 | 同上 `:216`；`packages/hqharness-automation/index.js:94` |

`stdio` 的已发布配置为 `transport`、`serverName`、`command`、`args`、`env`、`cwd`、`toolCallTimeoutMs`、`failOnStartupError`、`maxInstructionBytes`、`reconnect`。HTTP 用 `url`、`headers` 替代进程字段。默认 tool timeout 为 60 秒，`failOnStartupError` 为 false，instructions 上限为 32768 字节；重连默认开启，500 ms 起步、30 秒上限、10 次预算。见 bridge `lib/index.js:434`、`:780`。这里没有已验证的 `sandbox`、`allowedPaths`、`roots`、`startupTimeoutMs`、`approveWrites` 等配置项，不能在方案中把这些字段当作现成能力。

`createMcpToolDefinition(ctx, options)` 是可复用的结果适配接缝：传入实际名称、描述、input/output schema 和 `call(args, execution)`；调用方仍负责注册、提供方生命周期和 deadline。MCP 规范值为 `{ content, structuredContent? }`，图片按现有附件机制持久化；`isError` 会失败，要求 task execution 扩展的工具会在执行时被拒绝。见 bridge `lib/types/tools.d.ts`、`lib/index.js:179`、`:227`。这不代表它理解文档保存状态，MCP 调用成功必须再验证目标文档。

## 2. 现有加载与安装归属

WPS 接入主要影响 **Profile 组合、后端加载与工具执行**。如果增加设置或状态 UI，还影响客户端发现和激活；没有理由改变 bootstrap 执行顺序。

1. Main 的 `bootstrap()` 使用 `<userData>/harness` 作为 DSH_HOME，中立 `launch-root` 作为 Harness cwd，给 `HarnessRuntime` 注入当前安装的 Desktop patch、Safe Mode patch 和额外环境。macOS 通过 utility process 启动，Windows 通过 spawn 启动。见 `src/main/index.ts:3245`、`:3263`、`:3277`。
2. 普通 Profile 启动前，`prepareHostPluginSourcesPatch()` 仅改写 Desktop patch 的 insert name：从当前 `dshEntryPath` 的安装 anchor 解析成 file URL；不允许 Profile 内同名 market 包替换宿主插件，不重写配置值或 Profile bundle 的解析基准。生成的 `desktop-host-sources.patch.yml` 是派生产物。见 `src/main/state/host-plugin-sources.ts:17`、`:74`、`:88`。
3. `build/dsh-desktop.patch.yml` 当前插入 `hqharness-automation`、`dsh-desktop-office` 等本地生产包。对应根 `package.json` 的 `file:packages/...`、锁文件，以及 `patches/@deepseek-ai+dsh+0.2.0-rc.2.patch:19` 中 dsh 安装依赖闭包都需要同步；`test/desktop-plugin-closure.test.ts:34` 覆盖该约束。安装闭包遍历的实现见 `node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:686`、`:702`。
4. 市场 generation 则从 registry 的 desired 状态投影到 Profile，且应在 Harness 停止后清理/切换。见 `src/main/state/generation-launch.ts:27`、`:55`；`packages/dsh-desktop-market-installer/generations/projection.mjs:27`。内置 WPS 的可执行资源应跟随安装版本，不能混入用户 generation 或由 Profile pnpm 首次联网安装。
5. Safe Mode 使用独立 patch，`HarnessRuntime` 明确禁止重新插入普通可选插件。WPS 默认不在 Safe Mode 启动；WPS 缺失、授权拒绝或服务损坏时，恢复入口仍可用。见 `src/main/runtime/harness-runtime.ts:476`。

建议新增一个安装自有包（名称待实现时确定，例如 `hqharness-wps`），遵循上述宿主插入流程。服务 payload 从当前安装 `resources` 的绝对物理路径读取；开发用专用 `.build` 资源目录。不依赖 cwd、系统 PATH、Profile 中恰好存在的 Python、旧应用 generation 或任意 npm/npx/uvx 下载。

现状差异：根 AGENTS 规定普通 host fallback 仅在 `ERR_MODULE_NOT_FOUND` 使用；当前 `build/host-module-fallback.mjs:16` 实际还接受 `ERR_PACKAGE_PATH_NOT_EXPORTED`。本分析不修改这项既有差异，也不建议 WPS 扩大该 fallback；WPS 私有普通依赖必须有自己的完整闭包。

## 3. 推荐的进程与传输接缝

建议保持以下单一责任链：

```text
Harness Agent / 现有 ToolRuntime
  → 安装自有 WPS 工具插件（schema、调用身份、路由、结果适配）
  → 仅供当前 Harness 使用的宿主能力桥
  → Electron Main 的 WPS service（会话授权、文件范围、队列、停止、审计）
  → 本地 MCP client / 托管 native broker
  → 已验证的 WPS 原生结构化接口
```

这是扩展现有宿主能力，不是另建 Agent runtime。Main 组装放在 `src/main/index.ts`，实际状态机和进程管理放独立模块；共享请求契约放 `src/shared`，preload 仅暴露必要的状态/停止 UI。模型不能传入可执行命令、shell、任意 URL、任意脚本或“owner=true”来取得权限。

共享协议应采用有限操作的判别联合与边界校验，文档/会话/generation/操作 ID 为宿主签发的句柄；将第三方实际 MCP 工具映射到已审查的有限操作表。不得把任意 `rawToolName + unknown args` 直接暴露成可执行宿主 RPC。工具新增或 schema 变更必须重新核查其操作类别、文件效果和取消能力。未选项目时不预造 Word/Excel/PPT 工具名。WPS 为可选能力，服务延迟到状态检查/首次受权调用才启动；未安装或启动失败应返回精确不可用状态，不能拖垮整个 Harness 引导。

可参照而非直接冒用现有自动化桥：`packages/hqharness-automation/index.js:36` 发送有界请求和会话身份；`src/main/automation/service.ts:88` 校验 loopback host、Origin、Bearer、路径和请求大小，`:46` 在 Harness 重启时轮换 token、撤销授权。WPS 需要自己的文档能力语义；现有 `AutomationCapability` 只有 browser/computer，不能直接伪装为 computer 继承“可查看整屏与键盘鼠标”的授权说明。共用停止入口可以协调各服务，不应把 WPS 文档业务堆进 GUI 引擎。

### stdio 优先，但必须有明确进程所有者

对于随安装包携带、无需独立常驻服务的本地 connector，优先私有 stdio：不开放监听端口、无局域网暴露，安装路径与生命周期更确定。进程由 Main service 管理，明确 stdio framing、stderr 有界日志、启动/握手/发现/调用/关闭的 deadline、取消及真实退出确认；其自启子进程也属于托管范围。若为 Node 服务，复用当前 Electron Node 模式；Python 服务可在版本与依赖兼容性核实后复用下节 payload。不要额外携带未经必要性论证的 Node/Python。

不能将现成 `mcp-client` 的 stdio 当作已满足此管理能力：

- bridge `lib/index.js:20` 明确说明 spawn 由 SDK 负责，仅共享 `scrubbedParentEnv()`；它**不经过** `ctx.subprocess.spawn()` 或 `ctx.sandbox`。这既不证明其读写限于 workspace，也不证明启动的 WPS 应用受到进程 sandbox 约束。
- 实际 SDK 2.2.0 的 `dist/stdio.mjs:74` 使用 `cross-spawn`，`shell:false`、Windows `windowsHide:true`；`:181` 关闭 stdin 后对直接子进程依次 TERM/KILL。这不等于管理所有后代，尤其不能证明 COM/已运行的 WPS 被停止。
- SDK 的版本协商有临时探测 sibling；bridge README 的 `README.zh.md:28` 也提示 stdio 会先探测再启动实际进程。connector 的启动、initialize、tools/list 必须无文档副作用，不得在探测阶段打开或修改用户文档。
- bridge 的 reconnect 仅重连/重新同步工具；不会证明此前 mutation 未执行。它有 5 秒关闭确认和避免连接失败时并存服务的逻辑，见 `lib/index.js:442`、`:533`、`:700`，仍不能替代 WPS 任务级 quiescence。

建议复用公开 `createMcpToolDefinition` 做 Harness 侧结果适配，由 WPS 自有服务拥有连接及操作边界，不复制整份 bridge。若选定项目只适合现成 generic bridge，必须先补可重用、受测的 transport/process-owner 接缝，或证明服务本身已经提供同等进程、授权与停止保证；不能修改私有方法后称作公开插件扩展。

标准 SDK 已核实的 Main 侧接缝是 `@modelcontextprotocol/client` 根导出的 `Client`、`Transport`、`ReadBuffer`、`serializeMessage`、`StreamableHTTPClientTransport`，以及 `@modelcontextprotocol/client/stdio` 的 `StdioClientTransport`；不是旧版 `@modelcontextprotocol/sdk/client/...` 路径。`Client.connect(transport, options?)`、`listTools(params?, options?)`、`callTool(params, options?)` 分别见 SDK `dist/index.d.mts:2316`、`:2721`、`:2693`。自有托管 stdio transport 可实现公开的 `start/send/close/onmessage/onerror/onclose`，把管道连接到 Main 持有的进程；协议 framing 可复用 SDK，不自行再写 MCP。其公共 Transport 定义见 SDK `dist/index-D_QDtbiv.d.mts:1730`，该 hashed 文件仅作证据，业务 import 必须使用根导出。

不能通过读取 `StdioClientTransport._process` 接管进程；这是私有实现。SDK 的 custom transport 在 `auto` 协商下是在原连接探测，只有 SDK 原始 StdioClientTransport 才有 disposable sibling（`dist/index.d.mts:1836`）。选定 server 后固定、测试其支持的协议及协商模式，所有 probe/重连仍属于同一进程所有者。Main 若直接 import SDK，应把 `@modelcontextprotocol/client@2.2.0` 声明为根生产依赖并更新锁文件；当前它仅是 bridge 的传递依赖，不能依赖 npm 恰好 hoist。自有 Harness 插件应声明其实际使用的 `dsh-mcp-client`、`dsh-tools` 等宿主 peer，并验证安装后的闭包。

### HTTP 的使用条件

只有选定项目/WPS 官方扩展要求独立 HTTP 服务或应用内常驻扩展时采用 Streamable HTTP。约束为 loopback 随机端口、每次启动短期随机凭证、准确 Host/Origin 检查、明确 MCP path、禁止任意远程 URL/重定向携带凭证、进程和端口复用身份核对。应用附加模式中，Desktop 只停止自己发起的操作与 connector，不能结束用户已有 WPS。HTTP 断连不等于取消了服务端写入。

generic bridge 只把 `url`/`headers` 交给 SDK（`lib/index.js:46`），不能据此声称这些本地 endpoint 约束已实现；其 HTTP 断线请求恢复也不是自有服务的启动/关闭管理。

## 4. WPS 结构化优先与 guard 的可靠识别

当前真实行为有两层，必须同时修改：

- `tool-routing.js:1`～`:10` 按已知工具集合分类，`:111` 起执行 guard；未知第三方 MCP 目前未分类，直接模型调用通常不会因为名称含 `mcp` 被拦截。但 `:174` 的提示词要求所有本地文件与 Office 先用 computer_use，会把 WPS 模型选择导向错误路线。
- 默认 `run_code` 只接收 `return await tools.browser_use(<strict JSON>);` 或 computer_use 同形包装（`:16`～`:28`、`:121`～`:133`）。即使 WPS 原生调用可用，PTC-only 模式仍会在调用 WPS 前被外层 guard 拒绝。

**正式策略应是：** 已验证且已授权的内置 WPS 文档结构化能力优先；网页仍 browser_use；通用本机文件发现/管理及未支持的应用操作继续现有 computer_use 路由。只在 WPS 确认“不支持此操作且未发生输入/写入”时允许切换到 GUI。拒绝、停止、权限缺失、部分写入、结果未知均不能自动换工具重放。用户明确要求全程界面时保留其指令优先级；用户要求 WPS MCP 时不能要求其另写“直接工具”来解锁。

### 不能从名称或 MCP 自述认定 owner

当前 bridge 构造的 ToolDefinition 仅带 name、description、parameters、output、execute、projectContent（`lib/index.js:179`）。它没有保留可供 guard 查询的 `serverName/rawName/owner` 元数据，也没有把 MCP annotations 变成 Harness 文件权限或并发策略。`serverInfo.name`、description、annotations、名称前缀甚至第三方同名工具均不能证明“Desktop 内置 WPS”。`readOnlyHint` 也只是提供方声明，不能直接授予文件读取能力。

可落地的最小接缝：自有 WPS 插件掌握它实际创建并注册的 **ToolDefinition 对象与 connection generation**，维护非模型可写的 provenance 映射；策略查询时通过公开 `ctx.tools.get(exec.name, exec.agent)` 核对实际 scope 可见定义，不能仅查字符串集合。当前 `register` 保存传入 definition，`get` 返回 scope 的实际可见定义，见 `dsh-tools/lib/index.js:2878`、`:2995`。注册、重连换代、卸载与取消必须同步撤销映射；操作 execute 闭包与 Main 再核对 generation 和 grant，保证 HMR/异步晚结果不能重获权限。此映射是路由识别辅助，不能替代 Main 的最终授权。

如果实现要求在异步 pre-execute/并发重载期间精确证明“这次 dispatch 已绑定的定义”，现有公开 `ToolExecution` 没有 definition/registration-owner 字段，`get()` 只反映查询时的 registry 视图，不能伪称已具有不可变 owner 快照。此时应在 dsh-tools 补最小公开的 execution-bound provenance 查询接缝，并带作用域遮蔽、卸载竞态测试；不依赖私有 layer 或给 exec 强塞可伪造字段。第三方插件同进程执行本就不是恶意代码隔离边界，文件与会话检查仍须服务端执行。

PTC 兼容应保持一个严格语法：允许 **一个当前可信 WPS 工具** 的 `return await tools.<exactPublicName>(<strict JSON object>);` 包装，子调用仍经过正常 guard/授权/范围检查。目标身份从活动注册映射取得；不对 `mcp__wps__*` 通配放行，不容许 import、变量、循环、计算属性、额外表达式或多调用程序。rawName 含特殊字符/过长时公共名称有 hash，必须用真实发现及注册的名称，不自行猜拼。批量结构化修改若有需要，应是 connector 提供的受 schema 限制工具，而不是放开 opaque run_code。

需要同时扩展 guard 状态与提示词；新增另一个返回 allow 的 guard 无法覆盖原 guard 的 deny。现有 STOP/INPUT_UNCONFIRMED 状态主要追踪 browser/computer（`tool-routing.js:140`），WPS 必须有自己的 authoritative 停止和未知写入状态，并与跨路由恢复规则联动。特别要测试“GUI 拒绝后用 WPS 重放”“WPS 保存未知后用 GUI 重放”和子代理继承，不能把 WPS 例外做成 bypass。

## 5. 文件范围、同意、停止与写入事务

以下是实现/选型的硬要求，并非当前 generic MCP 已提供的字段。

| 边界 | 需要实现的行为 |
| --- | --- |
| 会话身份 | 用真实 Agent session 归属绑定请求；Main 的 grant 绑定当前 Harness 启动 generation、会话、文档集合/目录、读或修改权限。子代理不自动扩大父会话授权。只由模型传来的 owner 字符串不能授予权限。 |
| 文件范围 | 每次调用读取 `ctx.sandboxPolicy.resolve({ session: exec.agent.session })` 的 mode/workspaceRoot 并在服务端结合 grant 执行。API 见 `dsh-sandbox-policy/lib/types/index.d.ts:79`；generic MCP 不自动消费它。read-only 禁止修改；workspace-write 的工作区外输出需明确授权；danger-full-access 也不取消用户 stop。 |
| 路径规范 | 拒绝未经授权的 UNC/网络路径、URL、设备路径；按目标平台规范化并核对 realpath/文件身份及 symlink/junction，创建文件核对最近存在父目录。处理 Windows 大小写、重解析点及 WPS 自动另存路径；不能只做 startsWith 字符串检查。 |
| 文档句柄 | 句柄由服务产生且绑定会话、实际路径/文件身份、WPS 进程/文档实例、generation、权限；每个工具都核对。不能因句柄存在就允许操作当前活动文档或另一个会话的文档。 |
| 最小同意 | 首次访问被授权范围时清楚说明读/改哪些本地文档、哪些内容会交给模型。越界、覆盖原件、发送/分享/宏与外部连接分别按实际效果授权，不能把 WPS 授权等同全屏键鼠授权。复用 Main 原生对话框、可取消/有超时；新增授权文案与现有设置入口同步。 |
| 停止 | 设置入口与紧急快捷键同时撤销 WPS grant、使排队任务 generation 失效、取消 in-flight 调用；等待 broker 达到 quiescence。普通窗口关闭/托盘隐藏不等于退出，须沿用宿主语义。只结束 Desktop 自己启动且证明归属的 broker/专用实例，不误关用户 WPS 或未保存文档。 |
| 不可取消的应用调用 | 如果原生 API 在调用期间不可取消，必须返回“停止请求已记录/待确认”，隔离该文档，阻止后续写入和重连重放，直到读回证明最终结果；不得收到 AbortSignal 就报告“没有修改”。必要时终止自有 broker，仍需核对 WPS 是否继续工作。 |
| 串行化 | 同一 WPS 文档的修改、保存、关闭串行；读取是否可并行以实际 API 证明为准。`createMcpToolDefinition` 不设置 isConcurrencySafe，当前默认独占；不要仅按 annotations 开启并发。 |

保存默认应采用“原件不变、先生成修订副本”：同一目标目录的唯一 staging 文件 → WPS 真正保存/关闭或 flush → 独立重新打开校验格式与期望结构 → 形成结果与恢复记录 → 再发布新文件。写入前记录原文件身份、大小、修改时间/内容摘要与 WPS dirty 状态，识别外部修改和占用；不对用户已有未保存缓冲区暗中另存/关闭。

覆盖原件需要用户授权及可恢复备份。原子发布依赖同一文件系统、目标可替换、WPS 已释放锁；Windows/SMB/应用占用不能假设 rename 恒成立。若无法满足，清楚返回“修订副本已保存、原件未替换”或实际失败，保留原件与 staging 位置供恢复，不能降级成先删原件再写回。进程崩溃或应用重启后按 journal 恢复状态，不重复执行未知 mutation。journal 不能保存完整敏感文档内容或密钥。

工具结果至少区分：未执行、已修改未保存、已保存待验证、已验证发布、取消且未修改、部分修改/结果未知。需要操作 ID、文档 ID、实际输出路径、验证结论、可恢复材料及原始错误阶段；这些是建议的宿主结果契约，不能声称任何候选 MCP 已提供。返回 `tools/call` 200、`isError:false` 或文件存在均不足以证明保存成功。

原生应用自动化通常不能被普通文件 sandbox 完整约束。生产边界需要小型白名单操作适配器、授权与路径检查、受控文档实例和只读的 connector 安装目录；不能向模型暴露任意 COM dispatch、VBA、AppleScript 或通用脚本执行后称为结构化安全能力。宏、外部链接和嵌入对象的执行策略需由选定 WPS API 验证。

## 6. Windows/macOS 与安装包门禁

当前 Office authoring 是离线文件生成/校验/LibreOffice 转换机制，**不是 WPS 自动化**：

- `packages/dsh-desktop-office/index.js:8` 验证安装资源绝对路径，组合上游 skill/workspace-dependencies。
- `scripts/office-runtime/prepare.mjs:69` 从固定 SHA 校验的 Python 和 wheel 组装 staging，生成 `runtime.json` 后发布；支持 win-x64、mac-arm64、mac-x64，失败不消费旧 payload。锁文件为 `scripts/office-runtime/lock.json`。
- `build/harness-node-entry.mjs:90` 根据当前 app.asar/开发路径设置 Office resources 与 CLI，CLI 在 ASAR 外；`package.json:490` 将 `.build/office-runtime` 带到 resources。新 WPS payload 可沿用这套“锁定下载、离线构建、安装归属、物理路径”原则，不能假设现有 Python 已含 COM/pywin32 或 macOS WPS automation 依赖。
- `scripts/verify-target.mjs:10` 要求原生 platform/arch，`:23` 检查 Electron Node native loader；`scripts/after-pack.cjs:7` 调用 ASAR、PPT、Office gate。Office gate 实际运行安装目录 Python 生成并重新读取三种格式、pip check、结构检查和 PDF 转换（`scripts/verify-office-runtime.cjs:8`）。这些通过也不能代替 WPS gate。

可复用的确切 Python 接口为 `@deepseek-ai/dsh-tool-workspace-dependencies` 根导出的 `resolvePrimaryRuntime(absoluteSource)`：读取 `runtime.json`、验证 platform/arch 和入口，返回 `{ python, pythonPackages, pythonDistributions, node?, nodePackages?, pnpm? }`；源码见该包 `lib/index.js:83`、`:121`、`:131`，公开类型见 `lib/types/index.d.ts:38`、`:72`。当前 Desktop 以 `{ source }` 组合此插件，未传 `root`，因此原地只读使用，不复制到 Profile。Main 可按同一资源 resolver 查询 `resources/office-runtime/primary-runtime`，无需通过模型调用 `load_workspace_dependencies` 再启动服务；也不能把环境变量当作可信全局授权。

当前锁定 Python 为 **3.12.14**，记录的库包括 python-docx、python-pptx、openpyxl、XlsxWriter、numpy/pandas 等；没有 Python MCP SDK、pywin32 或已核实的 WPS adapter（`scripts/office-runtime/lock.json:2`、`:110`）。因此结论是“解释器与通用文档校验库可有条件复用”，不是“现有 payload 已能运行任意 WPS MCP”。选定 Python server 后核对 Python ABI、平台 wheel、依赖冲突和 native 初始化要求；兼容时构建阶段锁定/校验缺失依赖，按明确的包私有依赖布局加载，禁止首次启动 pip 安装、修改安装目录或全局 Python。原生 `.pyd`/DLL/脚本要完整放在 ASAR 外并验证加载路径；当前通用 `asarUnpack` 后缀规则（`package.json:358`）不含 `.pyd`，不能靠文件存在推断可加载。若依赖无法共享才论证隔离运行时，记录实际体积与离线安装代价。

| 平台 | 选型与实现前必须拿到的真实证据 |
| --- | --- |
| Windows x64 | 选定 WPS 发行版/版本/安装渠道的原生文档 API、注册/发现方式、应用与 broker 位数要求、普通用户运行、COM apartment/线程约束（如果实际采用 COM）、已运行应用附加与自有实例区分、锁定文件与停止行为。不猜测 ProgID、CLSID、命令行开关或自动注册命令，不在用户机器上顺手执行 regsvr32。 |
| macOS arm64/x64 | 所选 WPS 是否真正公开满足需求的结构化 API，以及对应版本可调用证据。Windows COM 实现不能推导 macOS 可用。若需要 WPS 插件、Apple Events 或辅助功能，分别确认安装/签名/TCC 与接口支持；只支持 UI 的项目不满足“结构化 WPS MCP”平台能力声明。 |
| 安装/升级 | 当前 resources 解析、带空格/中文安装路径、离线首启、卸载后无自有残留服务、WPS 未安装/旧版本/接口未注册时可诊断降级，不要求管理员和全局 Python/npm。更新后新会话重建 client 与 grants，不再引用旧安装路径。 |

WPS 应用本体是用户环境依赖，是否可随产品分发、connector 和 SDK 的许可证、签名/公证要求、资源体积与安装器增量均待选型后核查。Windows 已能连接只能发布 Windows 支持；macOS 未证明时应显示精确 unsupported 状态。不能把外壳插件能在 macOS import 视为 WPS 可用。

新增 native gate 应分两层：无 WPS 的 CI 核对 payload、哈希、目标架构、物理路径与受控失败；安装有指定 WPS 的原生 runner 实际握手/发现、创建和读回文档、修改/保存/验证、停止与恢复。发布资格必须包含后者，不能让 skipped 的真实 WPS 测试被概括为“跨平台通过”。签名后和安装后再验一次；保留安装包版本、WPS 版本、OS、arch、connector digest 与测试 Profile 证据。

## 7. 后续实施顺序与验收

1. 先固定候选项目 commit/发布包和许可证，用真实 `initialize`、`tools/list`、input/output schema、调用行为建立能力矩阵；分别证明 Windows 与 macOS 的结构化文档操作。未验证前不写具体 WPS 工具调用示例。
2. 固定 Main service 的会话/文件授权、停止、应用/文档所有权与保存恢复契约，再接 connector。禁止先以无范围 generic MCP 试用路径作为上线方案。
3. 安装自有 Harness 插件复用 `createMcpToolDefinition`，接入宿主来源 patch/依赖闭包，加入可信 provenance 与 GUI/PTC 路由例外。停止与未知写入状态先 fail closed，再添加 GUI fallback。
4. 扩展真实 Harness 子进程和临时 Profile 回归，覆盖插件加载/卸载/重载、scope shadow、伪装名称/description、MCP tool list 换代、缺 WPS/缺依赖、超时、停止、启动 probe、原件冲突、授权取消、子代理和跨路由重放。可参照 `test/automation-routing-harness.test.mjs`、`test/automation-routing-real-ptc.test.mjs`，不可仅用源码字符串契约测试。
5. 按平台验证安装资源、真实 WPS 与用户界面：一个明确的请求必须实际选中 WPS 工具、出现相符授权、产生可重新打开且结构正确的交付文件；没有 opaque run_code 绕路，没有文档外写入。覆盖冷缓存、Harness 重启、Desktop 升级及 Safe Mode。

本次仅核查源码、已安装发布包和锁文件，并用无副作用的模块解析确认 SDK 实际版本；未构建、未运行测试、未启动应用、未改真实 Profile 或系统 WPS 注册、未修改产品代码与 Git 元数据。该文档不宣称任何 WPS 项目已兼容或功能已在正式安装版生效。

尚缺：候选 MCP 与固定版本、各平台 WPS API 原始资料/实际调用证据、真实 tools/schema、应用附加与专用实例能力、取消与事务保存保证、所需 native/Python 依赖及许可证、目标 WPS 版本矩阵。上述信息决定 adapter 的具体代码与能声明的支持范围；不能从工具名称补全这些接口。
