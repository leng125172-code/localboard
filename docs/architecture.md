# 架构与同步约束

## 进程模型

```text
Codex hooks ─┐
Agents/Skill ├── localboard CLI ─┐
Git hooks ───┘                    │
Desktop UI ──────────────────────┼── 127.0.0.1 broker（每用户单实例）
Sticky windows ──────────────────┘       ├── tracked todo JSON（每仓库）
                                        ├── SQLite WAL（每用户）
                                        └── gh CLI ── GitHub API
```

- Desktop 用 Electron 的 `requestSingleInstanceLock` 防止重复主窗口；第二次启动只聚焦已有窗口。
- broker 用原子目录锁保证每个 OS 用户只有一个 owner。PID 存活检查、5 秒创建宽限期和健康检查共同处理并发启动、崩溃残锁与 PID 复用。
- UI 和 broker 解耦。关闭 UI 不终止后台服务；多个 Codex 进程只做客户端。
- 每仓库 JSON 写入使用锁目录、临时文件和原子 rename。broker 再增加进程内串行队列。

## 同步模型

个人待办与 GitHub 数据是不同实体，不做隐式双写：

- `source.kind=personal` 只能存在 tracked JSON。
- Project 项目保留 GitHub node ID、field ID、option ID；不能把显示名称当稳定主键。
- Issue/PR 以 `owner/repo#number` 展示，以 GraphQL node ID/REST URL 作为同步标识。
- 外部 mutation 先写 outbox。Project 字段更新、关闭 Issue 等天然幂等；创建 Issue 额外写入不可见 idempotency marker，用于崩溃后的查询去重。
- Actions rerun/cancel 和 PR merge 可能产生不可逆或重复效果，默认拒绝，必须显式 `allowWrite=true`/`--yes`。

完整双向同步应保存 `base/local/remote` 三份值，按字段做三方比较：只有一侧变化时自动合并；两侧都变且值不同则生成冲突，禁止静默 last-write-wins。远端轮询使用 cursor/updatedAt；有公网 GitHub App 时可用 `projects_v2_item`、`issues`、`pull_request`、`workflow_run` webhook 降低延迟，但 webhook 只是唤醒同步，不能绕过同一合并器。

## Git 与 worktree

- pre-commit 自动验证并 stage `.localboard/todos.json`。
- pre-push 发现该文件仍 dirty 时中止，避免把旧版本推到远端。
- 安装 Hook 时若已存在同名 Hook，当前实现拒绝覆盖；后续使用 hook dispatcher 兼容 Husky、Lefthook 等工具。
- 多 worktree 不能只用绝对路径识别同一仓库。下一阶段以 `git rev-parse --git-common-dir`、remote identity、worktree path 组成身份，并把待办合并冲突显示给用户。

## 安全与可靠性

- 不保存 token，复用 `gh` 的凭据存储与权限模型。
- broker 只绑定 loopback，每次安装生成 256-bit 随机 bearer token。正式发行版还应在 Windows 对 endpoint 文件设置当前用户 ACL，在 Unix 强制 0600。
- repo 路径和 Hook 输入都视为不可信；子进程使用参数数组且 `shell=false`。Hook stdout 只输出合法空 JSON，不把 transcript 或 secret 注入模型上下文。
- SQLite 保存审计事件、outbox、缓存与幂等结果。应增加保留期、导出和清理策略，避免无限增长。
- GitHub API 需尊重 primary/secondary rate limits；重试应使用指数退避、抖动和 `Retry-After`，权限/验证错误不自动重试。

