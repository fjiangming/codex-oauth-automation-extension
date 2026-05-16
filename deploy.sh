#!/bin/bash
# ============================================================
# Codex OAuth Automation — 多实例部署管理脚本
# ============================================================
# 用法:
#   ./deploy.sh init <数量>          初始化 N 个实例
#   ./deploy.sh start [id|all]       启动实例
#   ./deploy.sh stop [id|all]        停止实例
#   ./deploy.sh restart [id|all]     重启实例
#   ./deploy.sh status               查看所有实例状态
#   ./deploy.sh config <id>          编辑实例配置
#   ./deploy.sh logs <id>            查看实例日志
#   ./deploy.sh vnc <id> [stop]      启动/停止实例的 VNC 远程桌面（用于初始登录）
#   ./deploy.sh update [id|all]      更新实例扩展文件（保留配置）
#   ./deploy.sh destroy [id|all]     销毁实例（删除数据）
# ============================================================

set -euo pipefail

# ======================== 可自定义变量 ========================
BASE_DIR="${CODEX_BASE_DIR:-$HOME/codex-oauth-automation}"
DISPLAY_START="${CODEX_DISPLAY_START:-99}"      # Xvfb 起始 display 编号
DEBUG_PORT_START="${CODEX_DEBUG_PORT:-0}"        # 0 = 不开启远程调试; 非 0 = 起始端口号
VNC_PORT_START="${CODEX_VNC_PORT:-5900}"         # VNC 起始端口（实例1=5900, 实例2=5901...）
CHROME_BIN="${CODEX_CHROME_BIN:-google-chrome}"
SUPERVISOR_CONF_DIR="${CODEX_SUPERVISOR_DIR:-/etc/supervisord.d}"
LOG_DIR="${CODEX_LOG_DIR:-/var/log/codex-oauth-automation}"
# =============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_SRC="${SCRIPT_DIR}"
PROGRAM_PREFIX="codex-oa"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ======================== 辅助函数 ========================

get_instance_dir()  { echo "${BASE_DIR}/instances/$1"; }
get_profile_dir()   { echo "${BASE_DIR}/instances/$1/chrome-profile"; }
get_extension_dir() { echo "${BASE_DIR}/instances/$1/extension"; }
get_config_file()   { echo "${BASE_DIR}/instances/$1/extension/config.json"; }
get_display()       { echo $(( DISPLAY_START + $1 - 1 )); }
get_xvfb_name()     { echo "${PROGRAM_PREFIX}-xvfb-$1"; }
get_chrome_name()   { echo "${PROGRAM_PREFIX}-chrome-$1"; }

get_all_instance_ids() {
    local dir="${BASE_DIR}/instances"
    if [ ! -d "$dir" ]; then
        echo ""
        return
    fi
    ls -1 "$dir" 2>/dev/null | grep -E '^[0-9]+$' | sort -n
}

ensure_root() {
    if [ "$(id -u)" -ne 0 ]; then
        log_error "此脚本需要 root 权限运行"
        exit 1
    fi
}

ensure_dirs() {
    mkdir -p "${BASE_DIR}/instances"
    mkdir -p "${LOG_DIR}"
}

# 计算 Chrome 为 --load-extension 路径生成的确定性扩展 ID
# 算法：SHA-256(路径) → 取前 32 hex → 每个 hex 映射 0→a, 1→b, ..., f→p
compute_extension_id() {
    local ext_path="$1"
    python3 -c "
import hashlib
path = '${ext_path}'
digest = hashlib.sha256(path.encode('utf-8')).hexdigest()[:32]
print(''.join(chr(ord('a') + int(c, 16)) for c in digest))
"
}

# 为指定实例启用扩展的隐身模式授权（修改 Chrome Preferences）
# 要求：Chrome 必须已停止，否则改动会被覆盖
enable_incognito_for_instance() {
    local id="$1"
    local ext_dir=$(get_extension_dir "$id")
    local profile_dir=$(get_profile_dir "$id")
    local prefs_file="${profile_dir}/Default/Preferences"
    local secure_prefs_file="${profile_dir}/Default/Secure Preferences"

    # 计算扩展 ID
    local ext_id=$(compute_extension_id "$ext_dir")
    if [ -z "$ext_id" ]; then
        log_error "实例 #${id}: 扩展 ID 计算失败（需要 python3）"
        return 1
    fi

    # 确保 Default 目录存在
    mkdir -p "${profile_dir}/Default"

    # 如果 Preferences 不存在，创建最小结构
    if [ ! -f "$prefs_file" ]; then
        echo '{}' > "$prefs_file"
    fi

    # 用 Python 修补 Preferences JSON
    python3 << PYEOF
import json, os, sys

def patch_prefs(filepath, ext_id):
    if not os.path.isfile(filepath):
        return False
    with open(filepath, 'r', encoding='utf-8') as f:
        try:
            prefs = json.load(f)
        except json.JSONDecodeError:
            prefs = {}
    # 写入 extensions.settings.<ext_id>.incognito_enabled = true
    settings = prefs.setdefault('extensions', {}).setdefault('settings', {})
    ext_conf = settings.setdefault(ext_id, {})
    ext_conf['incognito_enabled'] = True
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(prefs, f, separators=(',', ':'))
    return True

ext_id = '${ext_id}'
patched_prefs = patch_prefs('${prefs_file}', ext_id)
patched_secure = patch_prefs('${secure_prefs_file}', ext_id)

if patched_prefs or patched_secure:
    targets = []
    if patched_prefs:  targets.append('Preferences')
    if patched_secure: targets.append('Secure Preferences')
    print(f'OK ext_id={ext_id} files={",".join(targets)}')
else:
    print(f'OK ext_id={ext_id} files=Preferences(created)')
PYEOF
}

# ======================== init ========================

cmd_init() {
    local count="${1:-}"
    if [ -z "$count" ] || ! [[ "$count" =~ ^[0-9]+$ ]] || [ "$count" -lt 1 ]; then
        log_error "用法: $0 init <实例数量>"
        log_error "示例: $0 init 3"
        exit 1
    fi

    ensure_root
    ensure_dirs

    log_info "开始初始化 ${count} 个实例..."
    echo ""

    for i in $(seq 1 "$count"); do
        local inst_dir=$(get_instance_dir "$i")
        local ext_dir=$(get_extension_dir "$i")
        local profile_dir=$(get_profile_dir "$i")
        local display=$(get_display "$i")
        local xvfb_name=$(get_xvfb_name "$i")
        local chrome_name=$(get_chrome_name "$i")

        # 跳过已存在的实例
        if [ -d "$inst_dir" ]; then
            log_warn "实例 #${i} 已存在，跳过（如需重建请先执行 destroy）"
            continue
        fi

        log_info "创建实例 #${i}  display=:${display}  目录=${inst_dir}"

        # 创建目录
        mkdir -p "$ext_dir" "$profile_dir"

        # 复制扩展文件（排除 deploy.sh、README.md、.git 等）
        rsync -a --exclude='deploy.sh' \
                 --exclude='README.md' \
                 --exclude='.git' \
                 --exclude='instances' \
                 "${EXTENSION_SRC}/" "$ext_dir/"

        # 生成独立 config.json（如果源目录有模板的话保留，否则生成空配置）
        if [ ! -f "$(get_config_file "$i")" ]; then
            cat > "$(get_config_file "$i")" << CONF
{
  "_comment": "实例 #${i} 配置文件 — 修改后执行: deploy.sh restart ${i}",
  "_forceOverwrite": true,

  "panelMode": "cpa",
  "vpsUrl": "",
  "vpsPassword": "",

  "mailProvider": "163",
  "emailGenerator": "duck",

  "ipProxyEnabled": false,
  "ipProxyHost": "",
  "ipProxyPort": "",
  "ipProxyUsername": "",
  "ipProxyPassword": ""
}
CONF
        fi

        # 生成 Xvfb Supervisor 配置
        cat > "${SUPERVISOR_CONF_DIR}/${xvfb_name}.ini" << EOF
[program:${xvfb_name}]
command=Xvfb :${display} -screen 0 1280x800x24 -ac
autostart=true
autorestart=true
stdout_logfile=${LOG_DIR}/${xvfb_name}.log
stderr_logfile=${LOG_DIR}/${xvfb_name}_err.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
EOF

        # Chrome 启动参数
        local chrome_args="--no-sandbox"
        chrome_args="${chrome_args} --disable-gpu"
        chrome_args="${chrome_args} --disable-dev-shm-usage"
        chrome_args="${chrome_args} --disable-software-rasterizer"
        chrome_args="${chrome_args} --no-first-run"
        chrome_args="${chrome_args} --no-default-browser-check"
        chrome_args="${chrome_args} --enable-logging --v=1"
        chrome_args="${chrome_args} --user-data-dir=${profile_dir}"
        chrome_args="${chrome_args} --load-extension=${ext_dir}"
        chrome_args="${chrome_args} --display=:${display}"

        # 可选：远程调试端口
        if [ "$DEBUG_PORT_START" -gt 0 ]; then
            local debug_port=$(( DEBUG_PORT_START + i - 1 ))
            chrome_args="${chrome_args} --remote-debugging-port=${debug_port}"
        fi

        # 生成 Chrome Supervisor 配置
        cat > "${SUPERVISOR_CONF_DIR}/${chrome_name}.ini" << EOF
[program:${chrome_name}]
command=${CHROME_BIN} ${chrome_args} about:blank
environment=DISPLAY=":${display}"
autostart=true
autorestart=true
startretries=5
startsecs=5
stopwaitsecs=10
stdout_logfile=${LOG_DIR}/${chrome_name}.log
stderr_logfile=${LOG_DIR}/${chrome_name}_err.log
stdout_logfile_maxbytes=50MB
stdout_logfile_backups=3
depends_on=${xvfb_name}
EOF

        log_info "实例 #${i} 创建完成"
    done

    echo ""
    log_info "正在重载 Supervisor 配置..."
    supervisorctl reread
    supervisorctl update

    echo ""
    log_info "初始化完成！共 ${count} 个实例"
    echo ""
    echo "  下一步操作:"
    echo "  1. 编辑各实例配置:          $0 config <实例编号>"
    echo "  2. 启用隐身模式（免 VNC）:  $0 enable-incognito all"
    echo "  3. 启动所有实例:            $0 start all"
    echo "  4. VNC 初始登录:            $0 vnc <实例编号>"
    echo "  5. 查看状态:                $0 status"
    echo ""
}

# ======================== start / stop / restart ========================

do_supervisorctl() {
    local action="$1"
    local target="${2:-all}"

    ensure_root

    if [ "$target" = "all" ]; then
        local ids=$(get_all_instance_ids)
        if [ -z "$ids" ]; then
            log_error "没有找到任何实例，请先执行: $0 init <数量>"
            exit 1
        fi
        for id in $ids; do
            log_info "${action} 实例 #${id}..."
            supervisorctl "$action" "$(get_xvfb_name "$id")" 2>/dev/null || true
            supervisorctl "$action" "$(get_chrome_name "$id")" 2>/dev/null || true
        done
    else
        if ! [[ "$target" =~ ^[0-9]+$ ]]; then
            log_error "无效的实例编号: ${target}"
            exit 1
        fi
        local inst_dir=$(get_instance_dir "$target")
        if [ ! -d "$inst_dir" ]; then
            log_error "实例 #${target} 不存在"
            exit 1
        fi
        log_info "${action} 实例 #${target}..."
        supervisorctl "$action" "$(get_xvfb_name "$target")" 2>/dev/null || true
        supervisorctl "$action" "$(get_chrome_name "$target")" 2>/dev/null || true
    fi

    echo ""
    cmd_status
}

cmd_start()   { do_supervisorctl "start"   "${1:-all}"; }
cmd_stop()    { do_supervisorctl "stop"    "${1:-all}"; }
cmd_restart() { do_supervisorctl "restart" "${1:-all}"; }

# ======================== status ========================

cmd_status() {
    local ids=$(get_all_instance_ids)
    if [ -z "$ids" ]; then
        log_warn "没有找到任何实例"
        return
    fi

    printf "${CYAN}%-6s %-10s %-28s %-28s %-10s${NC}\n" "实例" "Display" "Xvfb" "Chrome" "调试端口"
    printf "%-6s %-10s %-28s %-28s %-10s\n" "------" "----------" "----------------------------" "----------------------------" "----------"

    for id in $ids; do
        local display=":$(get_display "$id")"
        local xvfb_status=$(supervisorctl status "$(get_xvfb_name "$id")" 2>/dev/null | awk '{print $2}' || echo "UNKNOWN")
        local chrome_status=$(supervisorctl status "$(get_chrome_name "$id")" 2>/dev/null | awk '{print $2}' || echo "UNKNOWN")

        local debug_port="-"
        if [ "$DEBUG_PORT_START" -gt 0 ]; then
            debug_port=$(( DEBUG_PORT_START + id - 1 ))
        fi

        # 状态颜色
        local xvfb_color="$RED"
        local chrome_color="$RED"
        [[ "$xvfb_status" == "RUNNING" ]] && xvfb_color="$GREEN"
        [[ "$chrome_status" == "RUNNING" ]] && chrome_color="$GREEN"

        printf "  #%-3s %-10s ${xvfb_color}%-28s${NC} ${chrome_color}%-28s${NC} %-10s\n" \
            "$id" "$display" "$xvfb_status" "$chrome_status" "$debug_port"
    done
    echo ""
}

# ======================== config ========================

cmd_config() {
    local id="${1:-}"
    if [ -z "$id" ] || ! [[ "$id" =~ ^[0-9]+$ ]]; then
        log_error "用法: $0 config <实例编号>"
        exit 1
    fi

    local config_file=$(get_config_file "$id")
    if [ ! -f "$config_file" ]; then
        log_error "实例 #${id} 不存在"
        exit 1
    fi

    local editor="${EDITOR:-vim}"
    log_info "正在编辑实例 #${id} 的配置: ${config_file}"
    "$editor" "$config_file"

    echo ""
    read -p "是否立即重启实例 #${id} 使配置生效？[y/N] " confirm
    if [[ "$confirm" =~ ^[yY]$ ]]; then
        cmd_restart "$id"
    else
        log_info "配置已保存。执行 '$0 restart ${id}' 可使配置生效。"
    fi
}

# ======================== logs ========================

cmd_logs() {
    local id="${1:-}"
    if [ -z "$id" ] || ! [[ "$id" =~ ^[0-9]+$ ]]; then
        log_error "用法: $0 logs <实例编号>"
        exit 1
    fi

    local chrome_name=$(get_chrome_name "$id")
    local log_file="${LOG_DIR}/${chrome_name}.log"

    if [ ! -f "$log_file" ]; then
        log_error "实例 #${id} 的日志文件不存在: ${log_file}"
        exit 1
    fi

    log_info "实例 #${id} 日志 (Ctrl+C 退出):"
    tail -f "$log_file"
}

# ======================== update ========================

cmd_update() {
    local target="${1:-all}"

    ensure_root

    local ids
    if [ "$target" = "all" ]; then
        ids=$(get_all_instance_ids)
    else
        ids="$target"
    fi

    if [ -z "$ids" ]; then
        log_error "没有找到任何实例"
        exit 1
    fi

    log_info "开始更新扩展文件（保留各实例 config.json）..."

    for id in $ids; do
        local ext_dir=$(get_extension_dir "$id")
        local config_file=$(get_config_file "$id")

        if [ ! -d "$ext_dir" ]; then
            log_warn "实例 #${id} 不存在，跳过"
            continue
        fi

        # 备份 config.json
        local config_bak="/tmp/codex-tr-config-${id}.json.bak"
        if [ -f "$config_file" ]; then
            cp "$config_file" "$config_bak"
        fi

        # 同步扩展文件
        rsync -a --delete \
              --exclude='deploy.sh' \
              --exclude='README.md' \
              --exclude='.git' \
              --exclude='instances' \
              --exclude='config.json' \
              "${EXTENSION_SRC}/" "$ext_dir/"

        # 恢复 config.json
        if [ -f "$config_bak" ]; then
            cp "$config_bak" "$config_file"
            rm -f "$config_bak"
        fi

        log_info "实例 #${id} 扩展文件已更新"
    done

    echo ""
    read -p "是否立即重启所有已更新实例？[y/N] " confirm
    if [[ "$confirm" =~ ^[yY]$ ]]; then
        for id in $ids; do
            cmd_restart "$id" 2>/dev/null || true
        done
    else
        log_info "更新完成。执行 '$0 restart all' 可使更新生效。"
    fi
}

# ======================== destroy ========================

cmd_destroy() {
    local target="${1:-}"

    if [ -z "$target" ]; then
        log_error "用法: $0 destroy <实���编号|all>"
        exit 1
    fi

    ensure_root

    local ids
    if [ "$target" = "all" ]; then
        ids=$(get_all_instance_ids)
    else
        ids="$target"
    fi

    if [ -z "$ids" ]; then
        log_error "没有找到任何实例"
        exit 1
    fi

    echo -e "${RED}警告：此操作将删除以下实例的所有数据（包括 Chrome 配置文件和扩展配置）：${NC}"
    for id in $ids; do
        echo "  - 实例 #${id}: $(get_instance_dir "$id")"
    done
    echo ""
    read -p "确认删除？输入 YES 继续: " confirm
    if [ "$confirm" != "YES" ]; then
        log_info "已取消"
        return
    fi

    for id in $ids; do
        local xvfb_name=$(get_xvfb_name "$id")
        local chrome_name=$(get_chrome_name "$id")
        local inst_dir=$(get_instance_dir "$id")

        # 停止进程
        supervisorctl stop "$chrome_name" 2>/dev/null || true
        supervisorctl stop "$xvfb_name" 2>/dev/null || true

        # 删除 Supervisor 配置
        rm -f "${SUPERVISOR_CONF_DIR}/${xvfb_name}.ini"
        rm -f "${SUPERVISOR_CONF_DIR}/${chrome_name}.ini"

        # 删除实例目录
        rm -rf "$inst_dir"

        # 删除日志
        rm -f "${LOG_DIR}/${xvfb_name}"*.log
        rm -f "${LOG_DIR}/${chrome_name}"*.log

        log_info "实例 #${id} 已销毁"
    done

    supervisorctl reread
    supervisorctl update
    echo ""
    log_info "清理完成"
}

# ======================== vnc ========================

cmd_vnc() {
    local id="${1:-}"
    local action="${2:-start}"

    if [ -z "$id" ] || ! [[ "$id" =~ ^[0-9]+$ ]]; then
        log_error "用法: $0 vnc <实例编号> [stop]"
        log_error "示例: $0 vnc 1        # 启动实例 1 的 VNC"
        log_error "      $0 vnc 1 stop   # 停止实例 1 的 VNC"
        exit 1
    fi

    local inst_dir=$(get_instance_dir "$id")
    if [ ! -d "$inst_dir" ]; then
        log_error "实例 #${id} 不存在"
        exit 1
    fi

    local display=$(get_display "$id")
    local vnc_port=$(( VNC_PORT_START + id - 1 ))
    local pid_file="/tmp/codex-tr-vnc-${id}.pid"

    if [ "$action" = "stop" ]; then
        if [ -f "$pid_file" ]; then
            local pid=$(cat "$pid_file")
            kill "$pid" 2>/dev/null && log_info "VNC #${id} 已停止 (PID: ${pid})" || log_warn "VNC #${id} 进程不存在"
            rm -f "$pid_file"
        else
            log_warn "VNC #${id} 未在运行"
        fi
        return
    fi

    # 检查 x11vnc
    if ! command -v x11vnc &>/dev/null; then
        log_error "x11vnc 未安装。请执行: dnf install -y x11vnc"
        exit 1
    fi

    # 检查是否已在运行
    if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
        log_warn "VNC #${id} 已在运行 (端口: ${vnc_port})"
        return
    fi

    # 启动 x11vnc
    x11vnc -display ":${display}" -rfbport "${vnc_port}" \
           -shared -forever -nopw -bg \
           -o "${LOG_DIR}/vnc-${id}.log" 2>/dev/null

    # 记录 PID
    pgrep -f "x11vnc.*:${display}.*${vnc_port}" > "$pid_file" 2>/dev/null

    echo ""
    log_info "VNC #${id} 已启动"
    echo ""
    echo "  连接方式:"
    echo "  ┌─────────────────────────────────────────────────────┐"
    echo "  │  VNC 客户端:  vnc://<服务器IP>:${vnc_port}           "
    echo "  │  SSH 隧道:    ssh -L ${vnc_port}:localhost:${vnc_port} root@<服务器IP>"
    echo "  │               然后 VNC 连接 localhost:${vnc_port}    "
    echo "  └─────────────────────────────────────────────────────┘"
    echo ""
    echo "  初始登录流程:"
    echo "  1. 通过 VNC 客户端连接后，你会看到 Chrome 界面"
    echo "  2. 在主窗口中登录 iCloud / QQ ��箱（取决于你的邮箱配置）"
    echo "  3. Ctrl+Shift+N 打开无痕窗口，登录 Team 主账号"
    echo "  4. 登录完成后关闭 VNC: $0 vnc ${id} stop"
    echo "  5. Session 已保存在 Chrome Profile 中，后续自动运行无需再登录"
    echo ""
}

# ======================== enable-incognito ========================

cmd_enable_incognito() {
    local target="${1:-all}"

    ensure_root

    # 检查 python3
    if ! command -v python3 &>/dev/null; then
        log_error "需要 python3 来计算扩展 ID。请安装: dnf install -y python3"
        exit 1
    fi

    local ids
    if [ "$target" = "all" ]; then
        ids=$(get_all_instance_ids)
    else
        ids="$target"
    fi

    if [ -z "$ids" ]; then
        log_error "没有找到任何实例"
        exit 1
    fi

    # 检查 Chrome 是否在运行（运行中修改会被覆盖）
    local running_ids=""
    for id in $ids; do
        local chrome_name=$(get_chrome_name "$id")
        local status=$(supervisorctl status "$chrome_name" 2>/dev/null | awk '{print $2}' || echo "UNKNOWN")
        if [ "$status" = "RUNNING" ]; then
            running_ids="${running_ids} #${id}"
        fi
    done

    if [ -n "$running_ids" ]; then
        echo -e "${YELLOW}以下实例的 Chrome 正在运行：${running_ids}${NC}"
        echo "运行中修改 Preferences 会被 Chrome 覆盖。"
        read -p "是否先停止这些实例再修改？[Y/n] " confirm
        if [[ ! "$confirm" =~ ^[nN]$ ]]; then
            for id in $ids; do
                local chrome_name=$(get_chrome_name "$id")
                local status=$(supervisorctl status "$chrome_name" 2>/dev/null | awk '{print $2}' || echo "")
                if [ "$status" = "RUNNING" ]; then
                    supervisorctl stop "$chrome_name" 2>/dev/null || true
                fi
            done
            log_info "已停止相关 Chrome 实例"
            sleep 2
        fi
    fi

    echo ""
    log_info "开始为扩展启用隐身模式..."
    echo ""

    local success=0
    local fail=0
    for id in $ids; do
        local inst_dir=$(get_instance_dir "$id")
        if [ ! -d "$inst_dir" ]; then
            log_warn "实例 #${id} 不存在，跳过"
            ((fail++)) || true
            continue
        fi

        local result=$(enable_incognito_for_instance "$id" 2>&1)
        if echo "$result" | grep -q '^OK'; then
            local ext_id=$(echo "$result" | sed 's/.*ext_id=\([^ ]*\).*/\1/')
            local files=$(echo "$result" | sed 's/.*files=\(.*\)/\1/')
            log_info "实例 #${id}  扩展ID=${ext_id}  已修改: ${files}"
            ((success++)) || true
        else
            log_error "实例 #${id} 失败: ${result}"
            ((fail++)) || true
        fi
    done

    echo ""
    log_info "完成！成功 ${success} 个，失败 ${fail} 个"

    # 询问是否重启
    if [ -n "$running_ids" ] || [ $success -gt 0 ]; then
        echo ""
        read -p "是否立即启动/重启这些实例使配置生效？[y/N] " confirm
        if [[ "$confirm" =~ ^[yY]$ ]]; then
            for id in $ids; do
                local xvfb_name=$(get_xvfb_name "$id")
                local chrome_name=$(get_chrome_name "$id")
                supervisorctl start "$xvfb_name" 2>/dev/null || true
                supervisorctl start "$chrome_name" 2>/dev/null || true
            done
            echo ""
            cmd_status
        fi
    fi
}

# ======================== help ========================

cmd_help() {
    echo ""
    echo "Codex OAuth Automation — 多实例部署管理"
    echo ""
    echo "用法: $0 <命令> [参数]"
    echo ""
    echo "命令:"
    echo "  init <数量>              初始化 N 个实例（创建目录、复制扩展、生成 Supervisor 配置）"
    echo "  start [id|all]           启动指定实例或全部（默认 all）"
    echo "  stop [id|all]            停止指定实例或全部（默认 all）"
    echo "  restart [id|all]         重启指定实例或全部（默认 all）"
    echo "  status                   查看所有实例运行状态"
    echo "  config <id>              编辑指定实例的 config.json"
    echo "  logs <id>                实时查看指定实例的 Chrome 日志"
    echo "  vnc <id> [stop]          启动/停止实例的 VNC 远程桌面（用于初始登录）"
    echo "  enable-incognito [id|all] 为扩展启用隐身模式授权（免 VNC 操作）"
    echo "  update [id|all]          更新扩展文件（保留各实例 config.json）"
    echo "  destroy <id|all>         销毁指定实例（删除所有数据，不可恢复）"
    echo ""
    echo "环境变量（可选）:"
    echo "  CODEX_BASE_DIR       实例根目录（默认 ~/codex-oauth-automation）"
    echo "  CODEX_DISPLAY_START  Xvfb 起始 display 编号（默认 99）"
    echo "  CODEX_DEBUG_PORT     远程调试起始端口（默认 0 = 不开启）"
    echo "  CODEX_VNC_PORT       VNC 起始端口（默认 5900）"
    echo "  CODEX_CHROME_BIN     Chrome 可执行文件路径（默认 google-chrome）"
    echo "  CODEX_SUPERVISOR_DIR Supervisor 配置目录（默认 /etc/supervisord.d）"
    echo "  CODEX_LOG_DIR        日志目录（默认 /var/log/codex-oauth-automation）"
    echo ""
    echo "示例:"
    echo "  $0 init 5                    # 初始化 5 个实例"
    echo "  $0 config 1                  # 编辑实例 1 的配置"
    echo "  $0 enable-incognito all      # 为所有实例启用隐身模式"
    echo "  $0 start all                 # 启动所有实例"
    echo "  $0 restart 3                 # 重启实例 3"
    echo "  $0 logs 1                    # 查看实例 1 的日志"
    echo "  $0 vnc 1                     # 启动实例 1 的 VNC 远程桌面"
    echo "  $0 vnc 1 stop                # 停止实例 1 的 VNC"
    echo "  $0 update all                # 代码更新后同步到所有实例"
    echo "  $0 destroy 5                 # 删除实例 5"
    echo ""
}

# ======================== 入口 ========================

case "${1:-help}" in
    init)    cmd_init "${2:-}"    ;;
    start)   cmd_start "${2:-all}"   ;;
    stop)    cmd_stop "${2:-all}"    ;;
    restart) cmd_restart "${2:-all}" ;;
    status)  cmd_status          ;;
    config)  cmd_config "${2:-}" ;;
    logs)    cmd_logs "${2:-}"   ;;
    vnc)     cmd_vnc "${2:-}" "${3:-start}" ;;
    enable-incognito) cmd_enable_incognito "${2:-all}" ;;
    update)  cmd_update "${2:-all}" ;;
    destroy) cmd_destroy "${2:-}" ;;
    help|--help|-h) cmd_help     ;;
    *)
        log_error "未知命令: $1"
        cmd_help
        exit 1
        ;;
esac
