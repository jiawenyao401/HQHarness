# HQHarness built-in automation

This package composes two Cordis plugins, `browser-use` and `computer-use`, and their two settings entries. It registers `browser_use` and `computer_use` with the existing Harness ToolRuntime. The current session model drives them; no second LLM key, Chrome install, Python environment or MCP server is required.

Privileged work belongs to Electron main. The package never imports Electron or depends on cwd for host package resolution. A process-local authenticated bridge is supplied only to the HQHarness child. Images are stored through Harness attachments and returned as durable image blocks.

First use requests session access. Computer Use also requires macOS screen recording and accessibility permission; Windows secure/UAC desktops are unavailable. Stop in Settings > Plugins or use Command/Control+Shift+F12 if registered. Safe Mode omits these capabilities.

See [implementation and qualification](../../docs/desktop-automation.md). The browser uses bundled Chromium; desktop input and capture use the bundled Cua Driver 0.28.0 native SDK. Computer Use currently operates the primary display and needs a model with image input. macOS requires version 13 or newer. No separate browser-use Python agent is installed.
