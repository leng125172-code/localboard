# LocalBoard

LocalBoard 是一个本地优先的 GitHub Project 桌面伴侣：把个人待办、屏幕便签、GitHub Project、Issues、Pull Requests、Actions 和 Codex/Agent 活动放在同一个工作台中。

当前仓库包含可运行的 MVP 骨架：

- 个人待办写入当前仓库的 `.localboard/todos.json`，不会同步到 GitHub Project。
- Git pre-commit Hook 自动暂存个人待办；pre-push Hook 阻止遗漏未提交的待办变更。
- GitHub Project V2 字段与草稿 Issue 可回写，Issue 可创建、编辑、关闭。
- PR 与 Actions 默认只读；合并、重跑、取消必须额外传 `--yes`。
- 桌面主窗口和 Codex 执行便签均为单实例；一个便签同时展示多个隔离的 Codex 会话卡片。
- 多个 Codex/Agent/CLI 进程共享一个 loopback broker，由它串行写文件并持久化幂等记录与 outbox。
- Codex 生命周期 Hook 和项目级 Skill 源码已放在仓库中。

个人待办不写入 GitHub Project/API，但会进入个人私有仓库的 Git 历史并随 commit/push 传播，这是本工具的预期行为。

## 快速开始

要求 Node.js 22.5+、GitHub CLI (`gh`)；桌面端需要安装 Electron 依赖。

```powershell
npm install
npm link
gh auth login --scopes "repo,project,workflow"
Copy-Item localboard.config.example.json .localboard/config.json
npm test
npm start
```

配置文件只保存 owner、项目号和仓库名，禁止放 token。LocalBoard 复用 `gh auth`。

常用命令：

```powershell
node src/cli.mjs todo add "完成同步冲突页面" --priority 2 --tags sync,ui
node src/cli.mjs todo list --json
node src/cli.mjs project pull --project-number 1 --repository owner/repo
node src/cli.mjs issue create "同步失败" --body "复现步骤..." --repository owner/repo
node src/cli.mjs issue close 42 --repository owner/repo
node src/cli.mjs pr list --repository owner/repo
node src/cli.mjs actions runs --repository owner/repo
node src/cli.mjs context inspect --json
node src/cli.mjs context publish --source skill
localboard git install
```

`project set-field` 的单选值是 option ID，不是显示名称：

```powershell
node src/cli.mjs project set-field ITEM_ID FIELD_ID single-select OPTION_ID --project-number 1
```

## Codex / Agent 接入

- `.codex/hooks.json` 记录 session、turn、subagent 的生命周期事件。Hook 是尽力而为的异步客户端，不会阻塞 Codex 工作。
- `.agents/skills/localboard/SKILL.md` 是 Codex 可自动发现的仓库级 Skill；复制到用户的 `~/.agents/skills/localboard` 后可在所有仓库使用。
- `integrations/codex/hooks.json` 是用户级 Hook 模板，要求 `localboard` CLI 已加入 PATH。
- Agent 应调用 `localboard` CLI，并在重试同一逻辑操作时复用 `--idempotency-key`。
- 后续 MCP server 直接复用相同 broker API，不另建一套写入逻辑。

Codex 会要求审查并信任新/变化后的项目 Hook；可用 `/hooks` 查看状态。

Skill 首先发布当前 CWD，并执行同步资格探测：

- 尚未 `git init`：只把执行路径显示在便签，不运行任何 GitHub 查询。
- 已初始化 Git、但没有 GitHub remote/配置：允许本地个人待办，不运行 GitHub 查询。
- GitHub 已配置、但 `gh` 未登录：显示“GitHub 未登录”，不运行 Project/Issue/PR/Actions 同步。
- 只有 `syncGitHub=true` 才允许访问 GitHub。

## 数据位置

| 数据 | 位置 | 是否进 Git |
|---|---|---|
| 个人待办 | `<repo>/.localboard/todos.json` | 是 |
| GitHub 配置 | `<repo>/.localboard/config.json` | 默认忽略 |
| Project/Issue/PR/Actions 缓存 | 用户 LocalBoard `state.sqlite3` | 否 |
| outbox、幂等键、Agent 事件 | 用户 LocalBoard `state.sqlite3` | 否 |
| 各 Codex 会话的执行路径/仓库上下文 | 用户 LocalBoard `state.sqlite3` | 否 |
| 屏幕便签与窗口位置 | 用户 LocalBoard `state.sqlite3` | 否 |
| broker 端点与随机令牌 | 用户 LocalBoard `broker.json` | 否 |

Windows 默认位于 `%LOCALAPPDATA%\LocalBoard`。数据库使用 SQLite WAL；服务只监听 `127.0.0.1`。

## 当前边界

这是第一阶段仓库，不是已完成的 GitHub Project 全功能替代品。桌面 UI 已接入个人待办、单实例执行便签、多 Codex 会话隔离、Project 状态与标题回写、Issue 创建/关闭、PR 和 Actions 列表；三方冲突处理、完整字段编辑与通知中心列入下一里程碑。详见 [产品范围](docs/product-scope.md) 与 [架构](docs/architecture.md)。
