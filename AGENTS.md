# DSH Subagent

- 本包只负责 Codex 的 MCP、配置、状态窗口与记录。安装前先读并安装公共 [dsh-bridge](https://github.com/RetMnit/dsh-bridge)（`node setup.mjs`），然后在本仓库运行 `npm.cmd run setup`；不再接受 `--install-dsh`。
- 插件运行文件放在 `plugins/dsh-subagent/`，marketplace 仅安装该目录，不能把 `.git` 打入缓存。MCP 和 supervisor 的 cwd 使用插件状态目录，资源路径按 import.meta.url / ROOT 定位；Windows 回归必须覆盖真实 MCP/supervisor 存活时刷新同版本缓存。
- 从 `~/.dsh-bridge/install.json` 的 root 加载公共 `lib/client.mjs`（可用 `DSH_BRIDGE_STATE_DIR` 覆盖状态目录），任务调用固定 `client: 'codex'`，配置快照标识放入 `meta`。Host 启动、协议与 DSH 兼容性校验均由公共客户端负责，不复制实现，不修改公共桥接。
- 仅在用户明确授权时执行。每个 Codex 会话首次配置保存一份参数，之后自动读取这唯一配置的新值；续接保留原 DSH 参数。配置保存不授予执行权限。
- 插件说明只放包内，不写入全局或项目 AGENTS.md。状态卡片按 DSH session 分组，job 是一轮交互。
- 按稳定 Codex 会话 ID 隔离任务与窗口；支持直接重开。已结束插件记录保留 30 天、每会话最多 100 条，不清理运行中任务、DSH 原会话、配置或项目文件。
- 插件状态只放 `~/.codex/dsh-subagent`（可用 `CODEX_DSH_STATE_DIR` 覆盖）；两个默认状态目录均以 `os.homedir()` 为根，避免 MSIX 应用的 AppData 重定向导致不同宿主各读各的状态。清理只操作自己的镜像、请求缓存和去重标记，不清理公共桥接任务、DSH 原会话或其他调用方数据。查询和监视使用 `start:false`，不得因状态窗口启动 Desktop，也不得关闭共用后台 Host。
- 不修改 DSH 安装包或 profile。更新自己的配置先备份，不中断用户任务。回归用假的 dsh-bridge 客户端，不调用模型、不碰真实 DSH。公共桥接的真实 Host 验收归公共仓库负责。
- 发布前审查待提交文件、更新版本和文档并运行 `npm.cmd test`；使用仓库配置的 Git 身份提交，确认远端无同名标签后创建 annotated tag，推送 `main` 与标签，再核对远端分支和标签解引用 SHA。既有标签不移动或删除，不 force push。
- 正式安装固定 GitHub 发布标签；本地 marketplace 仅用于开发测试，不手改插件缓存。切换来源先移除旧 marketplace，再按 README 登记来源和安装；迁移状态见 `docs/migration.md`。
