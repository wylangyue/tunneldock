# TunnelDock CLI

面向 Linux VPS 的 **OpenAI Secure MCP Tunnel + Chappie + Pi** 部署与运维工具。通过 systemd user service 长期运行 otunnel 和 Chappie，让 ChatGPT 使用服务器上的项目、文件和 shell。

## 当前版本与上游对齐

2026-09-30 对照上游发布版本更新；2026-10-03 增加本地运行时可靠性改进；2026-10-05 修复 MCP 工具路由和离线会话发现：

| 组件 | 默认版本 | 说明 |
| --- | --- | --- |
| TunnelDock | 0.4.1 | 增加初始化快照同步、旧绑定恢复和提交后的状态可见性 |
| Node.js | 26.10.0 | 已有 Node >= 26 时保留现有版本 |
| Pi coding agent | 0.99.2 | 已验证实际会话创建、历史恢复及空闲恢复 |
| Chappie | 1.1.0-tunneldock.6 | 基于官方 1.1.0，支持直接工具、项目会话和绑定一致性恢复 |
| otunnel | 0.2.0 | 使用官方 Linux GNU release，运行失败时本机编译 |
| pnpm | 12.4.1 | 仅在临时目录用于构建 Chappie |

依据：[Chappie v1.1.0](https://github.com/zetaloop/chappie/releases/tag/v1.1.0)、[配置文档](https://github.com/zetaloop/chappie/blob/v1.1.0/docs/setup.md)、[otunnel v0.2.0](https://github.com/zetaloop/otunnel/releases/tag/v0.2.0)。

支持 Linux x86_64 / aarch64；自动安装基础依赖面向 Ubuntu / Debian。当前真实集成测试运行于 Linux aarch64，x86_64 未进行实际部署验证。

## 架构

```text
ChatGPT → OpenAI Secure MCP Tunnel → otunnel → chappie（独立 MCP broker）
                                                   ├─ Pi session A ↔ ChatGPT A
                                                   ├─ Pi session B ↔ ChatGPT B
                                                   └─ Pi session C ↔ ChatGPT C
```

Chappie 1.x 使用独立的 `chappie` 命令，配置和 broker 状态位于 `~/.chappie`。不再使用 `pi --chappie` 启动 broker。Pi 只负责工作会话，Chappie 扩展通过本机 Unix socket 连接 broker。

默认 tunnel 连接由 VPS 主动出站建立，无需开放入站端口。健康探针限制在 loopback 地址，broker 默认不开启 TCP listener。

## 快速部署

```bash
git clone https://github.com/wylangyue/tunneldock.git
cd tunneldock
./install.sh
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
configure-chappie-tunnel --tunnel-id tunnel_xxxxxxxxx
tunneldock doctor
tunneldock diagnostics
tunneldock diagnostics --json
```

安装需要可用的 systemd user bus。请通过正常登录用户运行；非 root 用户安装 apt 依赖时需要 sudo。

配置命令会隐藏输入 Restricted API Key，不将 Key 写入命令行。使用已有凭据文件：

```bash
configure-chappie-tunnel \
  --tunnel-id tunnel_xxxxxxxxx \
  --api-key-file ~/.chappie/tunnelkey.txt \
  --health-addr 127.0.0.1:18080
```

密钥文件只通过 `file:` 引用写入 otunnel profile，权限设为 0600。相对密钥路径会转为绝对路径；诊断仅检查文件元数据，不读取或显示密钥内容。

默认 profile：`~/.config/tunnel-client/chappie.yaml`。支持 `XDG_CONFIG_HOME` 和 `TUNNEL_CLIENT_PROFILE_DIR`；生成的 unit 显式携带 profile 目录，避免交互 shell 与 systemd 使用不同的配置。

安装步骤：

1. 检查 Linux、systemd user bus 和版本参数，再准备基础工具、Python/PyYAML、Node、Pi。
2. 下载 otunnel 预编译包并实际执行版本检查。下载、解压或运行失败时，使用 Rust stable、本机编译器和 CMake 从锁定 tag 编译。
3. 拉取 Chappie v1.1.0，严格验证并应用补丁，按上游 frozen lockfile 安装构建依赖，执行 TypeScript 检查及 bundle 构建。
4. 将构建产物以 `1.1.0-tunneldock.6` 安装为全局 broker；Pi 注册同一安装目录的扩展。
5. 迁移旧配置、broker 状态和 MCP 启动命令，保留原始旧文件及会话 transcript。
6. 安装 systemd unit 和命令入口，尝试启用 linger。

构建 archive 保存在 `~/.local/share/tunneldock/`。首次构建会下载上游开发依赖，需要额外磁盘空间及网络；运行时无需 pnpm。只有 otunnel 源码回退需要 Rust/CMake。

尚未配置 tunnel 时，安装不会启动新服务。配置完成后自动启动。已有服务在安装/更新期间停止，完成后恢复；失败时也会尝试恢复，但依赖安装没有完整事务回滚，需要检查诊断结果。

## CLI

```bash
tunneldock install
configure-chappie-tunnel --help
tunneldock configure --help
tunneldock sessions-config --help
tunneldock start
tunneldock stop
tunneldock restart
tunneldock status
tunneldock doctor
tunneldock diagnostics
tunneldock diagnostics --json
tunneldock logs           # 最近 100 行
tunneldock logs 300
tunneldock logs -f
tunneldock sessions
tunneldock update
tunneldock version
```

`status` 显示组件版本及配置文件位置，不输出可能包含密码的 Chappie 配置。

`doctor` 检查可运行组件、会话与运行时补丁构建标识、会话配置、systemd user bus，以及 profile 实际引用的凭据文件。服务运行时还通过已有 broker 的 Unix socket 查询实时运行时诊断；托管会话启动未完成或本次 broker 运行中仍有失败记录时返回失败，成功重试同一会话会清除该会话的失败状态。退出码：0 表示检查通过；1 表示存在故障；2 表示组件检查通过但尚未配置 profile。

没有在线托管 Pi 时，诊断明确提示未核查在线 Pi 握手；不会为检查而创建会话或启动第二个 broker。此时退出码 0 仅表示其余组件、broker 和 tunnel 检查通过。

`diagnostics` 显示实时 broker、托管 Pi 的启动/在线/离线/失败状态，以及在线会话的执行状态和错误分类。`--json` 输出结构化实时快照；退出码 0 表示查询成功，具体健康状态需检查内容。broker 不可达时退出码为 1，普通输出会尝试显示 `~/.chappie/runtime.json` 历史快照，并明确标为非实时；JSON 模式不会用历史快照代替实时数据。

服务运行时，诊断调用现有健康探针并要求 control-plane poll 成功。服务停止且 profile/凭据检查通过时，才运行完整 `otunnel doctor`，避免启动第二个 broker 导致端口/socket 冲突。服务停止本身仍属于诊断失败。

## 独立会话与恢复

MCP 顶层注册 `read`、`bash`、`edit`、`write`，通过和 `call` 相同的 broker 路径执行，使用相同的 conversation metadata、默认绑定、显式目标、取消和会话恢复。`edit` 使用 `path` 和 `edits: [{oldText, newText}]`。其他原生工具或不同 agent 的参数格式仍通过 `tools` 获取定义，再用 `call`。原生工具目录与 MCP 顶层注册目录是两种目录，不能仅凭原生工具存在就假定 MCP 顶层可调用。

MCP `sessions` 同时列出在线会话和保存的离线托管会话，包含 `online`、`managed`、`bindingCount`、cwd 和名称。查询离线会话不会启动 Pi；使用 `init({sessionId})` 恢复所选目标。

多项目工作使用 cwd 选择，无需修改全局默认目录：

```json
{"cwd":"/srv/project-a","name":"main","createIfMissing":true}
```

上述参数传给 MCP `init`：cwd 必须是存在的绝对目录，符号链接按 realpath 归一化。先查找同目录、同名称的未归档托管会话；无匹配时仅在 `createIfMissing: true` 下创建，并发同项目创建共享同一个 ID。未指定名称时优先复用当前对话在该目录的绑定；否则多匹配返回 `ambiguous_project`，不猜测目标。显式 `sessionId` 配合 cwd/name 时必须匹配。项目查找失败不会回退到全局 cwd。项目名称是选择条件，不会把其他目录的同名会话合并。

MCP `sessions` 支持 `cwd`、精确 `name`、`status`、`online`、`managed`、`includeArchived` 过滤，以及 `limit`（1..200，默认 50）和 `offset` 分页；返回 `total` 与 `nextOffset`。托管元数据记录 `createdAt`、`lastUsedAt` 和 `archived`，旧状态文件仍可读取，历史时间未知时不补造时间。

`sessions` 返回 `bindingState`（`unbound`、`ready`、`offline`、`failed`、`archived` 或 `unavailable`）。同一对话正在初始化、join 或校验 managed handshake 时，查询等待这些步骤完成后取一致快照；查询等待可取消，共享启动继续运行。其他对话的查询不等待该初始化。没有初始化请求时首次查询可正常返回 `unbound`，且不会创建会话；MCP 的静态直接工具目录与当前对话是否已绑定是两个独立状态。

启用本地 Pi `autoCreate` 时，启动会检查缺少 managed/external metadata 的旧 UUID 绑定。在 Pi agent 的 `sessions` 目录中仅检查 session header：存在唯一有效 transcript 时重建 managed metadata；完整扫描确认目标不存在时移除该旧绑定；读取失败、超出扫描限制或存在重复 ID 时保留绑定，访问返回结构化错误。恢复记录保存原 transcript 路径，后续使用 `--session` 打开原文件并校验 ID/cwd；文件丢失或改变时不会用同一 ID 新建空会话。未绑定 managed session 保留。新建的非托管会话绑定保存 agent/cwd/name 到 `externalSessions`，不因缺少 managed metadata 被清理；离线外部目标要求原外部进程上线，不由 broker 接管。

会话状态变更在同一写入队列中构建下一份 bindings/managed/external 状态，写入临时文件并 fsync 后原子 rename；持久化成功后才同时发布内存状态，失败保留原绑定和 metadata。并发首次访问同一对话共享创建结果；归档与绑定的互斥条件也在提交事务中重新检查。

MCP `session_manage({sessionId, action})` 支持：`stop` 停止空闲进程但保留后续自动恢复能力；`unbind` 仅解绑当前对话；`archive` 停止并隐藏没有绑定的会话；`restore` 将归档恢复为可发现状态，随后用 `init` 上线。执行中、生成中、启动中或有在途请求的会话拒绝 stop/archive。有绑定的会话拒绝归档，其他对话的绑定不会被自动删除；任何操作都不删除 transcript。归档会话必须先 restore，不能通过执行工具绕过归档状态。

桥接错误保留 MCP `isError`，并在 `structuredContent.error` 中返回 `code`、`message`、`layer`、`execution`、`retryable`、`recovery`，以及可获得的 `sessionId`、`requestId`。`execution` 为 `not_started`、`completed` 或 `unknown`。协议和参数校验错误仍遵循 MCP SDK 的标准错误格式。异常的任意原始文本不被重新包装为对外诊断；未知错误提示查阅历史，避免泄露启动 stderr。

离线访问自动恢复原会话；工具派发前目标连接不可用时，broker 最多恢复并重试一次。已经派发的请求在超时、取消或断连后不自动重放。宿主未暴露直接工具时，需要调用端改走 `call`，服务端无法替宿主注册工具；外部 E2E 客户端实现工具目录 fallback，以及 SDK 明确报告工具未注册时的一次 fallback，不会把参数校验错误或结果未知的写入当成可重试操作。

上游默认会选择未绑定的在线会话；TunnelDock 为长期 VPS 使用保留以下语义：

- 新 ChatGPT 对话首次访问时创建独立的 managed Pi session，并保存 conversation ID → session ID。
- 同一对话重入、broker 重启或空闲回收后，按原 ID 恢复 Pi transcript。
- 同一对话的并发首次请求共享一次进程启动。
- 显式 `sessionId` 仍可切换或共享会话；执行工具的显式目标只影响该次操作，`init` 修改默认绑定。
- 默认空闲 30 分钟退出进程，保留历史和绑定；正在执行或生成的会话不会被空闲回收。
- 启动失败可按原绑定重试；调用取消会及时返回，正在共享的启动仍可完成。

托管 Pi 上线前必须完成运行时握手与工具目录核查：本次启动 nonce、session ID、规范化 cwd、`chappie/chatgpt` provider、扩展构建版本、协议 revision、Pi/Node 版本格式、必需能力，以及包含 `read` 的实际工具目录。Pi 报告运行版本，协议和能力负责兼容性判断；不要求另行登录模型服务商。启动及核查合计最长 30 秒，失败后回收进程，保留原绑定供重试。并发调用必须等待共享启动核查完成；nonce 不出现在对外会话信息或诊断中。手动连接的非托管会话保持原有接入语义。

Pi stderr 最多检查前 64 KiB，只输出 `module_not_found`、`extension_load_failed`、`syntax_error` 等固定分类，不输出或持久化原始文本、环境变量和 transcript。未知错误显示 `no_diagnostic`，不代表没有错误。诊断快照采用 0600 权限和原子替换，最多保存本次 broker 运行中最近 256 个托管会话状态；重启后重新建立实时状态。握手和诊断用于运行可靠性，不构成操作系统沙箱。

IPC 默认容量如下，消息大小按 UTF-8 字节计算：

| 范围 | 上限 | 超限行为 |
| --- | --- | --- |
| 单条 JSON 帧，不含换行 | 16 MiB | 入站关闭该连接；出站拒绝该发送 |
| 每条连接尚未完成的写入，含换行 | 32 MiB | 拒绝该发送 |
| 每条连接待处理帧与未完成帧的合计大小，不含换行 | 32 MiB | 关闭该连接 |
| 每条连接同时处理的帧 | 64 | 关闭该连接 |
| broker IPC 连接 | 64 | 拒绝新增连接 |
| broker 待完成请求 | 每个目标 peer 64，总计 256 | 拒绝新增请求 |
| 每个来源 peer 的转发请求、Session 发起的请求 | 64 | 拒绝新增请求 |
| 每个会话排队的 chat/call | 64 条且合计 16 MiB | 返回明确错误，保留已接收请求 |

IPC 消息处理保持可并行进入，避免一个正在等待回复的请求阻塞同一连接上的回复或取消。取消排队请求会释放队列容量。异常断连的托管会话标为失败并回收进程，下一次访问按原 ID 恢复。大文件分块传输仍遵循单帧限制，过大的内联图片或结果需要缩小或改用分块/资源引用。

默认配置位于 `~/.chappie/config.json`：

```json
{
  "autoCreate": {
    "cwd": "/home/<user>",
    "namePrefix": "chatgpt",
    "idleMinutes": 30
  }
}
```

修改策略：

```bash
tunneldock sessions-config --cwd /srv/projects --name-prefix chatgpt --idle-minutes 30
tunneldock sessions-config --idle-minutes 0
```

cwd 必须存在，idleMinutes 范围为 0..1440；0 禁用空闲回收。只修改传入选项，其余策略及其他 Chappie 配置保留。重复安装/更新也保留已有策略。策略修改后，正在运行的服务会重启。

需要让所有**未绑定的新对话**默认共享一个项目时，可以配置固定 UUID；已有对话绑定保留，执行工具的显式 `sessionId` 仍只影响本次调用。固定会话名称取 `namePrefix` 原值，Pi 内部 ID 必须为 UUID，例如：

```bash
tunneldock sessions-config --cwd /srv/project --name-prefix project-main --session-id 12345678-1234-4234-8234-123456789abc
tunneldock sessions-config --per-chat
```

固定 ID 若已属于其他 cwd，会拒绝访问，不覆盖原会话。多项目使用时，先通过 `sessions` 找到正确项目，再用 `init` 绑定它；不应把某个项目的固定会话配置成不相关工作的全局默认。`--per-chat` 恢复按新对话创建会话的策略，不删除已保存的绑定或历史。

`autoCreate` 仅用于本机 Pi，不能和面向远端 broker 的 `connect` 一起使用。Chappie 官方提供的其他 agent 和跨设备能力见[上游设置](https://github.com/zetaloop/chappie/blob/v1.1.0/docs/setup.md)；TunnelDock 自动部署范围为本机 Pi，会保留已有其他设置。

ChatGPT 分支若获得新的 conversation ID，则创建新的会话；不自动 fork 原 transcript。需要继续已有工作时显式选择原 session ID。

## 从 0.5.0 部署升级

在干净的 Git checkout 中执行：

```bash
cd ~/tunneldock
tunneldock update
```

更新先 `git pull --ff-only`，再执行新版本安装器，更新 Pi、otunnel、Chappie 和 unit；符合要求的现有 Node 保留。有未提交改动时停止更新，避免覆盖本地工作。

迁移映射：

| 旧位置/行为 | 新位置/行为 |
| --- | --- |
| `~/.pi/agent/chappie.json` | `~/.chappie/config.json` |
| `~/.pi/agent/chappie.state.json` | `~/.chappie/state.json` |
| `~/.pi/agent/sessions/` | 保持原位，按原 cwd 和 ID 恢复 |
| profile 中的 `pi --chappie` | `chappie` |

支持 `PI_CODING_AGENT_DIR` 自定义 Pi 目录，unit 和 managed 进程都使用该目录。迁移保留绑定、managedSessions、questions 和未交付结果，并转换旧结果的 chatId 字段。已有新配置优先；同一 ID 的绑定或 managed metadata 冲突时停止迁移。成功后记录 `~/.chappie/tunneldock-migration.json`，后续不会重复导入旧状态。

旧 JSON 文件保持原位；改写 profile 前保存 `.yaml.pre-1.1.0` 备份。迁移保留其他 MCP channel、健康地址及 profile 设置。

不要直接安装官方 Chappie 覆盖本地 broker。Pi 注册的是本地扩展目录，`pi update` 不会更新该本地扩展；升级请使用 TunnelDock。旧的 0.5.0 patch 仅保留作历史参考，安装器只支持已验证的 1.1.0 patch。

## systemd 与常见故障

unit 默认位于 `~/.config/systemd/user/chappie-tunnel.service`，支持 `XDG_CONFIG_HOME`。参考文件：`systemd/chappie-tunnel.service.example`。

unit 明确设置用户级 PATH、Pi agent 目录及 profile 目录，不依赖 `.bashrc`。使用 `UMask=0077`，失败后自动重启，并留出退出时间以回收 managed Pi。

```bash
systemctl --user status chappie-tunnel.service
loginctl show-user "$(id -un)" -p Linger
sudo loginctl enable-linger "$(id -un)"
```

linger 未开启时，SSH 注销后服务可能停止。安装器无法自动开启时会给出提示。

旧 GLIBC VPS 若不能运行 GNU release：

```bash
TUNNELDOCK_FORCE_OTUNNEL_SOURCE=1 ./install.sh
```

强制选项即使已有可用 otunnel 也会编译。上游 v0.2.0 发布 Linux GNU artifact，未提供 musl/static Linux artifact；本机编译使用目标系统的链接环境。

健康端口冲突时更换 loopback 端口：

```bash
configure-chappie-tunnel --tunnel-id tunnel_xxxxxxxxx --health-addr 127.0.0.1:18081
```

固定包安装及 frozen-lockfile 构建临时绕过 release-age 限制，不改写用户持久供应链策略。Chappie 源码升级需要重新移植补丁，不能只修改版本环境变量。

## 验证

本地回归检查：

```bash
bash -n bin/tunneldock bin/configure-chappie-tunnel install.sh
shellcheck bin/tunneldock bin/configure-chappie-tunnel install.sh
python3 -m unittest discover -s tests -v
git diff --check
```

对 Chappie v1.1.0 应用新 patch 并按其 frozen lockfile 准备依赖后，可运行 broker 回归：

```bash
CHAPPIE_SOURCE_DIR=/path/to/patched/chappie node --test tests/chappie.test.mjs tests/chappie-ipc.test.mjs
```

增加真实 Pi 集成测试时，设置 `CHAPPIE_PI_BIN` 为隔离安装的 Pi 可执行文件路径、`CHAPPIE_PACKAGE_DIR` 为该隔离环境里安装的 Chappie 打包产物目录，`CHAPPIE_PI_VERSION` 为期望运行的版本。不要直接用含有 Pi 开发依赖的 Chappie 源码目录充当扩展包，避免诊断错误引用开发依赖版本。分别使用 Pi 0.99.1/0.99.2 和同一 Chappie archive 可进行 A/B；真实测试验证 MCP 工具注册、四个直接工具、通用 call、工具定义、错误返回、显式目标、chat/history、文件导入导出及资源读取、空闲恢复、离线发现和 broker 重启恢复。其余回归涵盖独立对话、并发、固定项目共享、失败重试、取消、忙碌保护、握手不匹配、30 秒启动超时、诊断脱敏、IPC 预算及队列超限后的取消。源码 checkout 与构建包的 `package.json` 版本必须一致。设置 `CHAPPIE_CLI_BIN` 为构建包的 `chappie` 可执行文件路径，可额外验证打包后的诊断命令。启动超时测试需要约 30 秒。

推荐使用独立 E2E runner，它自行获取上游、应用当前补丁、检查 TypeScript、构建 archive，并为两个 Pi 版本分别建立本地安装与私有 HOME/agent/tmp/npm 配置：

```bash
node tests/run-e2e.mjs
node tests/run-e2e.mjs --pi-version 0.99.2 --temp-dir /path/to/test-disk
```

需要 Node >= 26、npm、git 和网络，不需要生产凭据。所有安装都在唯一临时目录，不执行全局安装、systemctl 或生产 broker 的停止操作。测试结束回收自己的进程和目录；可用 `--source DIR --package DIR --pi-bin FILE --pi-version VERSION` 复用隔离构建。`tests/mcp-client.mjs` 从 Pi 外部控制打包后的 stdio MCP，具有请求截止时间、取消和断连清理；测试覆盖 cwd 并发创建、歧义/错误目录、过滤分页、归档/恢复和实际 shell 写入后断连不重复执行。宿主工具目录与真实 tunnel 的验收仍需在实际 ChatGPT 连接中进行，不把隔离 stdio 测试当作宿主验收。

部署后人工验证：新建 ChatGPT 对话 A/B，确认两个 session ID 不同；返回 A 确认恢复原 ID；执行 `tunneldock sessions` 查看绑定。真实 OpenAI control plane、Restricted API Key 和 ChatGPT 宿主对话行为需在实际部署中验证。

2026-10-05 验证记录：20 项配置测试、26 项 broker/IPC 回归通过；Pi 0.99.1 和 0.99.2 分别通过真实 MCP 工具/文件/历史/恢复测试和打包后的 stdio MCP 测试。TypeScript、Biome、ShellCheck、shell 语法及 diff 检查通过。安装器从干净上游应用补丁后重建的 archive，与已测试 archive 的 30 个文件逐字节一致。生产环境已部署 Chappie `1.1.0-tunneldock.4`，Pi 保持 `0.99.2`；原有 25 个绑定、22 个托管会话保留，doctor 的服务、broker、健康探针及 control-plane 轮询检查通过。这些检查尚不代替 ChatGPT 宿主端实际工具发现和调用的验收。

同日 `0.4.0` / Chappie `1.1.0-tunneldock.5` 验证记录：外部 runner 从干净上游应用补丁并构建同一 archive，Pi `0.99.1`、`0.99.2` 各通过 39 项测试，零失败、零跳过；20 项配置测试、TypeScript、Biome、ShellCheck、shell 语法及 diff 检查通过。覆盖新增项目 API、结构化错误、生命周期管理和副作用后断连不重放。代码提交为 `44df88e`，版本标签为 `v0.4.0`。

2026-10-05 09:43（Asia/Shanghai）生产已部署 `.5`，Pi 保持 `0.99.2`。待部署 archive 在隔离环境额外通过 3 项真实 Pi 测试：打包后的 stdio MCP、工具/历史/空闲与重启恢复，以及实际 shell 副作用后断连不重放；生产安装的 30 个文件与该 archive 逐字节一致。重启后 broker 返回 `.5`，原有 25 个绑定、22 个托管会话及其 cwd/名称/归档状态均保留。doctor 的服务、broker、健康探针及 control-plane 轮询检查通过。部署时没有 managed Pi 在线，因此本次生产检查没有验证现场 Pi handshake；隔离测试不代替真实 ChatGPT 宿主端工具发现与调用的验收。

同日 `.6` / `0.4.1` 验证记录：干净上游重建后，Pi `0.99.1`、`0.99.2` 各通过 44 项测试，零失败、零跳过；20 项配置测试、TypeScript、Biome、ShellCheck、shell 语法和 diff 检查通过。新增覆盖初始化快照并发/取消、失败写入的状态回退、旧 transcript 重建 metadata 后保持 ID 和历史、缺失目标清理，以及歧义/损坏扫描时保留绑定。用户对 `.5` 的现场复核确认 `/home/reyin` 下 write/read/edit/bash/文件导出执行链正常；`.6` 的改动针对剩余的会话一致性问题。

## 文件布局与许可

核心文件：`bin/tunneldock`、`bin/configure-chappie-tunnel`、`libexec/tunneldock-config.py`、`patches/`、`systemd/`、`tests/`、`install.sh`。不包含桌面 UI 或桌面运行时。

上游：[otunnel](https://github.com/zetaloop/otunnel)、[Chappie](https://github.com/zetaloop/chappie)、[Pi](https://github.com/earendil-works/pi)。TunnelDock 是独立的部署与运维集成工具。

TunnelDock CLI 使用 **GNU GPL-3.0**。Chappie 补丁对应的上游代码采用 MIT License，副本见 `patches/CHAPPIE-LICENSE`。
