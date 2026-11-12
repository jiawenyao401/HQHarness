# Windows 结构化 Computer Use 调研

调研日期：2026-10-20。只读静态核查；未运行第三方项目、未更改产品代码、未做 Windows 性能实测。本文补充 third-hand 总体调研，专门核查 HQHarness 现有驱动能否承载相同方向的优化。

## 结论

优先复用已经打包的 Cua Driver 0.28.0，增加“精确窗口的 UIA 控件观察与语义操作”，无需为了获取基础 UIA 能力另加 Windows 原生 adapter。其 Windows 后端已经实现控件树、元素 token、Invoke、ValuePattern 写入及按窗口的输入路由。当前 HQHarness 只接入主屏截图和前台坐标输入，尚未向模型暴露这条结构化路径。该判断来自源码，实际收益和应用覆盖仍须 Windows 验收。

## 固定版本与证据范围

- 本地 `node_modules/@trycua/cua-driver/package.json`：0.28.0；锁文件也固定该版本。
- 官方标签 [`cua-driver-rs-v0.28.0`](https://github.com/trycua/cua/tree/cua-driver-rs-v0.28.0)，提交 `1b50c02e2d34734f64d2d22f54eb76cc97b4a663`。此提交的 [TypeScript 包](https://github.com/trycua/cua/blob/1b50c02e2d34734f64d2d22f54eb76cc97b4a663/libs/cua-driver/typescript/package.json)和 [Rust workspace](https://github.com/trycua/cua/blob/1b50c02e2d34734f64d2d22f54eb76cc97b4a663/libs/cua-driver/rust/Cargo.toml)均声明 0.28.0。
- npm registry 未给此包提供 `gitHead`；以上为同版本官方标签，不冒充已完成 npm 二进制与源码的可复现构建验证。本地生成的 SDK 声明与下述能力相符。
- 官网文档随最新版变化；本报告以该提交和本地 SDK 为准。例如该版窗口树默认上限为 5000 节点、深度 25，不能套用后来文档的默认 250 节点。

## 已有能力与尚未接入的能力

| 方向 | 0.28.0 Windows 实现与边界 | HQHarness 现状 |
| --- | --- | --- |
| 全屏观察 | `get_desktop_state` 只有截图、尺寸和摘要；明确不遍历 UIA | 当前唯一桌面观察路径 |
| 精确窗口观察 | `get_window_state(pid, window_id)` 默认 UIA 树＋截图；可仅树、限制深度/节点、按 query 投影；返回元素及 snapshot/token | 未对模型暴露 |
| 控件语义 | 支持的控件会列出 invoke/toggle/select/expand/set_value/text/scroll 等能力 | 未返回控件能力 |
| 元素点击 | `click` 可用 element_token/index 解析当前窗口控件并走 UIA；像素点击另有路由 | 只发主屏坐标并固定 foreground |
| 文本写入 | generic `type_text` 的元素路径、`set_value` 使用 UIA ValuePattern；部分控件仅能按键输入；须读回验证 | 只向当前前台控件输入 |
| 输入后等待 | SDK 有 `verifyState` 的有界条件验证；未确认此版提供通用事件订阅或任意动作 batch | 固定等待 150 ms 后要求重新 observe |

源码：[Windows get_window_state](https://github.com/trycua/cua/blob/1b50c02e2d34734f64d2d22f54eb76cc97b4a663/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs#L1189)、[Windows get_desktop_state](https://github.com/trycua/cua/blob/1b50c02e2d34734f64d2d22f54eb76cc97b4a663/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs#L7753)、[UIA actions 识别](https://github.com/trycua/cua/blob/1b50c02e2d34734f64d2d22f54eb76cc97b4a663/libs/cua-driver/rust/crates/platform-windows/src/uia/mod.rs#L847)、[click](https://github.com/trycua/cua/blob/1b50c02e2d34734f64d2d22f54eb76cc97b4a663/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs#L3062)、[type_text](https://github.com/trycua/cua/blob/1b50c02e2d34734f64d2d22f54eb76cc97b4a663/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs#L4362)、[set_value](https://github.com/trycua/cua/blob/1b50c02e2d34734f64d2d22f54eb76cc97b4a663/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs#L5869)。本地接缝：`src/main/automation/native-input.ts:89`、`src/main/automation/computer.ts:35`。

本地 SDK 的生成声明在 `node_modules/@trycua/cua-driver/dist/native/cua_driver_contract.d.ts`：`GetWindowStateInput` 约 752 行、`WindowElement` 约 1379 行、`WindowStateOutput` 约 1404 行、`ClickInput` 约 328 行、`VerifyStateInput` 约 1324 行。方法在 `cua_driver_sdk.d.ts` 的 `CuaDriverLike`。typed `TypeTextInput` 未暴露 element_token，generic `callTool` 的 Windows 工具 schema 已暴露；集成时须在适配边界固定工具名、校验参数，不能杜撰 typed 参数或任意转发模型提供的工具名。

**仅把现有 capture.text 透传给模型不能得到控件树。** 此版 Windows `get_desktop_state` 的 text 是截图尺寸摘要；需要选定 PID 和 HWND 后调用 `get_window_state`，并保留该窗口的 snapshot、元素 token 与坐标系。

## 后台操作的实际边界

后台不是全局保证。同一应用的点击、文本、快捷键、拖动可能支持不同路径。此版按窗口类和操作种类判断 UIA/PostMessage 是否可能无效，拒绝时返回 `background_unavailable`，不默默改为前台。Chromium、内嵌 WebView2、WPF、Tk 等有不同限制；UIA 的按钮 Invoke 能成功，不代表该窗口的任意按键都能后台发送。[Windows delivery 模型和矩阵](https://github.com/trycua/cua/blob/1b50c02e2d34734f64d2d22f54eb76cc97b4a663/libs/cua-driver/rust/crates/platform-windows/src/input/delivery.rs#L1)

UIA provider 也可能缺树、信息滞后或挂起；此版窗口观察有 4 秒 provider 超时。canvas/WebGL 和自绘区域仍需要截图坐标。query 是结果投影，不能认定它自动消除了底层整树遍历成本；应显式限制 max_elements/max_depth。截图失败、树截断、degraded 状态必须透传，禁止包装成完整结果。[窗口观察实现](https://github.com/trycua/cua/blob/1b50c02e2d34734f64d2d22f54eb76cc97b4a663/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs#L1340)

## Microsoft UI Automation 提供什么

- Invoke 适用于单一明确动作；Toggle/Selection 有各自模式。调用后元素可能消失，不能持续复用旧引用。[Invoke](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-implementinginvoke)
- Value 可读写控件整体字符串；不是所有控件支持写入，不能把“有文本”视为“可 SetValue”。[Value](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-implementingvalue)
- Text/TextRange 可读文本、属性和区间、选择及滚动；不是任意富文本编辑 API。[TextRange](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-usingtextrangeobjects)
- 虚拟列表未实现化的条目不在普通树中；需 ItemContainer 查找、VirtualizedItem.Realize，再按需滚动。未在现有 Cua 公开工具中确认此完整路径，不能承诺“树里可直接找到所有行”。[虚拟化控件](https://learn.microsoft.com/en-us/windows/desktop/WinAuto/uiauto-workingwithvirtualizeditems)
- 事件订阅可减少持续轮询，但 provider 不保证上报每个事件；实现仍需有界超时和复查。现有 SDK 声明没有公开通用 UIA 事件订阅，不应把 SDK 活动遥测 observer 当作应用 UI 事件。[事件订阅](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-eventsforclients)
- UIA 不会自动绕过进程完整性、UAC、安全桌面等边界；不将放开权限作为提速方案。[安全边界](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)

## 对 HQHarness 的实施建议

1. 先分段记录授权等待、驱动观察/输入、图片编码、模型等待与工具往返的耗时，建立当前 Windows 基线；日志不含控件正文、截图和输入内容。
2. 保留现有全屏路径，同时增加精确窗口发现与 `observe(window)`；返回有界 UIA 树、element token、snapshot 和可选截图。窗口身份、坐标及授权归属都由主进程绑定。
3. 按当前快照列出的真实能力提供元素 click/填值，输入后读回状态。不得盲重放、跨窗口复用 token 或把拒绝自动转成前台操作。
4. 仅对明确、有限、可验证的动作序列减少模型往返；每步保留目标校验、取消、超时和结果验证。不要先做任意脚本 batch。
5. Windows 安装后对记事本、文件选择框、Excel/Word、DingTalk WebView、浏览器、自绘区域、DPI/多屏、锁屏/RDP 分别验收。统计端到端成功率、重试数、模型调用数、p50/p95 和前台干扰；只有测量后才能给出速度改善结论。

额外 Windows adapter 的触发条件应是已确认 SDK 缺失且课堂任务必需的能力，例如特定虚拟列表实现化、事件订阅或应用专用操作；基础控件树和语义点击并不满足这一触发条件。
