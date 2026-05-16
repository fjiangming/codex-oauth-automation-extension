#!/bin/bash
# ============================================================
# Codex OAuth Automation — 多实例监控脚本
# ============================================================
# 用法:
#   ./monitor.sh                  实时监控所有实例日志（合并流）
#   ./monitor.sh status           查看所有实例进程状态
#   ./monitor.sh <id>             实时监控指定实例日志
#   ./monitor.sh steps [id|all]   仅显示步骤执行日志（过滤噪音）
#   ./monitor.sh errors [id|all]  仅显示错误和警告
#   ./monitor.sh summary          一次性输出各实例最近状态摘要
# ============================================================

set -euo pipefail

BASE_DIR="${CODEX_BASE_DIR:-$HOME/codex-oauth-automation}"
LOG_DIR="${CODEX_LOG_DIR:-/var/log/codex-oauth-automation}"
PROGRAM_PREFIX="codex-oa"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

# 实例颜色轮转
COLORS=("$GREEN" "$CYAN" "$MAGENTA" "$YELLOW" "$RED" "\033[0;34m" "\033[0;96m" "\033[0;93m")

get_all_instance_ids() {
    local dir="${BASE_DIR}/instances"
    if [ ! -d "$dir" ]; then echo ""; return; fi
    ls -1 "$dir" 2>/dev/null | grep -E '^[0-9]+$' | sort -n
}

get_chrome_log() { echo "${LOG_DIR}/${PROGRAM_PREFIX}-chrome-$1.log"; }
get_chrome_name() { echo "${PROGRAM_PREFIX}-chrome-$1"; }
get_xvfb_name() { echo "${PROGRAM_PREFIX}-xvfb-$1"; }

# ======================== status ========================

cmd_status() {
    local ids=$(get_all_instance_ids)
    if [ -z "$ids" ]; then
        echo -e "${YELLOW}没有找到任何实例${NC}"
        return
    fi

    echo ""
    echo -e "${BOLD}Codex OAuth Automation — 实例状态${NC}"
    echo ""
    printf "  ${CYAN}%-6s %-12s %-12s %-24s %-10s${NC}\n" "实例" "Chrome" "Xvfb" "最后活动" "今日步骤"
    printf "  %-6s %-12s %-12s %-24s %-10s\n" "------" "------------" "------------" "------------------------" "----------"

    for id in $ids; do
        local chrome_status=$(supervisorctl status "$(get_chrome_name "$id")" 2>/dev/null | awk '{print $2}' || echo "?")
        local xvfb_status=$(supervisorctl status "$(get_xvfb_name "$id")" 2>/dev/null | awk '{print $2}' || echo "?")
        local log_file=$(get_chrome_log "$id")

        # 最后活动��间
        local last_activity="-"
        if [ -f "$log_file" ]; then
            local last_line=$(grep -E '\[STEP [0-9]+\]' "$log_file" 2>/dev/null | tail -1)
            if [ -n "$last_line" ]; then
                last_activity=$(echo "$last_line" | grep -oP '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}' || echo "-")
            fi
        fi

        # 今日完成步骤数
        local today=$(date +%Y-%m-%d)
        local step_count=0
        if [ -f "$log_file" ]; then
            step_count=$(grep -c "${today}.*\[STEP.*\[OK\]" "$log_file" 2>/dev/null || echo "0")
        fi

        # 状态颜色
        local c_color="$RED"; [[ "$chrome_status" == "RUNNING" ]] && c_color="$GREEN"
        local x_color="$RED"; [[ "$xvfb_status" == "RUNNING" ]] && x_color="$GREEN"

        printf "  #%-4s ${c_color}%-12s${NC} ${x_color}%-12s${NC} %-24s %-10s\n" \
            "$id" "$chrome_status" "$xvfb_status" "$last_activity" "$step_count"
    done
    echo ""
}

# ======================== live (tail all) ========================

cmd_live_all() {
    local ids=$(get_all_instance_ids)
    if [ -z "$ids" ]; then
        echo -e "${YELLOW}没有找到任何实例${NC}"
        return
    fi

    echo -e "${BOLD}实时监控所有实例（Ctrl+C 退出）${NC}"
    echo ""

    # 构建 tail 命令：多文件合并 + 带实例标签
    local log_files=()
    for id in $ids; do
        local log_file=$(get_chrome_log "$id")
        if [ -f "$log_file" ]; then
            log_files+=("$log_file")
        fi
    done

    if [ ${#log_files[@]} -eq 0 ]; then
        echo -e "${YELLOW}没有找到任何日志文件${NC}"
        return
    fi

    # 用 tail -f + awk 合并并着色
    tail -f "${log_files[@]}" 2>/dev/null | awk -v prefix="$PROGRAM_PREFIX" '
    /^==> / {
        # 提取实例编号
        match($0, /chrome-([0-9]+)\.log/, arr)
        if (arr[1] != "") current_id = arr[1]
        next
    }
    {
        # 颜色映射
        colors[1] = "\033[0;32m"   # green
        colors[2] = "\033[0;36m"   # cyan
        colors[3] = "\033[0;35m"   # magenta
        colors[4] = "\033[1;33m"   # yellow
        colors[5] = "\033[0;34m"   # blue
        colors[6] = "\033[0;96m"   # light cyan
        colors[7] = "\033[0;93m"   # light yellow
        colors[8] = "\033[0;91m"   # light red
        nc = "\033[0m"

        color_idx = ((current_id - 1) % 8) + 1
        color = colors[color_idx]

        # 级别着色
        level_color = ""
        if ($0 ~ /\[ERROR\]/) level_color = "\033[0;31m"
        else if ($0 ~ /\[WARN\]/) level_color = "\033[1;33m"
        else if ($0 ~ /\[OK\]/) level_color = "\033[0;32m"

        if (level_color != "")
            printf "%s[#%s]%s %s%s%s\n", color, current_id, nc, level_color, $0, nc
        else
            printf "%s[#%s]%s %s\n", color, current_id, nc, $0
    }
    '
}

# ======================== live (single instance) ========================

cmd_live_single() {
    local id="$1"
    local log_file=$(get_chrome_log "$id")

    if [ ! -f "$log_file" ]; then
        echo -e "${RED}实例 #${id} 的日志文件不存在${NC}"
        exit 1
    fi

    echo -e "${BOLD}实时监控实例 #${id}（Ctrl+C 退出）${NC}"
    echo ""

    tail -f "$log_file" | awk '
    {
        if ($0 ~ /\[ERROR\]/) printf "\033[0;31m%s\033[0m\n", $0
        else if ($0 ~ /\[WARN\]/) printf "\033[1;33m%s\033[0m\n", $0
        else if ($0 ~ /\[OK\]/) printf "\033[0;32m%s\033[0m\n", $0
        else if ($0 ~ /\[STEP [0-9]+\]/) printf "\033[0;36m%s\033[0m\n", $0
        else print $0
    }
    '
}

# ======================== steps (filter step logs only) ========================

cmd_steps() {
    local target="${1:-all}"
    local ids

    if [ "$target" = "all" ]; then
        ids=$(get_all_instance_ids)
    else
        ids="$target"
    fi

    if [ -z "$ids" ]; then
        echo -e "${YELLOW}没有找到任何实例${NC}"
        return
    fi

    echo -e "${BOLD}步骤执行日志（仅 [STEP] 条目，Ctrl+C 退出）${NC}"
    echo ""

    local log_files=()
    for id in $ids; do
        local log_file=$(get_chrome_log "$id")
        [ -f "$log_file" ] && log_files+=("$log_file")
    done

    tail -f "${log_files[@]}" 2>/dev/null | grep --line-buffered '\[STEP [0-9]*\]' | awk '
    /^==> / {
        match($0, /chrome-([0-9]+)\.log/, arr)
        if (arr[1] != "") current_id = arr[1]
        next
    }
    {
        nc = "\033[0m"
        if ($0 ~ /\[ERROR\]/) color = "\033[0;31m"
        else if ($0 ~ /\[WARN\]/) color = "\033[1;33m"
        else if ($0 ~ /\[OK\]/) color = "\033[0;32m"
        else color = "\033[0;36m"
        printf "\033[2m[#%s]\033[0m %s%s%s\n", current_id, color, $0, nc
    }
    '
}

# ======================== errors ========================

cmd_errors() {
    local target="${1:-all}"
    local ids

    if [ "$target" = "all" ]; then
        ids=$(get_all_instance_ids)
    else
        ids="$target"
    fi

    if [ -z "$ids" ]; then
        echo -e "${YELLOW}没有找到任何实例${NC}"
        return
    fi

    echo -e "${BOLD}错误和警告日志（Ctrl+C 退出）${NC}"
    echo ""

    local log_files=()
    for id in $ids; do
        local log_file=$(get_chrome_log "$id")
        [ -f "$log_file" ] && log_files+=("$log_file")
    done

    tail -f "${log_files[@]}" 2>/dev/null | grep --line-buffered -E '\[(ERROR|WARN)\]' | awk '
    /^==> / {
        match($0, /chrome-([0-9]+)\.log/, arr)
        if (arr[1] != "") current_id = arr[1]
        next
    }
    {
        nc = "\033[0m"
        if ($0 ~ /\[ERROR\]/) color = "\033[0;31m"
        else color = "\033[1;33m"
        printf "\033[2m[#%s]\033[0m %s%s%s\n", current_id, color, $0, nc
    }
    '
}

# ======================== summary ========================

cmd_summary() {
    local ids=$(get_all_instance_ids)
    if [ -z "$ids" ]; then
        echo -e "${YELLOW}没有找到任何实例${NC}"
        return
    fi

    local today=$(date +%Y-%m-%d)

    echo ""
    echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}  Codex OAuth Automation — 运行摘要  $(date '+%Y-%m-%d %H:%M:%S')${NC}"
    echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo ""

    for id in $ids; do
        local chrome_status=$(supervisorctl status "$(get_chrome_name "$id")" 2>/dev/null | awk '{print $2}' || echo "?")
        local log_file=$(get_chrome_log "$id")
        local color_idx=$(( (id - 1) % ${#COLORS[@]} ))
        local color="${COLORS[$color_idx]}"

        # 状态图标
        local status_icon="❌"
        [[ "$chrome_status" == "RUNNING" ]] && status_icon="✅"

        echo -e "${color}${BOLD}  ▸ 实例 #${id}  ${status_icon} ${chrome_status}${NC}"

        if [ ! -f "$log_file" ]; then
            echo -e "    ${DIM}暂无日志${NC}"
            echo ""
            continue
        fi

        # 今日统计
        local ok_count=$(grep -c "${today}.*\[OK\]" "$log_file" 2>/dev/null || echo "0")
        local err_count=$(grep -c "${today}.*\[ERROR\]" "$log_file" 2>/dev/null || echo "0")
        local warn_count=$(grep -c "${today}.*\[WARN\]" "$log_file" 2>/dev/null || echo "0")
        local step_count=$(grep -c "${today}.*\[STEP" "$log_file" 2>/dev/null || echo "0")

        echo -e "    今日统计: ${GREEN}✓ ${ok_count} 成功${NC}  ${RED}✗ ${err_count} 错误${NC}  ${YELLOW}⚠ ${warn_count} 警告${NC}  步骤 ${step_count} 条"

        # 最近 3 条步骤日志
        local recent=$(grep -E '\[STEP [0-9]+\]' "$log_file" 2>/dev/null | tail -3)
        if [ -n "$recent" ]; then
            echo -e "    最近步骤:"
            echo "$recent" | while IFS= read -r line; do
                local level_color="$NC"
                [[ "$line" =~ \[ERROR\] ]] && level_color="$RED"
                [[ "$line" =~ \[WARN\] ]] && level_color="$YELLOW"
                [[ "$line" =~ \[OK\] ]] && level_color="$GREEN"
                echo -e "      ${DIM}│${NC} ${level_color}${line}${NC}"
            done
        fi

        # 最近一条错误
        local last_error=$(grep -E '\[ERROR\]' "$log_file" 2>/dev/null | tail -1)
        if [ -n "$last_error" ]; then
            echo -e "    ${RED}最近错误: ${last_error}${NC}"
        fi

        echo ""
    done

    echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
}

# ======================== help ========================

cmd_help() {
    echo ""
    echo "Codex OAuth Automation — 多实例监控"
    echo ""
    echo "用法: $0 <命令> [参数]"
    echo ""
    echo "命令:"
    echo "  (无参数)             实时监控所有实例日志（合并流，彩色标记）"
    echo "  <id>                 实时监控指定实例日志"
    echo "  status               查看所有实例进程状态和今日统计"
    echo "  steps [id|all]       仅显示步骤执行日志（过滤噪音）"
    echo "  errors [id|all]      仅显示错误和警告"
    echo "  summary              输出各实例运行摘要（今日统计 + 最近步骤 + 最近错误）"
    echo ""
    echo "示例:"
    echo "  $0                   # 实时监控所有实例"
    echo "  $0 3                 # 仅监控实例 3"
    echo "  $0 steps             # 所有实例的步骤日志"
    echo "  $0 steps 2           # 实例 2 的步骤日志"
    echo "  $0 errors            # 所有实例的错误"
    echo "  $0 summary           # 运行摘要"
    echo "  $0 status            # 进程状态表"
    echo ""
}

# ======================== 入口 ========================

case "${1:-}" in
    "")        cmd_live_all             ;;
    status)    cmd_status               ;;
    steps)     cmd_steps "${2:-all}"    ;;
    errors)    cmd_errors "${2:-all}"   ;;
    summary)   cmd_summary             ;;
    help|--help|-h) cmd_help           ;;
    *)
        if [[ "$1" =~ ^[0-9]+$ ]]; then
            cmd_live_single "$1"
        else
            echo -e "${RED}未知命令: $1${NC}"
            cmd_help
            exit 1
        fi
        ;;
esac
