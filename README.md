# LocalBoard

LocalBoard 是本地优先的 Windows GitHub dashboard，把路径/项目切换、个人待办、只读 Git 状态、GitHub Projects、Issues、Pull Requests、Actions、Codex/Agent 活动和桌面执行便签放在一个应用中。

## 路径与功能规则

LocalBoard 不会隐式执行 `git init`、添加 remote、commit 或 push。Codex Hook、Skill 或 MCP 上报当前执行路径后，broker 自动登记项目；每个 Git worktree 视为独立项目。

| 当前路径 | 可用功能 | 个人待办位置 |
|---|---|---|
| 非 Git 路径 | 全局待办 | `%LOCALAPPDATA%\LocalBoard\data\global-todos.json` |
| Git、未连接 GitHub | 仓库待办、只读 Git status/diff | `<worktree>\.localboard\todos.json` |
| GitHub 仓库 | 上述功能，以及 Projects、Issues、PR、Actions | `<worktree>\.localboard\todos.json` |

仓库待办创建或修改时会检查 Git ignore；若被忽略，LocalBoard 会在仓库根 `.gitignore` 末尾追加明确的反忽略规则。同步由用户自己的 Git commit/push 完成。

## 主窗口和执行便签

- 第一侧栏只显示 Codex/Agent 上报或用户显式登记、且当前仍存在的工作目录；支持 WinUI 图标模式、可展开的名称/路径列表、搜索和响应式浮层。主窗体浏览路径和自动化测试不会污染项目列表；右键移除不会删除磁盘文件。
- 主窗体采用 Fluent/WinUI 桌面壳、Windows 原生窗口按钮、系统明暗主题和可用时的 Mica 材质。第二侧栏按项目类型动态显示功能；Git 页面只读取 status/diff，不提供暂存、提交或推送。
- 一级项目栏最上方固定为“全局个人待办”，使用计划图标且不显示二级菜单；选择 Git 项目后，二级菜单只维护该仓库待办，不再混入全局待办。
- 项目身份严格取 Codex 会话启动目录；后续命令进入下级仓库或系统 Temp 目录不会新增/替换项目。
- GitHub 仓库通过已认证的 `gh` 访问。账户未登录、过期或与仓库绑定账户不匹配时显示登录、切换和刷新入口，不保存 token，也不会静默切换账户。
- LocalBoard 状态页显示 broker、项目、Codex/Agent 连接数、主/子 Agent 和执行状态，以及 Hook/Skill/MCP/插件安装结果。
- 唯一的 Codex 执行便签依次显示 Agent 活动、全局待办、仓库待办 Tab、Markdown/清单便签；仓库 Tab 用于切换并查看每个仓库的个人待办。四个分区可拖动调整或折叠，全局/仓库待办支持快捷新增与完成。
- 便签支持小/中/大尺寸预设和自由缩放，可吸附到任意屏幕的顶、底、左、右边缘；离开后收缩为状态细条，悬停自动展开。窗口、分区和吸附状态会持久保存并在显示器变化后恢复到可见区域。
- 设置页集中管理主题、Mica、开机启动、关闭到托盘、项目栏和便签吸附参数。
- PR 合并、Actions 重跑/取消均要求界面二次确认；对应 CLI 仍要求 `--yes`。

## 开发运行

要求 Node.js 22.5+。Git 和 `gh` 是按项目启用的可选能力：非 Git 路径不需要它们。

```powershell
npm install
npm test
npm run test:ui
npm run open
```

常用命令：

```powershell
localboard start D:\work\project
localboard workspace register --cwd D:\work\project
localboard status --json

# 自动作用域：Git worktree -> 仓库待办，其他路径 -> 全局待办
localboard todo add "修复上报" --priority 2
localboard todo list --json
localboard todo add "跨项目事项" --global

localboard context publish --source skill --status active
localboard mcp
```

## Windows 安装包

生成当前用户安装的 NSIS EXE：

```powershell
npm run dist:windows
```

产物位于 `dist\LocalBoard-Setup-<version>.exe`。安装包创建桌面/开始菜单入口；应用首次启动会启用托盘和开机静默启动，并尽力配置：

- Codex Desktop/CLI 生命周期 Hook；
- 用户级 LocalBoard Skill；
- Codex MCP server；
- ChatGPT/Codex 本地 LocalBoard 插件（Skill + MCP）。

某项客户端配置失败不会阻止其他项，结果写入 `%LOCALAPPDATA%\LocalBoard\integration-status.json` 并显示在状态页。安装器不会创建 Git 仓库、GitHub 仓库或 GitHub Project。

仍可使用源码内的 PowerShell 安装器：

```powershell
.\Install-LocalBoard.ps1
```

## MCP 工具

插件/独立 MCP 暴露以下结构化工具，全部复用同一个 loopback broker 和串行写入：

- `localboard_report_context`
- `localboard_list_todos`
- `localboard_add_todo`
- `localboard_update_todo`
- `localboard_remove_todo`

`scope=auto` 遵循上面的路径规则。Agent 不应直接编辑 `.localboard/todos.json`。

## 本地数据与安全

| 数据 | 位置 | 是否进 Git |
|---|---|---|
| 全局待办 | `%LOCALAPPDATA%\LocalBoard\data\global-todos.json` | 否 |
| 仓库待办 | `<worktree>\.localboard\todos.json` | 是 |
| 项目注册、gh 账户绑定、收藏、缓存、outbox、Agent 状态、便签布局与应用设置 | `%LOCALAPPDATA%\LocalBoard\state.sqlite3` | 否 |
| broker 端点 | `%LOCALAPPDATA%\LocalBoard\broker.json` | 否 |

broker 仅监听 `127.0.0.1` 并使用随机 bearer token；所有写入由单 broker 串行处理，重试使用幂等键。LocalBoard 不提供远程遥测。

更多设计约束见 [架构](docs/architecture.md) 和 [产品范围](docs/product-scope.md)。
