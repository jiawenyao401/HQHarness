# Third Hand 对 Windows Computer Use 的适用性调研

调研日期：2026-10-20。仅阅读公开源码、Git 历史和 GitHub 官方 API；未安装或运行 Third Hand、arc-cua、Jev，未执行桌面操作，也未测量 HQHarness 或 Windows 的实际延迟。

## 结论

Third Hand 的设计对“每次点击前都要等助手思考或截图”有参考价值，主要价值是**减少大模型往返次数，以及使用结构化控件代替持续向主模型传整张截图**。它不能直接作为 HQHarness 的 Windows 桌面驱动：Third Hand 本体只面向 macOS，所绑定的 arc-cua 版本也没有 Windows 桌面后端；arc-cua 的 Chrome 后端另有跨平台能力，二者必须区分。[Third Hand 平台声明](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Package.swift#L1-L14)、[绑定驱动](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/ArcDriver.swift#L4-L16)、[arc-cua 平台边界](https://github.com/shhivv/arc-cua/blob/4f313bdf35c8b4043f5287f833b90dea9062dbfe/README.md#L441-L459)

建议借鉴它的计划与执行分工，在现有 Harness 插件及 Electron 原生能力中实现：主模型生成有边界的多步子任务，本地执行器逐步重新观察、匹配控件和校验结果，遇到歧义、失败或需要理解新内容时交回主模型。Windows 控件需要真实的 Windows UI Automation（UIA）实现，HQHarness 已有的 Cua Driver 0.28 可提供基础能力，详见 [锁定版本核查](windows-semantic-automation-research.zh.md)，不必为了基础 UIA 重写驱动。网页优先沿用 DOM/浏览器能力；这属于需要开发和 Windows 验收的设计判断，**不是已验证可直接移植的插件，也不是速度承诺**。

用户补充希望 Windows 的 Computer Use 与 Browser Use 都加速，重点是动作前模型/截图等待。对 Browser Use，HQHarness 已通过 Chromium CDP 的 `Accessibility.getFullAXTree` 提取控件，支持元素 ref，且 `screenshot:false` 可跳过截图；因此不能将 Third Hand/arc-cua 的“用 DOM 代替图片”描述为 HQHarness 完全缺失的能力。优先改进现有浏览器的主模型调用粒度、截图策略、局部观察和结果校验，不应另引浏览器及一套 runtime；具体耗时还要测量。[当前浏览器实现](/Users/jiawy/Documents/Codex/HQHarness/src/main/automation/browser.ts:55)、[当前工具参数](/Users/jiawy/Documents/Codex/HQHarness/packages/hqharness-automation/index.js:36)。本地链接对应本次读取的工作区，包含未提交工作，未作为第三方上游事实使用。

## 1. 固定的研究对象

| 对象 | 本次核查版本 | 说明 |
| --- | --- | --- |
| Third Hand 默认分支 HEAD | `412fbb8b546487fd2a5a3161efe900c2dcb5a187`，2026-10-04 | 调研时默认分支为 `master`；后文源码链接均固定此提交。 |
| Third Hand 实际绑定的 arc-cua | `4f313bdf35c8b4043f5287f833b90dea9062dbfe`，2026-10-04 | 源码使用 Git 依赖 `arc-cua[macos] @ ...@4f313bd`，不是当前 PyPI 最新版本。该提交包元数据版本写为 `0.1.0`。 |
| Third Hand 最新 GitHub Release | `v0.1.3`，2026-09-19 | 标签指向 `430394b35dbb44ff8b303bf19da29b0828d92bd2`，资产只有 Apple Silicon ZIP 和 SHA256 文件；早于本次研究 HEAD。 |

来源：[Third Hand 提交](https://github.com/shhivv/third-hand/commit/412fbb8b546487fd2a5a3161efe900c2dcb5a187)、[依赖固定行](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/ArcDriver.swift#L8-L16)、[arc-cua 包元数据](https://github.com/shhivv/arc-cua/blob/4f313bdf35c8b4043f5287f833b90dea9062dbfe/pyproject.toml#L1-L23)、[官方 releases API](https://api.github.com/repos/shhivv/third-hand/releases)、[v0.1.3 标签 API](https://api.github.com/repos/shhivv/third-hand/git/ref/tags/v0.1.3)。发布列表和 CI 状态是 2026-10-20 的查询结果，可能随后变化；不能把 HEAD 的实现直接当作 v0.1.3 安装包行为。

## 2. 操作为何可能更快

### 默认路径：一次计划，多步本地执行

主模型接收任务、应用名称及当前控件文本，一次调用 `act` 提供最多 12 个 `click/type/press/scroll/wait` 步骤。客户端按顺序执行；任何一步不成功即停止后续步骤。如果模型显式声明这些步骤完成任务，且全部成功，就直接结束；如果失败，或者成功后仍需读取未知内容再决策，才再次请求主模型。规划最多 15 轮；任务执行层另设 30 次动作和约 5 分钟活跃时间限制。这不是无限盲执行。[计划协议与边界](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/CodexAgent.swift#L47-L121)、[逐步执行和回交](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/CodexAgent.swift#L236-L284)、[执行层限制](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/TaskRunner.swift#L27-L40)

例如“点击搜索、填写词语、回车、点击某个结果”可以在一次主模型响应中给出；本地执行期间依然读取每个新页面，按标签定位控件。**省掉的是每一小步重新让主模型理解、推理和输出的网络往返，不是省掉所有观察和校验。** 该行为也有模拟执行层测试覆盖，不过本次没有运行这些测试。[一次规划测试及失败中断测试](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Tests/ThirdHandTests/CodexTests.swift#L391-L425)

### 先本地匹配，歧义才问 Jev

执行器将候选控件限制为支持对应动作的元素，优先使用标签、角色和邻近文本做唯一精确匹配，再尝试唯一包含匹配。这两种路径无需 Jev。只有控件重复或标签不符时才调用 TypeSafe 的 `jev-latest`，让它从给定候选中选择目标。普通请求最多选取 60 个候选；重复精确标签场景可更多，上限 254 个加一个“都不是”选项，请求体限制 24 KB。[匹配流程](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/TaskRunner.swift#L377-L435)、[候选缩减及请求形状](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/JevClient.swift#L17-L23)、[Jev 请求构造](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/JevClient.swift#L65-L141)

这意味着不能把 Jev 描述为本地模型：每次歧义匹配会多一次到 `https://api.typesafe.ai/v1/systemone` 的云请求，源码为目标选择设置 15 秒超时。它在某些场景减少主模型调用，但同时增加另一个服务的网络、限流和可用性依赖；在中国内网课堂环境中，净收益须按真实网络测量。[服务入口](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/JevClient.swift#L12-L26)、[请求与超时](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/JevClient.swift#L134-L141)、[HTTP 调用](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/JevClient.swift#L270-L288)

另一个需要避免照搬的细节：重复精确标签且 Jev 没选中时，代码会采用首个重复项。对业务表格中的多行“删除/提交”按钮，这种策略不能直接视作生产级安全选择，应在 HQHarness 中要求唯一归属或停止交回主模型。[首个重复项回退](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/TaskRunner.swift#L429-L434)

### 结构化观察及本地 OCR

前台路径读取 macOS Accessibility；已有调试端口的 Chromium/Electron 应用可读取 DOM。后台路径使用 CDP，或启动长期驻留的 arc-cua MCP 子进程。控件缺失时再启用 Apple Vision OCR；它提供的是文字区域，不冒充具有可编辑/点击语义的原生控件。源码中的主模型输入是控件文字，不是上传截图。[观察路由](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/TaskRunner.swift#L136-L178)、[实际观察](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/TaskRunner.swift#L600-L634)、[本地 OCR 实现](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/VisionObserver.swift#L1-L38)、[模型文本摘要](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/CodexAgent.swift#L134-L166)

客户端仍会为动作重读控件，在目标模型选择之后再次观察，检查控件身份和位置是否变化；执行后等待界面变化并验证。arc-cua 和 CDP 有“界面安静”判断，普通回退轮询却明确至少等待 1 秒、最多约 2.5 秒，每 150 ms 观察一次。所以这个实现本身并不是每个点击都毫秒完成。[动作前再验证](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/TaskRunner.swift#L452-L480)、[执行后验证](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/TaskRunner.swift#L515-L533)、[settle 与轮询参数](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/TaskRunner.swift#L687-L746)

### Ultrafast 是另一条实验路径

`Ultrafast` 由 UserDefaults 布尔开关启用，默认没有置为 true。开启后，每轮由 Jev 一次请求判断完成、动作及目标；需要文本时仍可能调用主模型生成文字，首轮会尝试并发预取。它不是默认多步计划路径，也不是完全本地执行或离线模型。不能把“每轮一个 Jev 请求”误读为“整任务一个请求”。[开关及说明](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/TaskRunner.swift#L235-L246)、[循环与文字生成](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/TaskRunner.swift#L256-L315)

## 3. Windows 与模型兼容边界

| 项目 | 已证实情况 | 对 HQHarness 的影响 |
| --- | --- | --- |
| Third Hand UI、进程、权限和输入 | Swift/AppKit、ApplicationServices、ScreenCaptureKit、Vision；最低 macOS 14 | Windows 不能直接运行；不能把 Swift 应用嵌入 Electron 就得到 Windows 支持。 |
| arc-cua 桌面后端 | 本次绑定版本的桌面实现面向 macOS，无 Windows UIA 后端 | Windows 必须另做本地桌面观察、定位和输入适配。 |
| arc-cua Chrome 后端 | 同一版本文档支持 macOS/Linux/Windows 的 Chrome 页面 | 可研究浏览器逻辑；不能控制任意 Windows Excel、资源管理器或钉钉原生窗口。 |
| 主规划模型 | 默认 `gpt-6-sol`，起始 effort `none`，失败升级同模型 `low`；模型名和 effort 可配置 | 模型名称可替换不等于服务协议可替换。 |
| 模型接入协议 | 固定 OpenAI Responses API、ChatGPT 登录凭据与流式事件解析 | 接 HQHarness 的 AgentOS/DeepSeek 需要协议适配或沿用现有 Harness 模型能力，不能只改 model 字符串。 |
| 控件选择 | TypeSafe 专用 systemone 接口，`jev-latest` 请求/响应协议 | DeepSeek Chat Completions 不会直接兼容；可研究独立 selector 接口，由本地唯一匹配优先。 |

来源：[Swift 平台](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Package.swift#L1-L14)、[Mac 框架](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/VisionObserver.swift#L1-L12)、[arc-cua Chrome](https://github.com/shhivv/arc-cua/blob/4f313bdf35c8b4043f5287f833b90dea9062dbfe/README.md#L339-L385)、[arc-cua 平台声明](https://github.com/shhivv/arc-cua/blob/4f313bdf35c8b4043f5287f833b90dea9062dbfe/README.md#L441-L459)、[模型 tier](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/CodexAgent.swift#L13-L20)、[服务地址与模型设置](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/CodexClient.swift#L36-L95)、[Jev 特定协议](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/JevClient.swift#L102-L141)。

依赖方面，Third Hand 的 Swift Package 没有声明外部 Swift 包，但构建脚本会打包 Python 3.13、Git 固定版 arc-cua 及其 Python 依赖。arc-cua 该版本使用 `httpx`，macOS extra 使用 PyObjC 的 Cocoa、ApplicationServices、Quartz、Vision；Chrome extra 使用 websockets。生产内置时还需建立安装包依赖清单和各平台实际启动验收，不能只看 Swift manifest 断言“零依赖”。[Python 打包脚本](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Scripts/bundle-arc-cua.sh#L1-L28)、[驱动依赖](https://github.com/shhivv/arc-cua/blob/4f313bdf35c8b4043f5287f833b90dea9062dbfe/pyproject.toml#L21-L42)

## 4. 性能证据究竟证明了什么

Third Hand 有真实的计时与调用次数收集代码，以及运行任务清单的 benchmark runner。默认样例是 4 个 Spotify 任务；记录任务状态、总时间、Codex/Jev 调用次数及动作数。调研提交的源码树中没有这些测试的原始结果文件、Windows 测量或与 HQHarness 的同任务对照；因此只证明有测量工具，不能证明达到某个倍数。[计数器](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/RunMetrics.swift#L3-L32)、[Benchmark 样例](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/Benchmark.swift#L3-L28)、[统计方法](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/Benchmark.swift#L64-L111)、[固定源码树](https://github.com/shhivv/third-hand/tree/412fbb8b546487fd2a5a3161efe900c2dcb5a187)

锁定版 arc-cua 文档中的约 9 ms 指**Chrome 中特定 Wikipedia 页面的观察耗时**，约 0.5 ms 是 settle probe；它们不包含主模型规划、云端选择、网络、网页加载和整任务验证。该版本还列有少量 JEV 浏览器任务示例数据（每项 5 次），依旧不能代表 Windows 桌面。另有 macOS 原语/工作流 benchmark 脚本与独立结果校验规则，但该事实不构成已经核实的本机或 Windows 数据。本次没有复跑这些数字。[Chrome 单项耗时](https://github.com/shhivv/arc-cua/blob/4f313bdf35c8b4043f5287f833b90dea9062dbfe/README.md#L375-L385)、[浏览器示例结果](https://github.com/shhivv/arc-cua/blob/4f313bdf35c8b4043f5287f833b90dea9062dbfe/README.md#L515-L533)、[macOS benchmark 范围与校验](https://github.com/shhivv/arc-cua/blob/4f313bdf35c8b4043f5287f833b90dea9062dbfe/benchmarks/README.md#L1-L48)

用于解释瓶颈的近似关系：

`总耗时 ≈ 主模型调用总耗时 + 外部 selector 总耗时 + 本地观察/输入/验证 + 应用自身等待`

移植多步计划能够减少第一项；引入 Jev 可能增加第二项；结构化观察、事件驱动 settle 和快照复用主要影响第三项。真实净收益、成功率和 P95 都须测量，不能用调用次数比例直接换算提速倍数。

## 5. 许可与成熟度

Third Hand 和其固定 arc-cua 源码均采用 MIT，许可文本允许修改、分发、再许可及销售，并要求保留版权与许可声明。这里核查的是源码许可事实；ChatGPT/TypeSafe 云服务、Python 分发及其传递依赖的使用与再分发条款未完成审查。MIT 不意味着附赠模型权重、云服务密钥或商用服务权益。[Third Hand LICENSE](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/LICENSE#L1-L21)、[arc-cua LICENSE](https://github.com/shhivv/arc-cua/blob/4f313bdf35c8b4043f5287f833b90dea9062dbfe/LICENSE#L1-L21)、[云服务调用实现](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/CodexClient.swift#L36-L95)、[TypeSafe 服务入口](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Sources/ThirdHand/JevClient.swift#L12-L26)

截至调研日，仓库有 41 个提交，公开 GitHub Actions workflows 查询返回 0；源码包含单元测试与手工构建、签名、公证脚本，但公开状态不能证明持续 Windows 验收。作者将项目列为 early/experimental，并列出控件不完整、图标界面、自定义编辑器、复杂手势的限制。这些信号适合把它作为架构参考，尚不足以作为课堂 Windows 客户端的即装即用依赖。[官方提交 API](https://api.github.com/repos/shhivv/third-hand/commits?per_page=100)、[官方 workflows API](https://api.github.com/repos/shhivv/third-hand/actions/workflows)、[构建签名脚本](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/Scripts/build.sh#L33-L55)、[作者状态说明](https://github.com/shhivv/third-hand/blob/412fbb8b546487fd2a5a3161efe900c2dcb5a187/README.md#L67-L71)

## 6. 对 HQHarness 的生产落地方向

以下是从源码机制推导的建议，尚未实现或验收：

1. 先把等待拆成可观察阶段：授权/排队、原生截图与结构化读取、图片编码/上传、主模型首字与总响应、原生输入、settle/验证、失败重试；按同一任务和设备记录中位数、P95、成功率以及调用次数，屏幕和用户内容不写入普通性能日志。
2. 在现有 Harness 工具协议中增加有界步骤/子任务，保留主 runtime 负责意图与跨应用规划；Electron 主进程只负责本地观察、确定性执行和结果校验，避免再嵌一套聊天 Agent。
3. Windows 原生应用优先 UIA 控件定位，网页优先 DOM；按目标窗口限定观察范围。控件不可读时再用 OCR/截图降级，保留截图坐标与快照有效期约束。UIA 和 OCR 真实开销、Office/钉钉等覆盖情况须逐应用测量。
4. 本地唯一匹配直接执行；歧义与新内容交给当前 DeepSeek 模型。是否引入第二个云端 selector 取决于同网实测收益、服务可达性、成本和条款，不能因为 Jev 名称带“快”就增加生产依赖。
5. 子任务每步检查窗口与控件身份、快照新鲜度；超时、焦点丢失、界面分叉或未验证结果时停止。输入是否发生不明确时不得盲重放，不可用“跳过观察”换速度。提供用户随时停止与清楚的失败阶段。
6. 发布前在真实 Windows 安装包验收浏览器搜索、Excel 表格、文件保存与钉钉网页等同任务；涵盖中文、DPI/多屏、遮挡、授权超时、停止重试。只在相同硬件、网络、模型、任务和成功标准下公布改进数字。

本次产物仅为调研记录，不更改 HQHarness 产品代码，也未引入新的运行时、模型服务或依赖。
