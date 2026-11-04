# 公共 dsh-bridge 迁移与发布

运行链路已切换公共客户端，默认从 `~/.dsh-bridge/install.json` 加载；插件自身状态使用 `~/.codex/dsh-subagent`。两者均以 `os.homedir()` 为根，分别保留 `DSH_BRIDGE_STATE_DIR` 和 `CODEX_DSH_STATE_DIR` 覆盖入口，避免 MSIX 的 AppData 重定向隔离不同宿主。旧插件状态不自动迁移。回归只加载临时假客户端，不使用真实 DSH 或模型。

## 清理状态

用户已手动删除旧执行器源码；仓库无残留路径引用。旧 bundle、旧 worker profile 和旧状态目录已由迁移统筹方退役删除。

原有客户端、兼容性、运行时和 profile 测试已改为公共客户端边界测试，应保留。DSH 侧隔离假模型验收由公共桥接维护。

## 发布与安装

本插件 0.7.3 通过 [GitHub 标签 v0.7.3](https://github.com/RetMnit/dsh-subagent/tree/v0.7.3) 发布，依赖独立发布的公共 [dsh-bridge v0.4.0](https://github.com/RetMnit/dsh-bridge/tree/v0.4.0)（提交 `a1026e29f7203c3e908107b21e2ff8d2be437256`）。公共桥接安装步骤与插件标签安装、来源切换命令均见 [README](../README.md)。本地检出仅用于开发，不编辑插件缓存。

本机已完成 setup、源码清理和 Codex Desktop 实测；参数表、并行任务、续接、状态窗口与会话隔离均由用户确认正常。包、插件清单、MCP 和 supervisor 使用相同版本；验证记录见 [verification.md](verification.md)。新会话加载新 MCP 和 skill；本包 setup 只初始化自己的状态，不修改 DSH profile。

`dsh_doctor` 通过 `providers.<mode>.startupFailure` 透传公共客户端读取的启动失败原因；只读诊断不启动 Host。

DSH Desktop 需要完全退出并重新打开才能加载已经安装的公共 bundle。公共桥接独立维护，本插件的发布与安装不修改公共桥接源码，也不需要启动 DSH 任务。
