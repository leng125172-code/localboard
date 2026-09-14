# 产品范围与建议优先级

## P0：可放心使用

- GitHub Project V2：表格/看板、字段类型映射、草稿 Issue、过滤视图、手动冲突解决。
- Issues：创建、编辑、关闭/重开、评论、label、assignee、milestone、sub-issue、重复项原因。
- PR：review 状态、requested reviewers、checks、mergeability、关联 Issue；合并保持显式确认。
- Actions：workflow run/job/step、日志与 artifact 链接；写操作默认关闭。
- 离线 outbox：失败原因、重试、丢弃、人工确认，不允许无限重试。
- 统一收件箱：GitHub 通知、被指派项目、review request、失败 Actions、到期待办。
- 搜索与命令面板：跨仓库、Project、Issue、PR、个人待办全文检索和快速捕获。
- 提醒：due date、snooze、系统通知、勿扰时段；通知去重。
- 冲突中心与审计日志：展示谁、何时、从哪里修改，支持复制值和人工选择。

## P1：团队与多仓库

- GitHub.com / GHES、多账号和最小权限 profile。
- 多仓库 workspace、Git worktree 和 mono-repo 识别。
- GitHub App + 可选 webhook relay；纯本地环境继续支持轮询。
- 自定义 Project view、iteration、parent/sub-issue、issue type、dependencies/blockers。
- 托盘、全局快捷键、深链、开机启动、窗口布局恢复、多显示器/DPI。
- MCP server，使 Codex 以结构化 tool 调用替代 shell CLI；仍复用 broker 和权限门。
- Skill/Hook 安装器、版本检测、Hook trust 提示和兼容旧 Codex 的能力探测。

## P2：发行与治理

- 自动更新、代码签名、SBOM、依赖与供应链扫描、崩溃恢复。
- 数据备份/导出/导入、schema migration、损坏检测、隐私清理。
- 可访问性、键盘完整操作、主题/高对比度、国际化。
- 可选端到端加密的 private todo 模式；加密内容不自动进入共享 Git 历史。
- 性能预算：大 Project 分页、增量索引、虚拟列表、API cache 和 rate-limit 仪表。
- 可观测性默认本地；任何远程 telemetry 必须 opt-in 并可查看/删除。

## 需要明确的产品决策

1. 个人待办随 Git push 后对仓库读者可见，是否仍称“个人”？建议在 UI 命名为“仓库私人清单（Git 可见）”，另提供真正 user-only 加密清单。
2. Project item 的标题修改：DraftIssue 可直接改；Issue/PR 标题属于内容对象，需要相应仓库权限。UI 必须清楚标示影响范围。
3. Issue close 与 Project Status=Done 不是同一动作。默认交给 GitHub 内置 workflow，避免 LocalBoard 做第二次双写。
4. Actions rerun/cancel、PR merge、Issue close 均属于外部 mutation。Agent 自动化需要逐类授权，不应因“可以更新待办”而获得合并或重跑权限。
5. 公网 webhook 需要服务端组件；纯本地桌面不能假设可被 GitHub 回调。

