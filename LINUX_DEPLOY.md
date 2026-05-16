# Codex OAuth Automation — Linux 部署指南

> 自动执行多步骤 OAuth 注册流程 — 支持本地 Chrome 浏览器和 Linux 无头服务器两种运行模式

---

## 目录

- [服务器部署（Linux CentOS）](#服务器部署linux-centos)
- [多实例部署](#多实例部署)
- [配置说明](#配置说明)
- [日常使用](#日常使用)
- [监控](#监控)
- [更新升级](#更新升级)
- [常见问题](#常见问题)

---

## 服务器部署（Linux CentOS）

### 环境要求

| 依赖 | 版本 | 用途 |
|------|------|------|
| CentOS | 9 Stream x64 | 操作系统 |
| Google Chrome | ≥ 120 | 浏览器引擎 |
| Xvfb | 最新 | 虚拟帧缓冲（无头显示） |
| Supervisor | 最新 | 进程守护 |

### 1. 安装依赖

```bash
# ==================== 1.1 安装 Google Chrome ====================
dnf install -y wget
wget https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm
dnf install -y ./google-chrome-stable_current_x86_64.rpm
rm -f google-chrome-stable_current_x86_64.rpm

# 验证
google-chrome --version
# 预期输出: Google Chrome 12x.x.x.x

# ==================== 1.2 安装 Xvfb（虚拟帧缓冲）====================
dnf install -y xorg-x11-server-Xvfb

# 验证
Xvfb -help 2>&1 | head -1

# ==================== 1.3 安装 Supervisor（进程守护）====================
dnf install -y supervisor

# 验证
supervisord --version
# 预期输出: 4.x.x

# 启用 Supervisor 开机自启并立即启动服务
systemctl enable supervisord
systemctl start supervisord

# 确认 Supervisor 正在运行
systemctl status supervisord
# 预期: active (running)

# 确认配置目录存在（deploy.sh 将在此目录下生成 .ini 配置文件）
ls -la /etc/supervisord.d/
# 如果目录不存在，检查 /etc/supervisord.conf 中的 [include] 配置:
#   [include]
#   files = supervisord.d/*.ini

# ==================== 1.4 安装中文字体（可选但推荐）====================
# Chrome 渲染中文页面时需要中文字体，否则会显示方块
dnf install -y google-noto-sans-cjk-ttc-fonts

# ==================== 1.5 安装 VNC 工具（初始登录用）====================
dnf install -y x11vnc

# ==================== 1.6 安装 Python3（deploy.sh 依赖）====================
# CentOS 9 通常自带 python3，验证一下:
python3 --version
# 如果缺失: dnf install -y python3

# ==================== 1.7 优化共享内存（推荐）====================
# Chrome 默认使用 /dev/shm 作为共享内存，容量不足会导致崩溃
# 查看当前大小
df -h /dev/shm

# 如果需要调整大小（例如限制为 2G），执行以下步骤：
# 添加到 /etc/fstab（永久生效）
echo 'tmpfs /dev/shm tmpfs defaults,size=2G 0 0' >> /etc/fstab

# 立即生效（无需重启）
mount -o remount,size=2G /dev/shm

# 验证
df -h /dev/shm
# 预期: Size = 2.0G
```

> **注意**：每个 Chrome 实例约占用 50~200MB 共享内存，2G 可支撑 10+ 个实例同时运行。如果 `/dev/shm` 空间充足（≥ 512M），Chrome 启动参数中的 `--disable-dev-shm-usage` 可以去掉以获得更好的性能。空间不足时保留此参数，Chrome 会回退到 `/tmp` 目录。

### 2. 上传扩展

```bash
# 从开发机上传（项目根目录即为扩展目录）
scp -r codex-oauth-automation-extension/ root@your-server:~/codex-oauth-automation/extension/

# 或通过 Git
cd ~
git clone <your-repo-url> codex-oauth-automation/extension

# 添加脚本执行权限
chmod +x ~/codex-oauth-automation/extension/deploy.sh
chmod +x ~/codex-oauth-automation/extension/monitor.sh
```

### 3. 编辑配置

```bash
vim ~/codex-oauth-automation/extension/config.json
```

至少填写以下内容（参考 [配置说明](#配置说明) 了解所有可用项）：

```json
{
  "panelMode": "cpa",
  "vpsUrl": "http://10.0.0.1:3000/management.html#/oauth",
  "vpsPassword": "your-admin-key",

  "mailProvider": "icloud",
  "emailGenerator": "icloud",
  "icloudFetchMode": "reuse_existing",

  "autoStepDelaySeconds": 3,
  "step6CookieCleanupEnabled": true
}
```

### 4. 配置 Supervisor

> **前置检查**：确认 Supervisor 服务正在运行且配置目录可用。

```bash
# 确认 supervisord 正在运行
systemctl status supervisord

# 确认 /etc/supervisord.conf 中包含以下 [include] 配置
# （CentOS 9 默认已配置，但建议确认一下）
grep -A1 '\[include\]' /etc/supervisord.conf
# 预期输出:
#   [include]
#   files = supervisord.d/*.ini
```

#### 4.1 创建 Xvfb 进程配置

```bash
cat > /etc/supervisord.d/xvfb.ini << 'EOF'
[program:xvfb]
command=Xvfb :99 -screen 0 1280x800x24 -ac
autostart=true
autorestart=true
stdout_logfile=/var/log/xvfb.log
stderr_logfile=/var/log/xvfb_err.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
EOF
```

#### 4.2 创建 Chrome 进程配置

```bash
cat > /etc/supervisord.d/chrome-oauth-automation.ini << 'EOF'
[program:chrome-oauth-automation]
command=google-chrome
    --no-sandbox
    --disable-gpu
    --disable-dev-shm-usage
    --disable-software-rasterizer
    --no-first-run
    --no-default-browser-check
    --enable-logging --v=1
    --user-data-dir=%(ENV_HOME)s/codex-oauth-automation/chrome-profile
    --load-extension=%(ENV_HOME)s/codex-oauth-automation/extension
    --display=:99
    about:blank
environment=DISPLAY=":99",HOME="/root"
redirect_stderr=true
autostart=true
autorestart=true
startretries=5
startsecs=5
stopwaitsecs=10
stdout_logfile=/var/log/chrome-oauth-automation.log
stdout_logfile_maxbytes=50MB
stdout_logfile_backups=3
depends_on=xvfb
EOF
```

#### 4.3 加载配置并启动

```bash
# 让 Supervisor 重新读取配置
supervisorctl reread
# 预期输出: xvfb: available
#           chrome-oauth-automation: available

# 应用变更（自动启动新增的程序）
supervisorctl update
# 预期输出: xvfb: added process group
#           chrome-oauth-automation: added process group

# 确认启动状态
supervisorctl status
# 预期输出:
#   chrome-oauth-automation   RUNNING   pid 12345, uptime 0:00:05
#   xvfb                      RUNNING   pid 12340, uptime 0:00:10
```

> **故障排除**：如果 Chrome 状态显示 `FATAL` 或 `BACKOFF`，查看错误日志：
> ```bash
> cat /var/log/chrome-oauth-automation_err.log
> # 常见问题:
> # - "no DISPLAY" → Xvfb 未启动，先确认 xvfb 进程状态
> # - "Running as root without --no-sandbox" → 缺少 --no-sandbox 参数
> # - "shared memory" → /dev/shm 空间不足，参考 1.7 步骤
> ```

### 5. 验证部署

```bash
# 检查进程状态
supervisorctl status

# 查看 Chrome 日志
supervisorctl tail chrome-oauth-automation

# 查看配置是否注入成功
grep "config-loader" /var/log/chrome-oauth-automation.log
```

预期输出：

```
[config-loader] Applied 8 config entries from config.json: ["panelMode","vpsUrl","vpsPassword",...]
```

### 6. 初始登录（VNC 远程桌面）

自动流程启动前，需要先手动登录邮箱和 Team 主账号。在无头环境下通过 VNC 远程查看 Chrome 界面完成：

```bash
# 安装 x11vnc
dnf install -y x11vnc

# 启动 VNC（单实例模式直接启动，多实例用 deploy.sh）
x11vnc -display :99 -rfbport 5900 -shared -forever -nopw -bg

# 多实例模��
./deploy.sh vnc 1        # 启动实例 1 的 VNC (端口 5900)
./deploy.sh vnc 2        # 启动实例 2 的 VNC (端口 5901)
```

用 VNC 客户端（macOS 自带、RealVNC、TightVNC 等）连接 `服务器IP:5900`，或通过 SSH 隧道：

```bash
# 本地终端建立 SSH 隧道
ssh -L 5900:localhost:5900 root@your-server

# 然后 VNC 客户端连接 localhost:5900
```

连接后你会看到 Chrome 界面，按以下顺序操作：

1. **主窗口** → 打开 iCloud / QQ 邮箱网页版并登录（取决于你的 `mailProvider` 配置）
2. **Ctrl+Shift+N** → 打开无痕窗口 → 登录 Team 主账号
3. 登录完成后关闭 VNC：

```bash
./deploy.sh vnc 1 stop   # 多实例模式
# 或直接 kill x11vnc
```

> **重要**：登录 Session 保存在 Chrome Profile 中，**只需登录一次**。后续重启 Chrome 不需要重新登录（除非 Session 过期）。Session 过期后，再次 `./deploy.sh vnc <id>` 重新登录即可。

### 7. 多实例部署（可选）

如果需要同时运行多个实例（不同配置、不同代理），请参考 [多实例部署](#多实例部署) 章节，使用 `deploy.sh` 一键管理。

---

## 多实例部署

`deploy.sh` 脚本可一键创建和管理多个完全隔离的实例，每个实例拥有独立的：

| 隔离资源 | 说明 |
|----------|------|
| Xvfb Display | 独立虚拟屏幕（`:99`, `:100`, `:101`...） |
| Chrome Profile | 独立用户数据目录（`chrome.storage` 完全隔离） |
| config.json | 独立配置文件（不同密钥/邮箱/代理） |
| Supervisor 进程 | 独立进程守护和日志 |

### 隔离架构

```
~/codex-oauth-automation/
├── extension/                   # 源扩展目录（deploy.sh 所在位置）
└── instances/
    ├── 1/
    │   ├── extension/           # 实例 1 的扩展副本
    │   │   └── config.json      # 实例 1 的独立配置
    │   └── chrome-profile/      # 实例 1 的 Chrome 数据
    ├── 2/
    │   ├── extension/
    │   │   └── config.json      # 实例 2 的独立配置
    │   └── chrome-profile/
    └── N/
        └── ...
```

### 快速开始

```bash
# 上传扩展到服务器
scp -r codex-oauth-automation-extension/ root@server:~/codex-oauth-automation/extension/

# 添加执行权限
chmod +x ~/codex-oauth-automation/extension/deploy.sh
cd ~/codex-oauth-automation/extension

# 初始化 5 个实例
./deploy.sh init 5

# 分别编辑各实例配置（每个实例使用不同的代理/邮箱/密钥）
./deploy.sh config 1    # 编辑实例 1 的 config.json
./deploy.sh config 2    # 编辑实例 2 的 config.json
./deploy.sh config 3    # ...

# 启动所有实例
./deploy.sh start all

# 查看运行状态
./deploy.sh status
```

### 状态查看示例

```
实例   Display    Xvfb                         Chrome                       调试端口
------ ---------- ---------------------------- ---------------------------- ----------
  #1   :99        RUNNING                      RUNNING                      -
  #2   :100       RUNNING                      RUNNING                      -
  #3   :101       RUNNING                      RUNNING                      -
  #4   :102       RUNNING                      STOPPED                      -
  #5   :103       RUNNING                      RUNNING                      -
```

### 命令参考

| 命令 | 说明 | 示例 |
|------|------|------|
| `init <N>` | 初始化 N 个实例 | `./deploy.sh init 5` |
| `start [id\|all]` | 启动实例 | `./deploy.sh start 3` |
| `stop [id\|all]` | 停止实例 | `./deploy.sh stop all` |
| `restart [id\|all]` | 重启实例 | `./deploy.sh restart 2` |
| `status` | 查看所有实例状态 | `./deploy.sh status` |
| `config <id>` | 编辑实例配置 | `./deploy.sh config 1` |
| `logs <id>` | 实时查看实例日志 | `./deploy.sh logs 3` |
| `vnc <id> [stop]` | 启动/停止 VNC 远程���面 | `./deploy.sh vnc 1` |
| `enable-incognito [id\|all]` | 为扩展启用隐身模式 | `./deploy.sh enable-incognito all` |
| `update [id\|all]` | 更新扩展文件（保留配置） | `./deploy.sh update all` |
| `destroy <id\|all>` | 销毁实例（不可恢复） | `./deploy.sh destroy 5` |

### 环境变量

可通过环境变量自定义脚本行为：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CODEX_BASE_DIR` | `~/codex-oauth-automation` | 实例根目录 |
| `CODEX_DISPLAY_START` | `99` | Xvfb 起始 display 编号 |
| `CODEX_DEBUG_PORT` | `0`（关闭） | 远程调试起始端口（如 `9222` → 实例 1 用 9222, 实例 2 用 9223...） |
| `CODEX_VNC_PORT` | `5900` | VNC 起始端口 |
| `CODEX_CHROME_BIN` | `google-chrome` | Chrome 可执行文件路径 |
| `CODEX_SUPERVISOR_DIR` | `/etc/supervisord.d` | Supervisor 配置目录 |
| `CODEX_LOG_DIR` | `/var/log/codex-oauth-automation` | 日志目录 |

### 典型场景：多代理并行

```bash
# 初始化 3 个实例
./deploy.sh init 3

# 实例 1：美国代理
./deploy.sh config 1
# 填入: "ipProxyHost": "us-proxy.example.com", "ipProxyPort": "8080"

# 实例 2：日本代理
./deploy.sh config 2
# 填入: "ipProxyHost": "jp-proxy.example.com", "ipProxyPort": "8080"

# 实例 3：德国代理
./deploy.sh config 3
# 填入: "ipProxyHost": "de-proxy.example.com", "ipProxyPort": "8080"

# 全部启动
./deploy.sh start all
```

### 代码更新后同步到所有实例

```bash
# 1. 先更新源目录
cd ~/codex-oauth-automation/extension
git pull

# 2. 同步到所有实例（自动保留各自的 config.json）
./deploy.sh update all

# 3. 重启
./deploy.sh restart all
```

---

## 配置说明

所有配置通过 `config.json` 管理。修改后重启 Chrome 生效。

### 元配置

| 字段 | 类型 | 说明 |
|------|------|------|
| `_comment` | string | 注释说明，不会被加载 |
| `_forceOverwrite` | boolean | `true`（默认）= 每次启动覆盖已有配置；`false` = 仅写入新配置 |

> **提示**：首次部署或需要完全重置配置时使用默认模式（不设 `_forceOverwrite` 或设为 `true`）。之后日常微调可改为 `false`，避免覆盖运行时已修改的值。

### 来源与回调

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `panelMode` | `cpa` / `sub2api` / `codex2api` | `cpa` | 回调来源类型 |
| `vpsUrl` | string | `""` | CPA 管理面板地址 |
| `vpsPassword` | string | `""` | CPA 管理密钥 |
| `sub2apiUrl` | string | `""` | SUB2API 服务地址 |
| `sub2apiEmail` | string | `""` | SUB2API 登录邮箱 |
| `sub2apiPassword` | string | `""` | SUB2API 登录密码 |
| `sub2apiGroupName` | string | `""` | SUB2API 目标分组 |
| `codex2apiUrl` | string | `""` | Codex2API 服务地址 |
| `codex2apiAdminKey` | string | `""` | Codex2API 管理密钥 |

### 账号与邮箱

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `customPassword` | string | `""` | 自定义账号密码（空 = 自动生成） |
| `mailProvider` | string | `163` | 邮箱服务商：`qq` / `163` / `icloud` / `duck` / `hotmail` / `luckmail` / `inbucket` / `gmail` / `mail2925` / `cloudflare` |
| `emailGenerator` | string | `duck` | 邮箱生成方式：`duck` / `icloud` / `gmail` / `cloudflare_temp` / `custom` |
| `emailPrefix` | string | `""` | 邮箱前缀（特定生成方式使用） |
| `gmailBaseEmail` | string | `""` | Gmail+tag 基础邮箱 |
| `icloudFetchMode` | `reuse_existing` / `always_new` | `reuse_existing` | iCloud 别名获取模式 |
| `icloudHostPreference` | `auto` / `com` / `com.cn` | `auto` | iCloud 域名偏好 |
| `autoDeleteUsedIcloudAlias` | boolean | `false` | 使用后自动删除 iCloud 别名 |

### 运行控制

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `autoStepDelaySeconds` | number | `0` | 每步之间的等待时间（秒） |
| `autoRunDelayEnabled` | boolean | `false` | 开启多轮运行间的延迟 |
| `autoRunDelayMinutes` | number | `30` | 多轮延迟时间（分钟） |
| `autoRunSkipFailures` | boolean | `false` | 失败后自动跳过继续下一轮 |
| `step6CookieCleanupEnabled` | boolean | `false` | 注册成功后清理 Cookies |
| `oauthFlowTimeoutEnabled` | boolean | `true` | OAuth 流程超时检测 |

### IP 代理

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `ipProxyEnabled` | boolean | `false` | 启用 IP 代理 |
| `ipProxyHost` | string | `""` | 代理主机 |
| `ipProxyPort` | string | `""` | 代理端口 |
| `ipProxyProtocol` | string | `http` | 代理协议 |
| `ipProxyUsername` | string | `""` | 代理用户名 |
| `ipProxyPassword` | string | `""` | 代理密码 |

### 接码平台

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `phoneVerificationEnabled` | boolean | `false` | 启用手机接码 |
| `phoneSmsProvider` | `hero_sms` / `five_sim` | `hero_sms` | 接码服务商 |
| `heroSmsApiKey` | string | `""` | HeroSMS API 密钥 |
| `fiveSimApiKey` | string | `""` | 5SIM API 密钥 |

### Plus 升级（可选）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `plusModeEnabled` | boolean | `false` | 启用 Plus 自动订阅 |
| `plusPaymentMethod` | string | `paypal` | 支付方式 |
| `paypalEmail` | string | `""` | PayPal 邮箱 |
| `paypalPassword` | string | `""` | PayPal 密码 |

### 定时调度

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `schedulerIntervalMinutes` | number | `30` | 批次间隔时间（分钟） |
| `schedulerRunsPerBatch` | number | `5` | 每批执行次数 |
| `schedulerAutoSkipEmailFailure` | boolean | `true` | 邮箱获取失败时自动跳过 |

---

## 日常使用

### Linux 模式

```bash
# 启动 / 停止 / 重启（多实例模式）
./deploy.sh start all
./deploy.sh stop all
./deploy.sh restart all

# 或单实例模式
supervisorctl start chrome-oauth-automation
supervisorctl stop chrome-oauth-automation
supervisorctl restart chrome-oauth-automation
```

### 修改 Linux 配置

```bash
# 多实例模式
./deploy.sh config 1       # 编辑实例 1 配置

# 单实例模式
vim ~/codex-oauth-automation/extension/config.json
supervisorctl restart chrome-oauth-automation
```

### 监控运行状态

```bash
# 查看运行摘要（今日统计 + 最近步骤 + 错误）
./monitor.sh summary

# 实时监控所有实例日志
./monitor.sh

# 仅看步骤执行日志
./monitor.sh steps

# 仅看错误
./monitor.sh errors
```

详见 [监控](#监控) 章节。

---

## 监控

`monitor.sh` 脚本提供多维度的运行状态监控，所有输出带彩色标记和实例编号。

### 命令参考

| 命令 | 说明 |
|------|------|
| `./monitor.sh` | 实时监控所有实例日志（合并流，按实例着色） |
| `./monitor.sh 3` | 仅实时监控实例 #3 |
| `./monitor.sh status` | 进程状态表 + 今日步骤计数 |
| `./monitor.sh steps` | 仅显示 `[STEP]` 日志（过滤 Chrome 内部噪音） |
| `./monitor.sh steps 2` | 仅显示实例 #2 的步骤日志 |
| `./monitor.sh errors` | 仅显示 `[ERROR]` 和 `[WARN]` |
| `./monitor.sh summary` | 运行摘要：今日统计 + 最近 3 条步骤 + 最近错误 |

### 运行摘要示例

```
═══════════════════════════════════════════════════════════════
  Codex OAuth Automation — 运行摘要  2026-05-14 00:30:00
═══════════════════════════════════════════════════════════════

  ▸ 实例 #1  ✅ RUNNING
    今日统计: ✓ 12 成功  ✗ 2 错��  ⚠ 5 警告  步骤 156 条
    最近步骤:
      │ 2026-05-14 00:28:15 [STEP 13] [OK] 平台回调验证成功
      │ 2026-05-14 00:28:20 [STEP 14] [INFO] 清理团队子账号
      │ 2026-05-14 00:28:25 [STEP 14] [OK] 子账号已移除

  ▸ 实例 #2  ✅ RUNNING
    今日统计: ✓ 8 成功  ✗ 1 错误  ⚠ 3 警告  步骤 98 条
    最近步骤:
      │ 2026-05-14 00:29:05 [STEP 04] [INFO] 获取注册验证码
      │ 2026-05-14 00:29:15 [STEP 04] [OK] 验证码已获取: 123456
      │ 2026-05-14 00:29:20 [STEP 05] [INFO] 填写姓名和生日

  ▸ 实例 #3  ❌ STOPPED
    今日统计: ✓ 0 成功  ✗ 0 错误  ⚠ 0 警告  步骤 0 条

═══════════════════════════════════════════════════════════════
```

---

## 更新升级

### 方式一：deploy.sh 自动更新（多实例推荐）

```bash
# 1. 拉取新版本
cd ~/codex-oauth-automation/extension
git pull

# 2. 同步到所有实例（自动保留各实例 config.json）
./deploy.sh update all

# 3. 重启
./deploy.sh restart all

# 4. 验证
./deploy.sh status
```

### 方式二：单实例覆盖更新

```bash
# 1. 备份当前配置
cp ~/codex-oauth-automation/extension/config.json /tmp/config.json.bak

# 2. 停止服务
supervisorctl stop chrome-oauth-automation

# 3. 拉取新版本
cd ~/codex-oauth-automation/extension
git pull
# 或手动上传新文件覆盖扩展目录

# 4. 恢复配置
cp /tmp/config.json.bak ~/codex-oauth-automation/extension/config.json

# 5. 重启服务
supervisorctl start chrome-oauth-automation

# 6. 验证
supervisorctl status
grep "config-loader" /var/log/chrome-oauth-automation.log
```

### 方式三：手动替换单个文件

如果仅更新了部分文件（如 `background.js`）：

```bash
# 1. 替换文件
scp background.js root@server:~/codex-oauth-automation/extension/

# 2. 同步到实例并重启（多实例模式）
./deploy.sh update all
./deploy.sh restart all

# 或单实例模式直接重启
supervisorctl restart chrome-oauth-automation
```

### 注意事项

- 更新后 **不需要** 重新加载扩展（重启 Chrome 即可）
- `deploy.sh update` 会自动保留各实例的 `config.json`，不会被覆盖
- Chrome 用户数据目录中的 `chrome.storage.local` 数据会自动保留
- 如果新版本有新配置项，在 `config.json` 中添加即可

---

## 常见问题

### Q: Linux 下扩展侧边栏不可见，流程是否会正常运行？

**A**: 会。流程由 `background.js`（Service Worker）驱动，不依赖侧边栏 UI。侧边栏仅用于配置和日志展示，无头模式下配置通过 `config.json` 注入。

### Q: 配置修改后不生效？

**A**: 检查以下几点：
1. `config.json` 是否为合法 JSON（可用 `python3 -m json.tool config.json` 验证）
2. 值为空字符串 `""` 的字段不会被写入
3. 默认模式下 `config.json` 仅在首次启动时导入，面板中修改的配置不会被覆盖
4. 如需强制用 `config.json` 覆盖面板已有配置，可设置 `_forceOverwrite: true`
5. 修改后需要 `supervisorctl restart chrome-oauth-automation`

### Q: Chrome 进程频繁重启？

**A**: 检查：
```bash
# 查看错误日志
cat /var/log/chrome-oauth-automation_err.log

# 常见原因：
# 1. 缺少 --no-sandbox 参数（root 运行时必须）
# 2. 共享内存不足 → 添加 --disable-dev-shm-usage
# 3. Xvfb 未启动 → supervisorctl start xvfb
```

### Q: 如何查看当前生效的配置？

**A**: 通过 Chrome DevTools Protocol：
```bash
# 获取调试端口（需要在启动参数中添加 --remote-debugging-port=9222）
curl -s http://localhost:9222/json | python3 -m json.tool
```

### Q: 如何同时运行多个实例？

**A**: 使用 `deploy.sh` 脚本一键管理：
```bash
# 初始化 5 个实例
./deploy.sh init 5

# 分别编辑配置
./deploy.sh config 1
./deploy.sh config 2

# 全部启动
./deploy.sh start all

# 查看状态
./deploy.sh status
```
详见 [多实例部署](#多实例部署) 章节。

### Q: 多实例之间会互相影响吗？

**A**: 不会。每个实例拥有完全独立的 Xvfb 虚拟屏幕、Chrome Profile（`chrome.storage.local` 隔离）和配置文件。即使某个实例崩溃也不影响其他实例。

### Q: 服务器能承受多少个实例？

**A**: 每个 Chrome 实例约消耗 200-500MB 内存。参考：
| 服务器配置 | 建议实例数 |
|-----------|----------|
| 2C4G | 2-3 个 |
| 4C8G | 5-8 个 |
| 8C16G | 10-15 个 |
| 16C32G | 20-30 个 |

实际数量取决于流程复杂度和并发页面数。建议通过 `free -h` 和 `top` 监控实际资源占用后调整。
