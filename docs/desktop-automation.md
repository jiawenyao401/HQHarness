# 内置 Browser Use 与 Computer Use

## 实现边界

两项能力作为安装包自带 Harness 插件注册工具，复用当前会话模型，不引入第二个 Agent runtime。Browser Use 使用 Electron 自带 Chromium；Computer Use 使用 MIT 开源的 `@trycua/cua-driver@0.28.0` 原生 SDK，在 Electron main 中直接运行，无需 daemon。版本沿用用户提供的已测组合，并由 npm 锁定各 OS/CPU 的平台库及 Electron copy-mode N-API binding。macOS 要求 13 及以上；当前分发目标仍为 macOS arm64/x64 与 Windows x64。无需额外安装 Chrome、Python、Rust 或自动化服务器。

新增依赖原因：现有 Electron 可管理浏览器和系统权限，但没有跨平台桌面输入接口。复用 Cua Driver 避免自行维护 CoreGraphics/SendInput 的 ABI；本机 arm64 原生依赖约 53 MiB（含 SDK、bindings 和平台库），其他平台以目标包验收为准。没有引入视觉推理服务或额外模型配置。

进程归属：工具定义及截图 attachment 存储在 Harness 子进程；浏览器窗口、系统权限、桌面截图和输入在 Electron main。两者通过随机 loopback 端口和每进程随机 token 通信；renderer 只获得具名的状态、停止与权限引导 IPC，不获得 token、任意命令或脚本执行接口。

加载阶段：normal Profile 的 Desktop patch 从当前安装目录插入 `hqharness-automation`，由它组合两个 Cordis 插件；服务与工具激活后，client 依旧从同一包入口读取 `dsh.client` 并注册两个设置 slot。插件不从 launch-root、用户工作区或其他安装 generation 解析依赖。Safe Mode 不组合两个插件，保留恢复能力。main bridge 缺失时插件报可诊断的 Desktop-only 状态，不能阻断核心 Harness。Cua SDK 延迟到第一次桌面操作加载；初始化失败保留原始 cause 与原生包诊断，不阻断 Browser Use、Harness 和恢复界面。

第一次执行需要会话范围的原生授权；授权不跨应用重启，停止入口和紧急快捷键立即撤销全部授权并关闭受控浏览器。队列串行化本机输入，取消与撤权在副作用前再次检查。截图和页面内容属于不可信数据；工具提示要求危险提交遵循用户确认，不提供绕过系统权限或 UAC 的能力。

浏览器使用独立 cookie/session 分区，不读取系统浏览器 Profile，不携带 HQHarness 窗口 preload。仅加载 HTTP/HTTPS；摄像头、麦克风、文件、设备等页面权限默认拒绝。页面访问失败、陈旧元素引用、权限拒绝、取消和窗口关闭均保留明确错误。

桌面操作坐标来自最近截图，携带 display ID 和 snapshot ID；按实际缩略图尺寸映射回 Cua 原生截图像素，包含 Retina/Windows DPI，不能用 Electron DIP 代替。Cua 0.28 的可移植 desktop target 仅支持 `primary`：客户端、工具说明和错误返回均明确主显示器限制，其他显示器请求拒绝执行。拓扑变化、截图超过 90 秒或消费过的 snapshot 必须重新观察；捕获过程中拓扑变化也不能发布有效截图。每次输入后重新观察实际结果，驱动部分执行/疑似无效的返回不得报告成功。

## 验收

源码行为回归覆盖输入校验、认证/Origin 拒绝、会话隔离、串行队列、撤权/取消、元素陈旧、缩放和错误返回。真实 Electron 验收使用本任务窗口与临时 Profile，检查 Browser Use 的观察/截图/点击/输入/导航，检查 Computer Use 的权限及原生输入闭环。安装包资源和真实 Harness 后端、客户端发现/引导/UI 挂载分别验证。

macOS 本机验收不能替代 Windows 原生验收；Windows 包必须在 Windows runner 通过相同真实浏览器/输入 smoke，再分发。macOS 未授权时必须展示权限引导，不把权限缺失包装成成功。

## 底层接口依据

浏览器使用 [Electron webContents debugger](https://www.electronjs.org/docs/latest/api/debugger) 与 [Chromium Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)；桌面采用 [Cua Driver application SDK](https://github.com/trycua/cua/tree/main/libs/cua-driver/typescript) 的固定工具适配，保持其原生许可/拒绝与 `AbortSignal`。macOS 权限按 [Electron systemPreferences](https://www.electronjs.org/docs/latest/api/system-preferences) 检查，显示器拓扑由 [Electron screen](https://www.electronjs.org/docs/latest/api/screen) 提供。停止先取消所有已准入动作，再 shutdown/destroy SDK session；重开等待旧驱动清理完成，应用退出等待原生清理。

`browser_use` 可设置 `screenshot=false` 使用元素树和引用，在不支持图片的模型下完成普通网页操作。`computer_use` 依赖视觉观察，需选择支持图片输入的模型。图片入库规范化后，由插件记录本次截图的尺寸映射；映射缺失、旧 snapshot、显示器拓扑变化或截图超过 90 秒时拒绝输入并要求重新观察。

新增的 `@deepseek-ai/dsh@0.2.0-rc.2` dependency patch 仅把内置包加入安装包/普通 Profile 的宿主闭包；它不改变 loader 或 Safe Mode 的解析规则。当上游提供等价的正式宿主依赖扩展契约并覆盖 Profile/client 发现时可移除此补丁。干净 npm ci 重放与实际 Harness 启动都作为验收项。

`@ubjs/node@0.31.0-3` 的最小补丁仅将 Electron 下的已解析 `.asar` 原生库路径映射到对应 `.asar.unpacked` 文件；普通 Node、非 ASAR 路径、package exports/平台选择均不变。已复现未补丁时 `dlopen ... errno=20`，补丁验收包含真实 ASAR 原生操作。所有 `.node/.dylib/.dll/.so` 均由打包配置释放到磁盘，afterPack 的 native-format 检查阻止遗漏。上游 resolver 支持 ASAR 后，升级 SDK/bindings 并重做同等验收即可移除此补丁。

用户提供的 setup ZIP 作为选型证据只读检查，不执行其中的脚本、不复制 Windows node_modules。其浏览器 provider 使用 Chrome DevTools MCP attach 模式，需要外部调试端口；内置 Chromium 消除这项安装步骤。其桌面说明记录了 Windows SDK 的 catalog/权限/尺寸只读探测，不能代替本版本安装后的实际点击与输入验收。

完整应用 QA 使用 Electron 的 `--user-data-dir=<绝对路径>` 开关；客户端显式保留该开关，默认生产/开发目录不变。诊断目录创建于任务临时目录中，不复制 node_modules、构建目录或真实用户 Profile。
