# 架构与同步约束

## 进程模型

```text
Codex hooks ─┐
Agents/Skill ├── localboard CLI/MCP ─┐
Git hooks ───┘                    │
Desktop UI ──────────────────────┼── 127.0.0.1 broker（每用户单实例）
Sticky windows ──────────────────┘       ├── tracked todo JSON（每仓库）
                                        ├── global todo JSON（每用户）
                                        ├── SQLite WAL（每用户）
                                        └── gh CLI ── GitHub API
```

- Desktop 用 Electron 的 `requestSingleInstanceLock` 防止重复应用；第二次启动只聚焦已有窗口。托盘进程支持开机静默启动。应用内部只维护一个固定 ID 为 `codex-activity` 的执行便签，置顶和跨虚拟桌面显示可分别切换。
- broker 用原子目录锁保证每个 OS 用户只有一个 owner。PID 存活检查、5 秒创建宽限期和健康检查共同处理并发启动、崩溃残锁与 PID 复用。
- UI 和 broker 解耦。关闭 UI 不终止后台服务；多个 Codex 进程只做客户端。broker 健康响应带协议版本，升级时客户端只终止已通过 bearer 健康检查确认的旧 LocalBoard broker。
- 每仓库 JSON 写入使用锁目录、临时文件和原子 rename。broker 再增加进程内串行队列。
- 每个 Codex 主会话以 `session_id` 为键，subagent 再附加 `agent_id`。Skill 优先读取 `CODEX_SESSION_ID`/`CODEX_THREAD_ID`；只有完全没有会话标识时才使用随机键。upsert 只能替换自己的卡片，因此并行 CLI 不会互相覆盖。`UserPromptSubmit`/`Stop` 更新 active/idle，异常退出的 active 卡片 30 分钟后标 stale，24 小时后从活动视图过期。

## GitHub 同步门禁

仓库探测顺序固定为 Git → remote/config → `gh auth status`。任何前置条件不满足都立即停止，后续命令不会运行：

- 非 Git 路径返回 `not-git`，且不会调用 `gh`。
- 没有 GitHub remote 或 `.localboard/config.json` 返回 `github-not-configured`，且不会调用 `gh`。
- GitHub 配置显式 `enabled=false` 返回 `github-disabled`。
- `gh` 未认证返回 `github-not-authenticated`。
- 仓库配置了 `github.account` 且当前 `gh` 活跃账户不同，返回 `github-account-mismatch`，避免多账户环境误同步。
- 只有 `ready` 对应 `syncGitHub=true`。

门禁不只依赖调用方自律：broker 的 GitHub 入口要求 `localRepoRoot`，并再次执行同一探测。认证结果在常驻进程中缓存 15 秒，GitHub API 只读结果默认缓存 30 秒；UI 的显式刷新绕过缓存，任何写操作清空相关读缓存。

## 同步模型

个人待办与 GitHub 数据是不同实体，不做隐式双写：

- 全局个人待办只存在用户应用数据；仓库个人待办只存在当前 worktree 的 tracked JSON。
- Project 项目保留 GitHub node ID、field ID、option ID；不能把显示名称当稳定主键。
- Issue/PR 以 `owner/repo#number` 展示，以 GraphQL node ID/REST URL 作为同步标识。
- 外部 mutation 先写 outbox。Project 字段更新、关闭 Issue 等天然幂等；创建 Issue 额外写入不可见 idempotency marker，用于崩溃后的查询去重。Project 字段和 DraftIssue 写入前比较加载时的 `updatedAt`，不一致则返回 409，禁止静默覆盖。
- Actions rerun/cancel 和 PR merge 可能产生不可逆或重复效果，默认拒绝，必须显式 `allowWrite=true`/`--yes`。

当前已用 `updatedAt` 做乐观冲突拦截；完整双向同步仍应保存 `base/local/remote` 三份值，按字段做三方比较：只有一侧变化时自动合并；两侧都变且值不同则生成冲突，禁止静默 last-write-wins。Project GraphQL 和 REST 列表均分页读取；broker 对只读请求短期缓存，写入后统一失效。有公网 GitHub App 时可用 webhook 降低延迟，但 webhook 只是唤醒同步，不能绕过同一合并器。

## Git 与 worktree

- pre-commit 自动验证并 stage `.localboard/todos.json`。
- pre-push 发现该文件仍 dirty 时中止，避免把旧版本推到远端。
- 可选 Git Hook 调用 PATH 中的 `localboard` CLI，并通过 `git rev-parse --git-path hooks` 支持普通仓库与 worktree。Codex 生命周期 Hook 与 Git Hook 是不同机制：前者负责路径/状态上报，后者只在用户自己的 commit/push 流程中校验仓库待办。
- 个人待办明确采用 **branch/worktree scoped**：每个 worktree 使用自己工作树中的 `.localboard/todos.json`，随所在分支提交和合并。仓库身份同时记录 `--git-common-dir`、`--git-dir`、remote 与 worktree path；UI 标出 linked worktree。跨分支合并冲突交给 Git 处理，LocalBoard 不在后台自动选择任一版本。

## 安全与可靠性

- 不保存 token，复用 `gh` 的凭据存储与权限模型。
- broker 只绑定 loopback，每次安装生成 256-bit 随机 bearer token。正式发行版还应在 Windows 对 endpoint 文件设置当前用户 ACL，在 Unix 强制 0600。
- repo 路径和 Hook 输入都视为不可信；子进程使用参数数组且 `shell=false`。Hook stdout 只输出合法空 JSON，不把 transcript 或 secret 注入模型上下文。
- SQLite 保存项目注册、账户绑定、收藏、审计事件、每会话仓库上下文、便签、outbox、缓存与幂等结果。应增加保留期、导出和清理策略，避免无限增长。
- GitHub API 需尊重 primary/secondary rate limits；重试应使用指数退避、抖动和 `Retry-After`，权限/验证错误不自动重试。
