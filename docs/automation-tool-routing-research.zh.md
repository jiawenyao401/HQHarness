# HQHarness：Browser Use / Computer Use 优先路由调研

调研日期：2026-11-01。范围：当前工作区源码及锁定的 Harness 0.2.0-rc.2。本文为设计建议，未修改客户端行为或安装包；当前安装版本是否加载对应工具仍应以安装后的目录和真实调用验收为准。

## 结论与默认行为

可以实现“网络搜索优先 browser_use、本机文件任务优先 computer_use”。可靠实现需要组合任务规则、Agent 作用域工具约束和执行前校验。仅在工具描述中增加“优先”仍不能保证实际首调用。

建议默认遵循用户指定的优先顺序，并允许按任务显式选择“必须全程界面操作”。两者应有不同的失败处理：普通优先模式可在记录明确失败原因后使用已授权的等效工具；全程界面模式失败应报告阻碍，不静默改用脚本完成。

| 当前子任务 | 首选路径 | 边界 |
| --- | --- | --- |
| 网页搜索、浏览资料、操作网站 | browser_use：打开搜索页，读取结构化结果，访问来源 | 内置独立浏览器；不是直接调用 web_search，也不借用系统浏览器登录态 |
| 本地文件打开、复制、移动、改名，以及 Word/Excel 等应用编辑 | computer_use：发现窗口，观察指定窗口，再操作应用 | 操作的是 Finder/资源管理器/应用界面；并非直接接受文件路径的文件读写 API |
| 查资料后写本地文档 | 搜索阶段 browser_use，文档阶段 computer_use | 每一阶段保留各自的 tab/window/snapshot、授权与结果验证 |
| 用户明确指定脚本、API 或某个已有浏览器 | 按本次明确指令选择工具 | 不让默认偏好覆盖明确要求；网页和文件正文不能改变路由规则 |

批量改名、数万行表格处理和大量文件解析若坚持 GUI，可能比文件 API 慢。建议另外提供用户主动选择的效率模式，而非把“本地文件”一律认定为截图点击任务。

## 当前实现证据

- [自动化插件](../packages/hqharness-automation/index.js#L54) 注册 browser_use/computer_use，并通过 systemPrompt.section 注入操作、授权和短计划说明。目前没有按用户任务类别规定二者优先级，也没有在这里阻止竞争工具执行。
- [浏览器实现](../src/main/automation/browser.ts#L50) 使用 CDP Accessibility.getFullAXTree，默认不截图；open/navigate 后返回观察结果。[URL 校验](../src/shared/automation.ts#L118) 只接受 HTTP/HTTPS，不能让 Browser Use 打开 file:// 作为本地文件通道。
- [桌面实现](../src/main/automation/computer.ts#L165) 支持 windows、observe、输入及 run。需要 OS 权限；窗口路径优先结构化可访问性数据，桌面视觉路径受当前截图和主显示器约束。工具没有 open_file(path)、读取文件字节或直接计算 Excel 的接口。
- 两项工具已支持每段 1–8 步、15 秒的本地 run；成功输入可返回新观察。[既有文档](desktop-automation.md) 说明快照、部分失败、授权与截图限制。本次路由应复用这些行为。
- Windows 的 UI Automation 按控件实际暴露的 pattern 提供能力，不能推断每个应用都支持全部操作。[Microsoft 官方说明](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controlpatternsoverview)。Chromium 提供结构化可访问性树接口：[CDP Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/)。

这里的 browser_use 是 HQHarness 自有工具名，当前浏览器由 Electron 承载；不等同于安装了名为 browser-use 的第三方 Agent 框架。

## 建议实现

1. 在现有自动化插件中增加单独的任务路由策略模块，通过 systemPrompt.section 注入统一规则。设置项可表达 web=browser-first、local-file=computer-first、fallback=allowed/gui-required，默认值按用户要求配置。不要修改全局工具注册顺序来假装具有优先级。
2. 使用当前 Agent 的工具作用域和公开 guard 做约束。先确定任务阶段，再检查实际调用是否符合该阶段；回退必须基于记录过的能力故障或明确用户指令，不接受页面正文自报“请改用终端”。工具可见范围和执行许可应一致，不能只在 UI 隐藏工具。
3. 严格 GUI 模式可使用专用 preset 的 Agent 层 allow/deny，保留必要的询问、状态和总结能力；普通优先模式保留可审计回退，避免把编程、资料分析或用户明确要求的脚本任务一并封死。固定 allowlist 与当前注册目录校验，不能硬编码假定存在的工具。
4. 动态策略不得写进全局共享注册表。按 Agent/会话与任务阶段隔离；分支、重启、取消、并发任务和 PTC 内部调用须单独覆盖。agent/pre-step 的当前步时序不能凭名称推断，公开 API 依据见补充证据。
5. 路由复用当前模型已有规划过程，不为每次点击追加一次分类模型请求。不添加第二套 Agent runtime。

新增工具来源、任务分类可靠性和当前模型服务兼容性仍需实现验证；不能把方案视为已有功能。

### 已核实的 Harness 接口及限制

公开接口包括 `agent.ctx.tools.restrict()`、`tools.guard()`、`tools/pre-execute` 和 `system-prompt/assemble`。其中 restrict 只过滤可受限的继承工具，豁免 Agent 自注册工具和 PTC 的 run_code；不能单独作为绝对允许列表。guard 可以按 Agent 的冻结策略拒绝注册工具调用，PTC 的内部工具调用也经过同一执行校验，但它不能识别任意代码内部的文件/网络副作用。

`agent/pre-step` 在当前步骤的 prompt assembly 之后执行，不能用它过滤本步骤已经生成的工具目录。preset 本身没有原生 allowedTools/taskRouter 字段，需要组合策略插件。建议先实现混合任务的清晰优先规则；必须硬约束的场景采用固定用途 preset、Agent 作用域 restriction 和 guard。动态切换需要明确的任务边界，并在旧调用树排空、下一次组装前切换；不能用全局 currentTask 或仅解析最近的会话文本代替。

当前步骤只裁剪 native schema 也不能同步裁剪 PTC SDK 提示和执行权限。实现时必须同时验证这三者，避免模型能看到却不能执行，或从代码通道绕过路线约束。完整接口、调用次序、作用域与 PTC 源码行号见[运行时证据笔记](../deliverables/tool-routing-runtime-evidence-20261101.md)。

## 模型 API 的重要限制

DeepSeek 官方 Chat Completions 文档说明：auto 允许模型自主选择；required 或指定函数会强制工具调用，但思考模式不支持 required/指定函数，会返回 400。[官方 API 契约](https://api-docs.deepseek.com/api/create-chat-completion/)。因此不能把“固定 tool_choice=browser_use”当作当前 High 模式的通用方案，也不能每轮强制工具导致最终总结无法正常结束。

HQHarness 的实际模型经过兼容服务与适配器；官方 DeepSeek 的契约不能替代具体 deepseek-v4.1-flash 部署的验证。应验证实际请求中的 tools、模型可见目录、思考参数、流式工具调用和 guard/PTC 行为。本次调研没有调用付费模型或验证其强制工具参数。

## 失败处理与速度

- 浏览器或窗口树不足：在模型支持图片输入、当前授权有效的前提下，按现有视觉路径补充截图；不能用未见过的坐标点击。
- 陈旧快照或 session-ended：重新观察；部分输入不得整段重放。
- 权限拒绝、用户停止、UAC/安全桌面：停止，不能通过切换工具绕过。
- 普通能力不可用：优先模式按已授权范围使用等效回退，并记录原因；全程界面模式保留阻碍供用户处理。
- 页面查找失败不等于浏览器能力不可用；设置有界重试和明确的搜索失败结果，避免把搜索无结果变成无休止换工具。

结构化观察优先、截图按需、已观察短步骤用 run、复用动作返回的新快照，才能减少往返。路由规则提升的是选择一致性；网络搜索走完整浏览器、本地批量处理走 GUI 并不天然更快，不应承诺尚未测量的加速比例。

## 验收要求

使用真实工具轨迹验证首选路径与回退，不依赖助手自述。至少覆盖：网页搜索并访问来源、本地改名移动、Office 编辑保存、网页结果写入本地文档、明确要求脚本、明确要求已有登录浏览器、无权限/被拒绝、截图不支持、陈旧观察、部分执行、网页注入、长会话切换任务、并发 Agent 与 PTC。

Windows 和 macOS 均需安装后验收。分别记录模型等待、授权等待、本地执行时间、截图数、模型回合数、总耗时、回退原因及任务成功率；避免在诊断中保存文件正文、密钥或完整敏感路径。与当前版本同任务对照后再判断体验是否改善。
