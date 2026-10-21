# 内置 Browser Use 与 Computer Use

## 实现边界

两项能力作为安装包自带 Harness 插件注册工具，复用当前会话模型，不引入第二个 Agent runtime。Browser Use 使用 Electron 自带 Chromium；Computer Use 使用 MIT 开源的 `@trycua/cua-driver@0.28.0` 原生 SDK，在 Electron main 中直接运行，无需 daemon。版本沿用用户提供的已测组合，并由 npm 锁定各 OS/CPU 的平台库及 Electron copy-mode N-API binding。macOS 要求 13 及以上；当前分发目标仍为 macOS arm64/x64 与 Windows x64。无需额外安装 Chrome、Python、Rust 或自动化服务器。

新增依赖原因：现有 Electron 可管理浏览器和系统权限，但没有跨平台桌面输入接口。复用 Cua Driver 避免自行维护 CoreGraphics/SendInput 的 ABI；本机 arm64 原生依赖约 53 MiB（含 SDK、bindings 和平台库），其他平台以目标包验收为准。没有引入视觉推理服务或额外模型配置。

进程归属：工具定义及截图 attachment 存储在 Harness 子进程；浏览器窗口、系统权限、桌面截图和输入在 Electron main。两者通过随机 loopback 端口和每进程随机 token 通信；renderer 只获得具名的状态、停止与权限引导 IPC，不获得 token、任意命令或脚本执行接口。

加载阶段：normal Profile 的 Desktop patch 从当前安装目录插入 `hqharness-automation`，由它组合两个 Cordis 插件；服务与工具激活后，client 依旧从同一包入口读取 `dsh.client` 并注册两个设置 slot。插件不从 launch-root、用户工作区或其他安装 generation 解析依赖。Safe Mode 不组合两个插件，保留恢复能力。main bridge 缺失时插件报可诊断的 Desktop-only 状态，不能阻断核心 Harness。Cua SDK 延迟到第一次桌面操作加载；初始化失败保留原始 cause 与原生包诊断，不阻断 Browser Use、Harness 和恢复界面。

第一次执行需要会话范围的原生授权；授权不跨应用重启，停止入口和紧急快捷键立即撤销全部授权并关闭受控浏览器。队列串行化本机输入，取消与撤权在副作用前再次检查。截图和页面内容属于不可信数据；工具提示要求危险提交遵循用户确认，不提供绕过系统权限或 UAC 的能力。

工具执行以真实 Agent 的 `session.header.id` 作为授权、浏览器和截图映射的共同 owner；Agent 没有 `sessionId` 字段。缺少有效 Session 时拒绝执行，不用任意 agent ID 或全局共享 key 代替。截图结果必须遵守 ToolRuntime 的无损 JSON 契约：删去源坐标字段，而非返回 `coordinates: undefined`。0.1.3 修复这两处实际执行阻塞。

内置插件 0.1.2 修复内部原生会话结束后持续失败的问题。Cua 0.28 的隐式会话结束后不会由普通工具调用自动恢复；复用同一个 driver 会持续返回 `session_ended`。宿主在每次原生调用前使用 SDK 的 `startSession({})` 附着/恢复内部会话，仍受宿主当前会话授权和取消控制，不扩大权限或延长宿主的 30 分钟授权。恢复后仅观察可以直接继续，输入必须重新观察取得新 snapshot，不自动重放点击、键盘或文字。工具说明同时明确没有需要用户重开的 GUI 会话开关。OS 权限、UAC、安全桌面和显式停止仍按原边界拒绝操作。

0.1.5 修复授权超时误报为用户拒绝：Electron 的 `AbortSignal` 关闭弹窗时也返回 Cancel，旧代码先解释 Cancel，掩盖了 30 秒的计时器超时。现在先保留取消原因，只有实际选择取消才返回 `DENIED`。授权前恢复/显示宿主窗口并请求焦点；窗口不可用返回 `CONSENT_UNAVAILABLE`。排队/授权最多等待 120 秒，成功授权后独立执行 30 秒操作预算；超时返回 `CONSENT_TIMEOUT`，不授予权限且不执行操作，可直接重试触发新弹窗。输入读取上限 15 秒，插件传输/工具预算分别 175/180 秒，覆盖完整阶段。已有授权仍严格限制在当前会话的 30 分钟内，显式停止和拒绝不被自动绕过。

`node scripts/automation-consent-smoke.mjs` 在隔离 Profile 中使用真实 Electron 授权弹窗，分别验证 Browser/Computer 超时返回正确原因、隐藏父窗口恢复显示、无授权及同一服务继续请求。回归测试补充允许、主动取消、停止和重试路径。该流程不操作用户桌面、不自动点击允许；Windows 任务执行此原生弹窗验收，但正式安装后的焦点及真实允许/桌面输入仍须单独验收。

`HQHARNESS_AUTOMATION_TOKEN` 仅注入 Harness 进程，工具直接在该进程内访问桌面桥。上游 subprocess 的 `KEY|PASSWORD|SECRET|TOKEN` 环境过滤会使普通 shell 读不到它，这是预期的凭据隔离，不能因此放宽鉴权或向 shell 转发 token。Windows PowerShell 的受限启动故障属于 subprocess/sandbox 链路；两个内置自动化工具不依赖 PowerShell。

浏览器使用独立 cookie/session 分区，不读取系统浏览器 Profile，不携带 HQHarness 窗口 preload。仅加载 HTTP/HTTPS；摄像头、麦克风、文件、设备等页面权限默认拒绝。页面访问失败、陈旧元素引用、权限拒绝、取消和窗口关闭均保留明确错误。

桌面操作坐标来自最近截图，携带 display ID 和 snapshot ID；按实际缩略图尺寸映射回 Cua 原生截图像素，包含 Retina/Windows DPI，不能用 Electron DIP 代替。Cua 0.28 的可移植 desktop target 仅支持 `primary`：客户端、工具说明和错误返回均明确主显示器限制，其他显示器请求拒绝执行。拓扑变化、截图超过 90 秒或消费过的 snapshot 必须重新观察；捕获过程中拓扑变化也不能发布有效截图。每次输入后重新观察实际结果，驱动部分执行/疑似无效的返回不得报告成功。

## 0.1.6 结构化观察与本地计划

Browser Use 默认返回 Chromium accessibility 元素树，不调用截图；`screenshot: true` 才返回图片和对应的坐标尺寸。优先使用最近观察中的 `ref` 或精确 `target: { name, role? }`。多个元素同名且无法通过 role 唯一确定时返回 `AMBIGUOUS_TARGET`，不选择第一个匹配。无图片的 observation 不授予坐标输入能力，即使知道窗口尺寸也不能盲点坐标；必须重新请求带截图的观察。

Computer Use 先用 `action: 'windows'` 发现应用窗口；可选 `pid` 仅过滤对应进程，列表返回真实 `pid` 与十进制字符串 `window`。后续 `observe` 显式提供这两个标识，不猜测前台应用，也不把原生 64 位窗口标识转成可能丢失精度的 JavaScript number。窗口观察默认不截图，返回有界 accessibility 元素、当前 snapshot、可用动作以及完整性/降级标记。窗口路径优先使用 `ref` 或精确 name/role 定位；语义输入是否可用取决于具体应用暴露的可访问性接口，不能假定所有 Windows 应用或自绘控件都支持后台操作。当前适配器使用 foreground delivery；发现窗口不等于已经验证其全部操作。

显式 `pid/window` 的窗口观察与无 `pid/window` 的桌面观察是两个坐标空间。窗口的 `screenshot: true` 用于辨认内容，后续窗口输入仍使用元素引用或语义目标；需要坐标输入时先 `observe` 桌面并取得主显示器的 display/snapshot。桌面兼容路径仍返回主屏截图，未因默认结构化观察而变成无图路径。不可访问的控件、截断或降级的树应根据返回状态选择重新观察或视觉 fallback，不能把空树当作不存在控件。视觉 fallback 仍要求当前模型真正支持图片输入。

两项工具增加 `action: 'run'`，复用现有 Harness 模型、会话及授权。模型给出短计划后，宿主在本地按顺序重取元素、精确匹配和执行，不在每步另建模型调用。计划必须携带当前有效 snapshot；Browser 同时使用对应 tab，Computer 使用对应 pid/window。每段 1–8 步，允许 `click`、`type`、`key`、`scroll`、`wait`，步骤共享 15 秒预算；排队/授权与显式请求的最终截图另计，仍受宿主单次操作 30 秒预算约束。`type`、`scroll`、`wait` 要求语义 target，Computer 的 `key` 也要求 target；Browser 的 `key` 可作用于当前受控 tab。步骤不接受 ref、坐标、脚本或任意命令。`type` 的 `replace: true` 替换已有文本；`wait.value` 省略表示等待目标存在，字符串表示等待精确值，空字符串只匹配真实空值。

整个鉴权请求体按 UTF-8 编码限制为 64 KiB，包含 owner、operation、steps 与文本；字符数不等于字节数。插件在 fetch 前检查，宿主读取时再次检查，超限以 `INVALID_INPUT` 拒绝，须缩短文字或拆分计划。拆分后使用新观察确认当前状态，不能假设上一段全部完成。

每次输入消耗旧 snapshot；成功动作尽量直接返回新 observation，下一步可使用其 snapshot，避免重复请求同一张截图。`run` 的 `sequence` 返回 `status`、`completed`、`total` 和 `elapsed_ms`，失败另有 `failed_step` 与错误 code/message，并返回 `observation_required: true`。失败步骤可能已经部分生效；不得自动重放失败输入或整段计划。先观察实际结果，再决定剩余步骤。显式停止/连接取消保留原始取消原因，不包装成计划完成；歧义、陈旧目标与权限拒绝同样停止后续步骤。截图、网页和应用文字仍属于不可信输入，计划执行不绕过危险提交确认。

宿主为成功的非 status 请求和已认证且仍能返回 JSON 的 HTTP 400 失败响应附加 `host_timing`，单位为毫秒。失败发生在 engine 准入前时 `execute_ms` 为 0；失败后的授权等待不能被误算成本地执行：

| 字段 | 实际范围 |
| --- | --- |
| `queue_and_consent_ms` | 宿主开始处理至 engine 准入，包含请求读取/校验、排队及必要的用户授权 |
| `execute_ms` | engine 执行，包含本地查找/等待、原生输入、截图与结果观察 |
| `total_ms` | 宿主开始处理至准备响应；不是客户端完整等待时间 |

这些字段不包含 Harness 中的 attachment 入库/模型请求图片处理、模型推理、云端往返或响应后的 UI 展示，也不把 native 输入、截图和模型等待自动细分。工具调用数不等于模型请求数。排查“每次点击前思考或等截图很久”时，需将这些宿主时间与真实模型请求时间、图片数量/字节及最终任务成功率一并记录；本地 fixture 的耗时不能证明课堂场景或模型端到端提速。

## 0.1.7 文本结果校验与失败诊断

Cua 0.28 的 `type_text` 可以返回 `Unverifiable`，表示 SDK 没有确认文本结果。之前的适配层立即抛错，使宿主已有的原生控件读回校验无法运行。现在只有在初始控件值可读、输入后唯一匹配控件的完整值精确等于预期追加结果时才确认成功；缺少初始值时在派发前拒绝。`Partial`、`Refused`、`SuspectedNoop`、escalation 和焦点保护仍然拒绝，输入绝不重放。模型可见值的截断不影响宿主保存的完整值比较。

Windows 的前台 `type_text` 按当前光标/选区插入。追加模式先对同一控件令牌发送 `CTRL+END`，再只发送一次后缀；每次调用分别检查会话和焦点，光标操作失败、取消或会话恢复时不发送文本。最终仍须通过完整值读回，不通过覆盖初始文本来模拟追加。原生门禁必须验证非空初始值后的中文追加及实际按钮处理结果。

插件以公开 `HarnessError` 保留机器可读错误码；失败正文只补充三项有界整数的宿主计时，不附加请求正文或原生 cause。这样实际 Agent/ToolRuntime 的失败会话也能区分授权与本地执行时间。修复输入校验不代表模型首 token 等待变短，不能据此宣称完整任务提速。

## 验收

源码行为回归覆盖输入校验、认证/Origin 拒绝、会话隔离、串行队列、撤权/取消、元素陈旧、缩放和错误返回。真实 Electron 验收使用本任务窗口与临时 Profile，检查 Browser Use 的观察/截图/点击/输入/导航，检查 Computer Use 的权限及原生输入闭环。安装包资源和真实 Harness 后端、客户端发现/引导/UI 挂载分别验证。

执行回归必须从真实 AgentLoop 创建会话，经 ToolRuntime 执行两个工具；同时验证截图输出、不同会话 owner 与授权拒绝，不能仅注册工具或构造不存在的 Agent 字段。原生 smoke 补充真实 Harness 测试子进程、生产环境构造函数、桌面桥和实际目标窗口文字验证（仅授权弹窗与 attachment 测试存储使用确定性 fixture）。安装包 smoke 从实际 app.asar 导入 Agent、ToolRuntime 与自动化插件，验证带鉴权请求和截图 JSON 返回；它不替代 Windows 安装后 GUI/input 验收。

macOS 本机验收不能替代 Windows 原生验收；正式 Windows 分发必须在 Windows runner 通过相同真实浏览器/输入 smoke，再分发。用户明确要求先提供安装包自行验收时，可使用 windows-acceptance workflow：保留原生目标、完整回归、打包与原生模块门禁，安装后 GUI/input 验收标记为 pending，禁止创建正式 Release。macOS 未授权时必须展示权限引导，不把权限缺失包装成成功。

0.1.6 的 [Windows 验收 workflow](../.github/workflows/windows-acceptance.yml) 在打包前增加两个必过门禁，任一个失败都阻止生成验收安装包：

- `node scripts/automation-performance-smoke.mjs`：真实 Electron 与任务自有网页，验证默认无图、中文替换、三步本地计划、显式图片/坐标、歧义停止、15 秒步骤超时和取消后不执行后续步骤；以独立 DOM/事件状态核对结果。
- `node scripts/automation-window-smoke.mjs`：仅 Windows，启动任务自有 WinForms 窗口，用真实 UIA 发现/观察、设置非空初始值、追加中文、点击与等待，读取独立结果文件核对 TextBox 值及实际 click handler 恰好执行一次，另验显式窗口图片和旧 snapshot 拒绝。需要可交互 Windows 桌面，环境不满足时失败，不跳过验收。

两脚本输出各阶段时间、操作数及图片数，日志作为 `hqharness-windows-automation-acceptance-logs` artifact 保存。`windows-acceptance.json` 仅在前序门禁成功后记录对应 fixture 验收通过，并明确 `endToEndModelSpeedup` 尚未测量；它们没有调用云模型，也不替代最终安装版本的实际应用、课堂操作、模型能力及性能对照验收。配置了 workflow 不表示当前提交已通过 Windows 运行；以该提交的成功 run、日志、安装包 SHA256 与 manifest 为证据。

## 底层接口依据

浏览器使用 [Electron webContents debugger](https://www.electronjs.org/docs/latest/api/debugger) 与 [Chromium Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)；桌面采用 [Cua Driver application SDK](https://github.com/trycua/cua/tree/main/libs/cua-driver/typescript) 的固定工具适配，保持其原生许可/拒绝与 `AbortSignal`。macOS 权限按 [Electron systemPreferences](https://www.electronjs.org/docs/latest/api/system-preferences) 检查，显示器拓扑由 [Electron screen](https://www.electronjs.org/docs/latest/api/screen) 提供。停止先取消所有已准入动作，再 shutdown/destroy SDK session；重开等待旧驱动清理完成，应用退出等待原生清理。

`browser_use` 默认 `screenshot=false`，可用元素树和引用完成普通网页操作。`computer_use` 的窗口路径优先使用可访问性数据；图片理解仅在请求截图并走视觉判断时需要，模型显示名不证明该部署具备图片输入能力。图片入库规范化后，由插件记录本次截图的尺寸映射；无图片的结果只记录 snapshot。映射缺失、旧 snapshot、显示器拓扑变化或截图超过 90 秒时拒绝坐标输入并要求重新观察。

新增的 `@deepseek-ai/dsh@0.2.0-rc.2` dependency patch 仅把内置包加入安装包/普通 Profile 的宿主闭包；它不改变 loader 或 Safe Mode 的解析规则。当上游提供等价的正式宿主依赖扩展契约并覆盖 Profile/client 发现时可移除此补丁。干净 npm ci 重放与实际 Harness 启动都作为验收项。

`@ubjs/node@0.31.0-3` 的最小补丁仅将 Electron 下的已解析 `.asar` 原生库路径映射到对应 `.asar.unpacked` 文件；普通 Node、非 ASAR 路径、package exports/平台选择均不变。已复现未补丁时 `dlopen ... errno=20`，补丁验收包含真实 ASAR 原生操作。所有 `.node/.dylib/.dll/.so` 均由打包配置释放到磁盘，afterPack 的 native-format 检查阻止遗漏。上游 resolver 支持 ASAR 后，升级 SDK/bindings 并重做同等验收即可移除此补丁。

用户提供的 setup ZIP 作为选型证据只读检查，不执行其中的脚本、不复制 Windows node_modules。其浏览器 provider 使用 Chrome DevTools MCP attach 模式，需要外部调试端口；内置 Chromium 消除这项安装步骤。其桌面说明记录了 Windows SDK 的 catalog/权限/尺寸只读探测，不能代替本版本安装后的实际点击与输入验收。

完整应用 QA 使用 Electron 的 `--user-data-dir=<绝对路径>` 开关；客户端显式保留该开关，默认生产/开发目录不变。诊断目录创建于任务临时目录中，不复制 node_modules、构建目录或真实用户 Profile。

会话恢复的原生 package smoke 从开发依赖及实际 ASAR 分别创建真实 SDK driver，读取尺寸、结束本测试的内部会话、确认 `session_ended`、显式重开并再次读取尺寸。Windows runner 执行同样流程；这是原生生命周期验证，不能替代安装后等待空闲、锁屏/远程桌面恢复及真实截图/输入验收。
