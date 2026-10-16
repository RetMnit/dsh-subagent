# DSH Subagent

一个 Codex 插件，加一个 DSH 插件。支持 Desktop 新会话/续聊和后台 CLI、可复用配置、并行任务、自动状态窗口、结果与取消。

## 安装到新机器

需要 Windows、Node.js 22+、Git、Codex 和 DSH Desktop。当前仅适配 DSH `0.2.0-rc.2` 的已验证构建；版本或构建不匹配会停止派发。先在 DSH 中完成自己的模型登录和 preset 配置。

```powershell
git clone --branch v0.5.4 https://github.com/RetMnit/dsh-subagent.git
cd dsh-subagent
node server/setup.mjs --install-dsh
codex plugin marketplace add RetMnit/dsh-subagent --ref v0.5.4
codex plugin add dsh-subagent@dsh-subagent-tools
```

安装器从 PATH 中的 `dsh.cmd` 找到 DSH。如果未识别，可在运行 setup 前设置 `$env:DSH_INSTALL_DIR` 为实际 DSH 安装目录。

新机器默认工作区是用户目录下的 `DSH-Workspace`，会自动创建。想用其他目录，在 setup 前设置 `$env:CODEX_DSH_WORKSPACE`，例如 `C:\Agents\DSH`；已有安装再次运行 setup 会保留原工作区。新建任务默认完全权限，可在首次参数表中修改。

安装后完全退出并重新打开 DSH Desktop，使 DSH 端插件加载；再新开 Codex 会话，说“打开 DSH 子智能体参数配置，先不要执行任务”。安装、配置和检查不会发送模型任务。

仓库仅包含源码，不包含 API 密钥、模型账号、自定义 preset、会话或运行缓存。新机器使用自己的 DSH 配置，不要直接复制旧机器的 `config.json`、运行目录或浏览器 profile。

## 使用

每个 Codex 会话首次使用时，由 Codex 打开参数表，你配置并保存一次，首次只续接旧会话也一样。同一个 Codex 会话始终只有这一份配置，之后自动沿用最新保存值，无需重复确认；需要修改时再打开同一表单。不同 Codex 会话各自配置，不继承全局默认。

配置用于新建子智能体，同一份可同时创建多个独立 DSH 会话。续接直接指定目标 DSH session，保留它原来的模型、preset、工作区和权限，无需另外配置。

保存配置不授权执行。只有你明确允许使用 DSH，Codex 才会启动；明确要求多个 subagent 时，复用配置一次启动全部任务。

任务启动时，插件自动展示状态窗口；同一个窗口只显示当前 Codex 会话所属任务的运行状态、进度和结果。窗口使用系统 Microsoft Edge 的应用模式，无需安装新依赖。插件收到页面实际渲染回执后才派发；显示失败会明确报错。新任务不会自动切走 DSH Desktop 当前对话，需要时从看板手动打开。

预设留空时，新会话使用对应 DSH profile 的默认预设，续聊保留原预设，不维护额外枚举。后台 CLI 使用隐藏 Host 与独立会话库。DSH 自身可继续委派。

## 工具与生命周期

- `dsh_configuration({conversationId})`：读取本 Codex 会话的唯一配置；missing/draft 必须先保存，ready 直接复用。
- `dsh_configure({conversationId})`：首次创建表单，之后只打开这同一份配置，不接受额外配置或 session 绑定。
- `dsh_start` / `dsh_start_many`：自动使用本会话最新配置创建一个或多个独立 DSH 会话；每轮任务使用独立 requestId。
- `dsh_resume`：指定原运行方式 mode 和 sessionId，保留原 DSH 参数，保护目标会话的独占运行。
- `dsh_wait/status/result/cancel`：等待、查看和取消；`dsh_list` 查看当前 Codex 会话的任务；`dsh_open({dashboard:true})` 直接重开其状态窗口，不启动任务。

Codex 工具返回只保留一份 JSON：list 按 subagent 返回摘要及旧轮次 ID，启动和 status 返回必要状态，不重复携带历史、事件原文、工具清单或渲染回执列表。wait 在任务结束时返回完整答案；需要单独读取时用 result，答案不截断。状态窗口及磁盘记录保留完整信息，等待问题、错误、连接异常和批量失败仍会回传。

配置按稳定 conversationId 归属；每个 DSH session 是一个 subagent，每轮交互有独立 requestId/jobId。修改配置不改变已开始的任务，重试使用原快照。批量失败按任务列出，成功项不会因重试重复启动。旧版全局/续接配置备份并归档保留，不自动绑定到任何 Codex 会话；升级后首次使用需保存一份会话配置。

## 窗口与记录

对 Codex 说“打开这个会话的 DSH 状态窗口”，即可直接重开。关闭窗口不取消任务；重新进入同一个 Codex 聊天后用稳定会话 ID 恢复。每个 subagent 只有一张卡片，续接更新该卡片的状态、进度和结果，旧轮次收进可展开的交互记录。两个 subagent 交互两轮仍是两张卡片。不同 Codex 聊天各自筛选。

续接请求在准备阶段就归入原卡片，随后显示运行或等待状态，结束后更新结果；旧回复保留在交互记录中。保存配置时显示“保存中”和“配置已保存”，成功提示 3 秒后消失，编辑参数时立即清除；失败信息保留，方便修正。

已结束的交互记录保留 30 天，每个 Codex 会话最多 100 条，超出时先移除较旧轮次；这项限制针对底层记录，面板按 subagent 合并展示。运行中、准备中、等待用户或权限的任务不清理。服务启动、状态变化和运行期间每小时检查一次；服务关闭期间不执行清理。

清理仅涉及插件任务明细、结果缓存及其镜像，不删除 DSH 原始会话、参数配置、项目文件。清理后保留不含 prompt/结果的轻量去重标记，防止旧 requestId 被重新执行。旧版未记录归属的历史默认隐藏，不猜测所属聊天。

## 维护

状态窗口还需要系统 Microsoft Edge。GitHub 安装名为 `dsh-subagent@dsh-subagent-tools`。只维护 Git 仓库源码，不修改 Codex 插件缓存或 DSH 部署副本。使用约束由插件的 skill、工具说明和后端共同维护，不写入用户全局或项目 AGENTS.md。

```powershell
node server/setup.mjs --install-dsh
```

安装器将 DSH 插件放入 `~/.dsh/bundles/codex-dsh-bridge` 并备份 profile。运行记录在应用数据目录，不依赖项目工作区。更新时增加版本并刷新 Codex 安装；DSH 组件更新后在空闲时让 DSH 重载。当前适配 DSH `0.2.0-rc.2`，未知升级需验证后适配。

`npm test` 使用假模型验证配置复用、并发、任务隔离、重试和状态窗口链路。真实验收需要用户授权。已结束 Codex 回合的自动唤醒仍未实现。

测试使用临时目录、模拟 Host 和合成运行时，不依赖本机 DSH 安装或私人配置，不调用 DSH 模型。更新版本时发布新 Git 标签，再将新机器的 marketplace 固定到新标签。

交互记录会自动清理，整个运行目录没有总容量上限，也不监听 Codex 会话删除。日志、备份、配置及去重标记保留；`sessions`/`storages` 是后台 DSH 原始数据。需要释放空间时，关闭所有状态窗口后可删除 `%LOCALAPPDATA%\CodexDSHBridge\status-window-profile`，之后会自动重建；Edge 组件可能重新下载。不要手动零散删除运行 JSON 文件。
