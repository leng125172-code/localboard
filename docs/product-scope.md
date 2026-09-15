# 产品范围

## 已实现

- Agent 上报路径驱动的项目注册；UI 浏览和测试运行不登记项目，已删除路径不再展示；非 Git、Git、本地 GitHub 三种能力门。
- Git worktree 独立识别，项目收藏、最近项目和右键移除。
- 全局待办是一级项目栏顶部的独立入口，不显示项目二级菜单；项目内只维护仓库待办。仓库待办只写 `.localboard/todos.json`，并保证不被 Git ignore。
- 项目列表严格使用 Codex 会话启动目录；命令执行期间进入的下级仓库或临时目录不能改变该会话所属项目。
- 只读 Git status/diff；没有 stage、commit、push 或隐式仓库初始化。
- GitHub Projects V2 自动发现、书签、字段编辑和 Draft Issue 标题编辑。
- Issue 创建、编辑、关闭；PR 详情、Review 和二次确认合并；Actions run/job/step、日志和二次确认重跑/取消。
- 多 Codex/Agent 会话状态、broker/连接指标、唯一四段式执行便签、可调分区、快捷待办、仓库待办 Tab、四边吸附收缩、托盘和开机启动。
- Fluent/WinUI 桌面壳、原生窗口控制覆盖层、系统明暗主题、Mica 降级、响应式项目名称栏和完整设置页。
- CLI、Codex Hook、用户 Skill、MCP server、ChatGPT/Codex 插件与 Windows NSIS 用户级安装包。
- SQLite WAL、单 broker 写入、幂等键、outbox、短期 GitHub 只读缓存和本地集成状态。

## 明确边界

- LocalBoard 不自动创建 Git/GitHub 仓库或 Project。
- 仓库待办依靠用户手动 commit/push 同步；全局待办永不进入 Git。
- 不保存 GitHub token，只调用已认证的 `gh`。仓库绑定账户与活跃账户不一致时拒绝 GitHub 请求。
- Project/Issue/PR/Actions 与个人待办是不同实体，不做隐式双写。
- PR 合并、Actions 重跑/取消必须由用户逐次确认；Agent 获得待办写权限不代表获得 GitHub 高风险写权限。
- 没有远程 LocalBoard telemetry。

## 后续增强

- Issue label、assignee、milestone、评论、sub-issue 的完整表单。
- PR checks、requested reviewers、关联 Issue 和 diff review 的完整交互。
- Actions artifact 下载和实时日志流。
- GitHub 通知统一收件箱、跨项目搜索、到期提醒和系统通知。
- 仓库待办跨分支冲突中心；Project 字段完整三方合并。
- GitHub Enterprise Server、多 host/profile、rate-limit 仪表。
- 自动更新、正式代码签名、SBOM、备份/导入导出、可访问性和国际化。
