# DSH Subagent

Codex 的 DSH 子智能体插件：每会话参数表、并行任务、状态窗口、结果与取消。DSH 执行依赖公共 [dsh-bridge](https://github.com/RetMnit/dsh-bridge)，本插件通过安装回执加载其 Node 客户端，调用方固定为 `codex`。

## 安装

需要 Windows、Node.js 22+、Git、Codex、Microsoft Edge，以及公共 dsh-bridge 支持的 DSH Desktop。先在 DSH 中完成自己的模型登录和 preset 配置。

先安装公共桥接 v0.4.0：

```powershell
git clone --branch v0.4.0 --depth 1 https://github.com/RetMnit/dsh-bridge.git
cd dsh-bridge
node setup.mjs
```

保留该检出目录，安装回执会指向它。完全退出并重新打开 DSH Desktop，使公共 bundle 加载。公共桥接负责 DSH 安装发现、worker profile、启动锁、协议和兼容性规则。本插件不部署 DSH bundle 或修改 profile。

然后从 GitHub 标签安装本插件，并运行安装副本中的 setup：

```powershell
codex plugin marketplace add https://github.com/RetMnit/dsh-subagent.git --ref v0.7.4
codex plugin add dsh-subagent@dsh-subagent-tools
node "$HOME/.codex/plugins/cache/dsh-subagent-tools/dsh-subagent/0.7.4/server/setup.mjs"
```

最后一条使用默认 Codex 缓存位置；如自定义了 Codex 用户目录，使用安装命令返回的插件路径。命令中的 codex 需在 PATH 上，也可以使用 Codex Desktop 自带 codex.exe 的完整路径。

本包 setup 只通过公共客户端检查运行时并初始化 Codex 配置，不启动 Host、不发送模型请求。默认工作区和权限来自公共客户端；首次可设置 `CODEX_DSH_WORKSPACE` 指定 Codex 的工作区，之后保留已保存值。再次运行会先备份自己的 config.json，保留 token 和默认值。

插件自身状态位于 `~/.codex/dsh-subagent`（可用 `CODEX_DSH_STATE_DIR` 覆盖），不迁移旧配置或任务。插件与公共桥接的默认状态目录均基于 `os.homedir()`，使桌面应用、终端 CLI 和其他应用启动的进程使用同一用户目录，避开 MSIX 的 AppData 重定向。每个新 Codex 会话首次使用仍需保存一份参数表。安装后新开 Codex 会话，说“打开 DSH 子智能体参数配置，先不要执行任务”。

## 升级或从本地检出切回 GitHub

已登记本地检出或其他 ref 时，先移除旧 marketplace，再登记发布标签并安装，保留插件身份：

```powershell
codex plugin marketplace remove dsh-subagent-tools
codex plugin marketplace add https://github.com/RetMnit/dsh-subagent.git --ref v0.7.4
codex plugin add dsh-subagent@dsh-subagent-tools
```

发布使用 annotated tag，已发布标签不移动。后续版本替换上述 ref；默认值变化时再运行新安装副本中的 setup。公共客户端迁移与验证见 [迁移状态](docs/migration.md)。

## 本地开发

仅开发时从本地检出安装，在仓库根目录执行：

```powershell
npm.cmd run setup
codex plugin marketplace remove dsh-subagent-tools
codex plugin marketplace add .
codex plugin add dsh-subagent@dsh-subagent-tools
```

尚未登记 marketplace 时跳过 remove。本地源码更新后递增插件版本并重新安装；不手改插件缓存。

插件包位于 `plugins/dsh-subagent/`，marketplace 仅复制该目录，安装缓存不包含仓库 `.git`、测试或文档。缓存内的 setup 路径仍是 `server/setup.mjs`。MCP 与后台 supervisor 启动后使用插件状态目录作为 cwd，资源始终按脚本位置定位，避免 Windows 上运行进程占用缓存目录而阻挡刷新。

从 0.7.3 或更早版本升级时，旧 MCP/supervisor 可能仍把旧缓存作为 cwd。若首次切换报“failed to back up plugin cache entry”，先保存工作并正常完全退出一次 Codex Desktop，再重试安装；不要强制结束用户任务。新版进程不再占用缓存 cwd。

## 公共执行边界

- 从 `~/.dsh-bridge/install.json` 的 root 加载 `lib/client.mjs` 并调用 `connect()`；公共状态路径可用 `DSH_BRIDGE_STATE_DIR` 覆盖。
- 任务方法传 `client: 'codex'`；配置 ID、revision 和 Codex conversationId 放入 `meta`，不作为任务顶层参数。
- 执行或读取目录/会话时允许公共客户端按需启动 Host。状态监听、任务状态与取消、只读诊断均不拉起 Host；本插件不关闭共用后台 Host。
- DSH 兼容性、运行时发现和协议检查委托公共客户端，异常原样报告，不复制版本或指纹策略。
- `dsh_doctor` 完整保留公共客户端的各模式诊断；离线模式的启动失败原因在 `providers.<mode>.startupFailure` 中返回，不启动 Host。
- 公共任务明细和后台 sessions/storages 位于 `~/.dsh-bridge`，由公共桥接管理。Codex 的 30 天/100 条策略只清理自己的记录；公共副本的保留期可能不同。

仓库不包含 API 密钥、模型账号、自定义 preset、会话或运行缓存。新机器使用自己的 DSH 配置。

## 使用

每个 Codex 会话首次使用时，由 Codex 打开参数表，你配置并保存一次，首次只续接旧会话也一样。同一个 Codex 会话始终只有这一份配置，之后自动沿用最新保存值，无需重复确认；需要修改时再打开同一表单。不同 Codex 会话各自配置，不继承全局默认。

配置用于新建子智能体，同一份可同时创建多个独立 DSH 会话。续接直接指定目标 DSH session，保留它原来的模型、preset、工作区和权限，无需另外配置。

保存配置不授权执行。只有你明确允许使用 DSH，Codex 才会启动；明确要求多个 subagent 时，复用配置一次启动全部任务。

任务启动时，插件自动展示状态窗口；同一个窗口只显示当前 Codex 会话所属任务的运行状态、进度和结果。窗口使用系统 Microsoft Edge 的应用模式，无需安装新依赖。任务派发与窗口心跳解耦，后台或最小化不会阻塞任务；显示异常单独报告，不改变任务结果。新任务不会自动切走 DSH Desktop 当前对话，需要时从看板手动打开。

预设留空时，新会话使用对应 DSH profile 的默认预设，续聊保留原预设，不维护额外枚举。后台 CLI 使用隐藏 Host 与独立会话库。DSH 自身可继续委派。

新版 DSH 中，新会话输入区的预设切换只影响当前会话。长期默认值在 **设置 → Agent 预设 → 设为新任务默认** 中保存；插件的“沿用 DSH”读取这个默认值，不会把最近一次会话选择自动设为全局默认。

## 工具与生命周期

- `dsh_configuration({conversationId})`：读取本 Codex 会话的唯一配置；missing/draft 必须先保存，ready 直接复用。
- `dsh_configure({conversationId})`：首次创建表单，之后只打开这同一份配置，不接受额外配置或 session 绑定。
- `dsh_start` / `dsh_start_many`：自动使用本会话最新配置创建一个或多个独立 DSH 会话；每轮任务使用独立 requestId。
- `dsh_resume`：指定原运行方式 mode 和 sessionId，保留原 DSH 参数，保护目标会话的独占运行。
- `dsh_wait/status/result/cancel`：等待、查看和取消；`dsh_list` 查看当前 Codex 会话的任务；`dsh_open({dashboard:true})` 直接重开其状态窗口，不启动任务。

Codex 工具返回只保留一份 JSON：list 按 subagent 返回摘要及旧轮次 ID，启动和 status 返回必要状态，不重复携带历史、事件原文、工具清单或渲染回执列表。wait 在任务结束时返回完整答案；需要单独读取时用 result，答案不截断。状态窗口及磁盘记录保留完整信息，等待问题、错误、连接异常和批量失败仍会回传。

配置按稳定 conversationId 归属；每个 DSH session 是一个 subagent，每轮交互有独立 requestId/jobId。修改配置不改变已开始的任务，重试使用原快照。批量失败按任务列出，成功项不会因重试重复启动。旧状态不自动绑定到任何 Codex 会话；首次使用需保存一份会话配置。

## 窗口与记录

对 Codex 说“打开这个会话的 DSH 状态窗口”，即可直接重开。关闭窗口不取消任务；重新进入同一个 Codex 聊天后用稳定会话 ID 恢复。每个 subagent 只有一张卡片，续接更新该卡片的状态、进度和结果，旧轮次收进可展开的交互记录。两个 subagent 交互两轮仍是两张卡片。不同 Codex 聊天各自筛选。

续接请求在准备阶段就归入原卡片，随后显示运行或等待状态，结束后更新结果；旧回复保留在交互记录中。保存配置时显示“保存中”和“配置已保存”，成功提示 3 秒后消失，编辑参数时立即清除；失败信息保留，方便修正。

同一 Codex 聊天复用一个独立状态窗口。心跳超期时先检查现有 Edge 窗口所属的会话和专用 profile，不能仅因页面失联就再开一个；服务重启后也会接管已存在的窗口。确认窗口仍在即继续派发，不等待后台页面恢复心跳。页面通过事件流接收更新，重新显示时立即请求最新状态；旧事件不能回滚新状态。显示回执未到时 `jobsRendered:false,renderPending:true`，不冒充已显示，也不要求用户恢复或关闭窗口才能执行任务。找不到 Edge、无法确认窗口归属或旧服务地址不可达时，显示标为 unavailable 并保留原因，任务仍可执行；不会因此猜测并新开重复窗口。各会话使用独立浏览器 profile，避免普通浏览器窗口干扰归属判断。

配置与窗口生命周期由 Codex 端插件负责；DSH 子任务提示词只需写实际工作，不需要反复附带配置表或开窗提醒。

已结束的交互记录保留 30 天，每个 Codex 会话最多 100 条，超出时先移除较旧轮次；这项限制针对底层记录，面板按 subagent 合并展示。运行中、准备中、等待用户或权限的任务不清理。服务启动、状态变化和运行期间每小时检查一次；服务关闭期间不执行清理。

清理仅涉及插件任务明细、结果缓存及其镜像，不删除 DSH 原始会话、参数配置、项目文件。清理后保留不含 prompt/结果的轻量去重标记，防止旧 requestId 被重新执行。旧版未记录归属的历史默认隐藏，不猜测所属聊天。

## 维护与验证

只维护本仓库源码，MCP 与 skill 规则保留在插件内。普通回归：

```powershell
node --test tests/*.test.mjs
```

测试安装临时的假 dsh-bridge 客户端，验证配置复用、并发、重试、参数边界、跨聊天隔离、记录清理、MCP 和窗口链路；不调用真实模型，不读取真实 DSH 安装或私人配置。公共桥接的真实 Host 假模型验收在其仓库运行，本包不再维护或运行 DSH 侧验收。

Windows 缓存回归使用独立临时 CODEX_HOME 和本地 marketplace，启动安装副本的真实 MCP 与假公共客户端支持的 supervisor，并在二者存活时刷新同版本缓存。运行前设置 `CODEX_TEST_CLI` 为 `codex.exe` 的绝对路径；未提供时该项显式跳过。

Windows 页面冻结的可选验证是 `node tests/panel-background-live.mjs [output.json]`：使用临时 Edge profile 和假公共客户端，验证冻结页面时的派发、续接、并行、去重、服务重启接管和前台补齐。正式窗口不开放调试端口。本次迁移未运行此可选验证。

自身状态可用 `CODEX_DSH_STATE_DIR` 覆盖。默认目录包含 config.json、configurations.json、dispatch-requests.json、job-owners.json、pruned-jobs.json、supervisor-jobs.json、窗口 profile 和 logs/；不再保存 DSH runtime、管道配置、worker profile 或 DSH 原始会话。关闭所有本插件状态窗口后，可按需清理自身 status-window-profile；不要零散删除运行 JSON。已结束 Codex 回合的自动唤醒仍未实现。
