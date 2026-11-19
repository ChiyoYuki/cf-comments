# AGENTS.md

`cf-comments`（公开仓库 `ChiyoYuki/cf-comments`）面向继任 Agent 的自动发现入口与仓库红线。

## 项目交接说明

以下两份交接文档由前任两位协作者分别从各自工作视角撰写，供继任者快速理解项目全貌（导航见 [docs/agent-handoff.md](docs/agent-handoff.md)）：

- [项目整体理解与交接说明（Antigravity）](docs/agent-handoff-a.md)
- [项目交接说明（Codex）](docs/agent-handoff-b.md)

## 仓库级通用约束

1. **零敏感信息入库**：追踪文件（代码、文档、测试）严禁写入真实邮箱、密钥、真实评论导出或本机绝对路径；本地私有配置仅放 gitignored 的 `cf-comments.config.json` 与 `.dev.vars.*`。
2. **提交与记录**：Git commit 标题和正文统一使用中文，并仅附当前执行者（Harness 及模型）自己的 `Co-authored-by`。本仓库不维护 `docs/agent-worklog/`，变更内容与验证结果直接写在 commit 中。
3. **生产安全**：严禁重建生产 D1 或覆盖线上留言；普通 push 不执行 D1 迁移，推送 `main` 前务必确认范围（在 `CF_DEPLOY_ENABLED=true` 时会自动发布 Worker）。
4. **必过本地校验**：提交前执行 `pnpm run lint`、`pnpm run typecheck`、`pnpm run test`、`pnpm run build`。
