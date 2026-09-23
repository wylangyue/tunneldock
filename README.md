# TunnelDock CLI

面向 Linux VPS / 服务器的 **OpenAI Secure MCP Tunnel + Chappie + Pi** 部署与运维 CLI。

这个仓库是 TunnelDock 的服务器版：**不包含 Tauri、React、桌面 UI、托盘、窗口或桌面打包代码**。目标是在长期在线的 Ubuntu/Debian VPS 上，用 systemd user service 持续运行 otunnel → pi --chappie，让 ChatGPT 稳定访问 VPS 上的项目、文件和 shell。

当前已验证并锁定：

- Node.js 26.10.0
- Pi coding agent 0.87.1
- Chappie 0.5.0 + TunnelDock chat-scoped session patch
- otunnel 0.1.4
- Linux x86_64 / aarch64
- systemd

默认面向 Ubuntu / Debian。其他 Linux 发行版可以使用 CLI，但基础依赖需要自行准备。

---

## 架构

~~~text
ChatGPT
   |
OpenAI Secure MCP Tunnel
   |
otunnel
   |
pi --chappie          <- MCP broker
   |
+------------------------------+
| Pi session A  <- ChatGPT A   |
| Pi session B  <- ChatGPT B   |
| Pi session C  <- ChatGPT C   |
+------------------------------+
   |
Linux VPS filesystem / shell / projects
~~~

所有网络连接由 VPS 主动通过 HTTPS 出站建立，不需要公开 MCP HTTP 服务，也不需要额外开放入站端口。

---

## 最重要的会话改造

官方 Chappie 0.5.0 默认会让一个没有绑定的 ChatGPT 对话选择某个未绑定的在线 Pi session。长期 VPS 使用时，这容易让不同 ChatGPT 对话复用 Pi 上下文，导致 transcript 持续膨胀并增加串任务风险。

TunnelDock 安装 Chappie 0.5.0 后会自动应用：

~~~text
patches/chappie-0.5.0-chat-scoped-sessions.patch
~~~

改造后的默认语义：

~~~text
ChatGPT 对话 A <-> Pi session A
ChatGPT 对话 B <-> Pi session B
ChatGPT 对话 C <-> Pi session C
~~~

行为规则：

1. 新的 ChatGPT 对话第一次调用 Chappie时，自动创建新的 Pi session，并持久保存 conversation ID → session ID 绑定。
2. 当前 ChatGPT 对话继续交流时，自动使用原 Pi session。
3. 以后重新打开旧 ChatGPT 对话时，恢复原 session ID 和 Pi transcript。
4. managed Pi 进程默认空闲 30 分钟后退出，但 session 文件、binding 和历史不会删除；下次访问时按原 ID 自动拉起。
5. 仍支持显式 sessionId，因此需要时可以有意共享或切换 session。

持久化位置：

~~~text
~/.pi/agent/chappie.state.json
~/.pi/agent/sessions/
~~~

所以 100 个历史 ChatGPT 对话并不意味着 100 个常驻 Pi 进程。

---

# 快速部署

## 1. Clone

~~~bash
git clone https://github.com/wylangyue/tunneldock.git
cd tunneldock
~~~

## 2. 安装

~~~bash
./install.sh
~~~

安装过程会：

- 安装/检查 Linux 基础工具；
- 安装 Node.js 26 到用户目录；
- 配置用户级 npm prefix；
- 安装 Pi；
- 下载 otunnel 官方 Linux 预编译二进制；
- 安装官方 Chappie 0.5.0；
- 应用 chat-scoped session patch；
- 写入 Chappie autoCreate 配置；
- 安装 systemd user service；
- 尝试启用 systemd user linger；
- 创建 ~/.local/bin/tunneldock。

不需要安装 Rust，也没有桌面运行时依赖。

安装后如当前 shell 尚未刷新 PATH：

~~~bash
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
~~~

## 3. 配置 Tunnel

推荐交互式输入 API Key，避免 Key 出现在 shell history：

~~~bash
tunneldock configure --tunnel-id tunnel_xxxxxxxxx
~~~

终端会安全提示：

~~~text
OpenAI Restricted API Key:
~~~

也可以使用已有 Key 文件：

~~~bash
tunneldock configure \
  --tunnel-id tunnel_xxxxxxxxx \
  --api-key-file ~/.chappie/tunnelkey.txt
~~~

默认健康探针：

~~~text
127.0.0.1:18080
~~~

需要时可换端口：

~~~bash
tunneldock configure \
  --tunnel-id tunnel_xxxxxxxxx \
  --health-addr 127.0.0.1:18081
~~~

配置完成后 service 会自动启动。

---

# CLI 命令

~~~bash
tunneldock install
tunneldock configure
tunneldock sessions-config
tunneldock start
tunneldock stop
tunneldock restart
tunneldock status
tunneldock doctor
tunneldock logs
tunneldock logs -f
tunneldock sessions
tunneldock update
tunneldock version
~~~

查看状态：

~~~bash
tunneldock status
~~~

完整诊断：

~~~bash
tunneldock doctor
~~~

日志：

~~~bash
tunneldock logs
tunneldock logs 300
tunneldock logs -f
~~~

查看持久化 ChatGPT/Pi session：

~~~bash
tunneldock sessions
~~~

示例：

~~~text
ChatGPT bindings: 12
Managed Pi sessions: 12

SESSION ID                            BINDINGS  NAME                 CWD
xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx        1  chatgpt-xxxxxxxx     /home/user
~~~

---

# 调整 ChatGPT ↔ Pi session 策略

默认配置：

~~~json
{
  "autoCreate": {
    "cwd": "/home/<user>",
    "namePrefix": "chatgpt",
    "idleMinutes": 30
  }
}
~~~

修改：

~~~bash
tunneldock sessions-config \
  --cwd /srv/projects \
  --name-prefix chatgpt \
  --idle-minutes 30
~~~

如果希望 managed Pi session 不因空闲退出：

~~~bash
tunneldock sessions-config --idle-minutes 0
~~~

长期 VPS 一般建议保留默认空闲回收，让历史 session 留在磁盘，需要时再启动进程。

---

# systemd

service 位置：

~~~text
~/.config/systemd/user/chappie-tunnel.service
~~~

核心命令：

~~~text
otunnel run --profile chappie
~~~

MCP target：

~~~text
pi --chappie
~~~

查看：

~~~bash
systemctl --user status chappie-tunnel.service
~~~

仓库提供参考 unit：

~~~text
systemd/chappie-tunnel.service.example
~~~

---

# 重要避坑

以下问题来自真实 VPS 部署和调试。

## 1. systemd 不读取 .bashrc

SSH shell 中能运行 node、npm、pi、otunnel，不代表 systemd user service 能找到它们。

常见用户级路径：

~~~text
~/.npm-global/bin/pi
~/.local/bin/node
~/.local/bin/otunnel
~~~

TunnelDock 生成的 service 会明确设置：

~~~text
PATH=$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin
~~~

不要依赖 interactive shell profile。

## 2. SSH 退出后 user service 可能停止

检查：

~~~bash
loginctl show-user "$USER" -p Linger
~~~

理想状态：

~~~text
Linger=yes
~~~

否则：

~~~bash
sudo loginctl enable-linger "$USER"
~~~

TunnelDock 会尽量自动启用；没有免密 sudo 时会明确提示。

## 3. 不要让所有 ChatGPT 对话共用一个 Pi session

旧模式：

~~~text
Chat A --+
Chat B --+--> one Pi session
Chat C --+
~~~

TunnelDock patch：

~~~text
Chat A --> Pi A
Chat B --> Pi B
Chat C --> Pi C
~~~

空闲后只回收进程，不删除 session。

## 4. 直接更新 Chappie 可能覆盖 session patch

如果直接运行 pi update，或者重新安装官方 Chappie，上游包可能覆盖本仓库补丁。

恢复：

~~~bash
cd ~/tunneldock
tunneldock update
~~~

TunnelDock update 会重新安装锁定的 Chappie 版本并重新应用 patch。

升级 Chappie 大版本前，不应盲目把旧 patch 套到新源码；应先验证 patch context 和 session 行为。

## 5. npm min-release-age 可能造成 ETARGET

一些加固环境会设置：

~~~ini
min-release-age=7
~~~

如果固定版本发布不足 7 天，npm 可能返回：

~~~text
npm error ETARGET
No matching version found ... with a date before ...
~~~

这不代表版本不存在。

TunnelDock 只在安装锁定 Chappie 版本这一条命令上临时设置：

~~~text
npm_config_min_release_age=0
~~~

不会修改用户永久 npm 供应链安全策略。

## 6. tunnel 正运行时不要把 otunnel doctor 的端口冲突当成真实故障

如果 service 已经监听 127.0.0.1:18080，再启动完整 otunnel doctor，诊断进程本身可能尝试绑定同一 health port，并启动第二个 pi --chappie。

此时可能看到：

~~~text
Address already in use
Chappie broker is already listening
mcp_server_reachable FAIL
~~~

这可能只是诊断实例和正常实例互相冲突。

因此 TunnelDock 的逻辑是：

- service active → 检查现有 /healthz、/readyz、control-plane poll；
- service inactive → 执行完整 otunnel doctor --profile chappie --explain。

## 7. health port 真正被其他程序占用

检查：

~~~bash
ss -ltnp | grep 18080
~~~

重新配置：

~~~bash
tunneldock configure \
  --tunnel-id tunnel_xxxxxxxxx \
  --health-addr 127.0.0.1:18081
~~~

## 8. API Key 不要写进仓库、service 或 shell history

默认凭据文件：

~~~text
~/.chappie/tunnelkey.txt
~~~

权限为 0600。

otunnel profile 只使用 file: 引用。不要把真实 Key 写入 README、Git commit、systemd unit 或 chappie.json。

## 9. otunnel named profile 的真实位置

当前 named profile 默认位于：

~~~text
~/.config/tunnel-client/chappie.yaml
~~~

而不是把所有内容都放在 ~/.chappie/。后者主要用于安全保存凭据文件。

---

# 文件布局

~~~text
tunneldock/
├── bin/
│   └── tunneldock
├── patches/
│   ├── chappie-0.5.0-chat-scoped-sessions.patch
│   └── CHAPPIE-LICENSE
├── systemd/
│   └── chappie-tunnel.service.example
├── install.sh
├── LICENSE
└── README.md
~~~

明确不包含：

~~~text
src-tauri/
React/
Vite/
Tauri/
desktop icons/
desktop updater/
tray/
window management/
~~~

---

# 更新

~~~bash
cd ~/tunneldock
tunneldock update
~~~

更新流程：

1. git pull --ff-only
2. 重新安装锁定的 Chappie
3. 重新应用 chat-scoped session patch
4. 刷新 systemd unit
5. service 正在运行时自动重启

---

# 手工验证

版本：

~~~bash
node --version
npm --version
pi --version
otunnel --version
~~~

Chappie：

~~~bash
pi --help | grep chappie
pi list
~~~

应看到 --chappie / Serve Chappie over MCP。

Tunnel：

~~~bash
tunneldock doctor
~~~

会话隔离验证：

1. 在 ChatGPT 新建对话 A 并调用 Chappie，记录 session ID A。
2. 新建对话 B 并调用，B 应获得不同的 session ID B。
3. 回到 A 再调用，A 应恢复原 session ID A。
4. 服务器执行 tunneldock sessions，应看到独立 managed sessions。

---

# 会话语义边界

普通新建 ChatGPT 对话会得到新的 Pi session。

如果希望新对话明确继续另一个对话的 Pi 工作，可以显式传原 session ID。

如果 ChatGPT 的 Branch to new chat 在宿主层产生新的 conversation ID，它也会按新对话处理并创建新的 Pi session；当前 patch 不自动复制或 fork 原 Pi transcript。

---

# 安全建议

- Tunnel 使用主动出站 HTTPS。
- API Key 使用文件引用，不进入 Git。
- service 使用 UMask=0077。
- Chappie binding/state 位于用户目录。
- managed Pi session 默认按需运行。
- 不开放公开 MCP HTTP listener。

仍建议 VPS 使用独立非 root 用户、SSH 密钥、关闭密码登录，并定期安装系统安全更新。

---

# 上游与许可

TunnelDock CLI 集成：

- OpenAI Secure MCP Tunnel
- https://github.com/zetaloop/otunnel
- https://github.com/earendil-works/pi
- https://github.com/zetaloop/chappie

Chappie patch 基于其 MIT 许可的 0.5.0 源码差异，许可副本：

~~~text
patches/CHAPPIE-LICENSE
~~~

TunnelDock 仅作为集成与 VPS 运维工具，不宣称与上游品牌存在官方从属关系。

## License

TunnelDock CLI 使用 **GNU GPL-3.0**，与原 TunnelDock 项目保持一致。Chappie patch 对应的上游源码采用 MIT License，许可副本见 patches/CHAPPIE-LICENSE。
