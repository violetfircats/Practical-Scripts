#!/bin/bash
# ============================================================
# IP变化检测 + 携趣白名单自动更新脚本 (ql-bot-manager适配版)
# 项目：青龙钉钉机器人管理器 (ql-bot-manager)
# 用途：检测公网IP变化并自动更新代理商白名单
# 环境：青龙面板 + N1设备优化
# 建议定时：0 * * * * (每小时整点检测一次)
# ============================================================

# ============ 环境变量配置 ============
# 优先从青龙环境变量读取，支持在青龙面板中统一管理
# 在青龙面板 -> 环境变量 中添加以下变量：
#   XIEQU_UID      - 携趣代理UID
#   XIEQU_UKEY     - 携趣代理密钥
#   DEVICE_NAME    - 设备名称（可选，用于备注）

# 携趣代理配置（优先环境变量，其次使用默认值）
XIEQU_UID="${XIEQU_UID:-147443}"
XIEQU_UKEY="${XIEQU_UKEY:-A075D90D4FDA300CFC31F93D6609BAD0}"
XIEQU_API="http://op.xiequ.cn/IpWhiteList.aspx"

# 设备标识（用于白名单备注，重要：用于识别本设备添加的IP）
DEVICE_NAME="${DEVICE_NAME:-N1}"
DEVICE_TAG="${DEVICE_NAME}-AUTO"  # 固定标识前缀，用于识别自动添加的IP

# 本地配置
IP_FILE="/ql/data/scripts/last_ip.txt"
LOG_FILE="/ql/data/log/ip_monitor.log"
LOG_PREFIX="[IP监控]"
MAX_LOG_LINES=500  # 日志最大保留行数（N1优化）

# 超时配置（N1网络优化）
CURL_TIMEOUT=8
CURL_RETRY=2

# ============ 配置结束 ============

# 确保日志目录存在
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null
mkdir -p "$(dirname "$IP_FILE")" 2>/dev/null

# 日志函数（同时输出到控制台和文件）
log() {
    local msg="$(date '+%Y-%m-%d %H:%M:%S') $LOG_PREFIX $1"
    echo "$msg"
    echo "$msg" >> "$LOG_FILE" 2>/dev/null
}

# 日志轮转（防止日志文件过大，适配N1存储限制）
rotate_log() {
    if [ -f "$LOG_FILE" ]; then
        local lines=$(wc -l < "$LOG_FILE" 2>/dev/null || echo "0")
        if [ "$lines" -gt "$MAX_LOG_LINES" ]; then
            tail -n "$((MAX_LOG_LINES / 2))" "$LOG_FILE" > "${LOG_FILE}.tmp" 2>/dev/null
            mv "${LOG_FILE}.tmp" "$LOG_FILE" 2>/dev/null
            log "日志已轮转，保留最近 $((MAX_LOG_LINES / 2)) 行"
        fi
    fi
}

# 获取当前公网IP（多接口备用，适配国内网络）
get_current_ip() {
    local ip=""
    local apis=(
        "http://ip.sb"
        "http://ifconfig.me"
        "http://ip.3322.net"
        "http://myip.ipip.net"
        "http://ipecho.net/plain"
    )
    
    for api in "${apis[@]}"; do
        ip=$(curl -s --connect-timeout "$CURL_TIMEOUT" --max-time "$((CURL_TIMEOUT + 2))" "$api" 2>/dev/null | tr -d '\n\r ')
        # 验证IP格式
        if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            echo "$ip"
            return 0
        fi
    done
    
    echo ""
    return 1
}

# 发送通知（使用青龙面板通知模块，复用已配置的所有渠道）
send_notify() {
    local title="$1"
    local content="$2"
    
    # 查找sendNotify.js模块
    local notify_path=""
    if [ -f "/ql/data/deps/sendNotify.js" ]; then
        notify_path="/ql/data/deps/sendNotify"
    elif [ -f "/ql/data/scripts/sendNotify.js" ]; then
        notify_path="/ql/data/scripts/sendNotify"
    else
        log "未找到青龙通知模块"
        return 1
    fi
    
    # 创建临时JS文件调用通知（避免引号转义问题）
    local tmp_js="/tmp/ip_notify_$$.js"
    cat > "$tmp_js" << EOF
const notify = require("$notify_path");
notify.sendNotify("$title", \`$content\`).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
EOF
    
    node "$tmp_js" 2>/dev/null
    local result=$?
    rm -f "$tmp_js"
    
    if [ $result -eq 0 ]; then
        log "通知发送成功"
        return 0
    else
        log "通知发送失败"
        return 1
    fi
}

# 获取当前白名单（JSON格式，便于解析）
get_whitelist() {
    curl -s --connect-timeout "$CURL_TIMEOUT" "${XIEQU_API}?uid=${XIEQU_UID}&ukey=${XIEQU_UKEY}&act=getjson" 2>/dev/null
}

# 删除旧IP白名单
delete_whitelist() {
    local old_ip="$1"
    log "删除旧白名单: $old_ip"
    
    local result
    for i in $(seq 1 $CURL_RETRY); do
        result=$(curl -s --connect-timeout "$CURL_TIMEOUT" "${XIEQU_API}?uid=${XIEQU_UID}&ukey=${XIEQU_UKEY}&act=del&ip=${old_ip}" 2>/dev/null)
        if [ -n "$result" ]; then
            break
        fi
        sleep 1
    done
    
    log "删除结果: ${result:-请求失败}"
}

# 添加新IP白名单（使用固定唯一备注）
add_whitelist() {
    local new_ip="$1"
    # 备注格式: N1-AUTO (固定唯一标识，用于识别本设备添加的IP)
    local memo="${DEVICE_TAG}"
    log "添加新白名单: $new_ip (备注: $memo)"
    
    local result
    for i in $(seq 1 $CURL_RETRY); do
        result=$(curl -s --connect-timeout "$CURL_TIMEOUT" "${XIEQU_API}?uid=${XIEQU_UID}&ukey=${XIEQU_UKEY}&act=add&ip=${new_ip}&meno=${memo}" 2>/dev/null)
        if [ -n "$result" ]; then
            break
        fi
        sleep 1
    done
    
    log "添加结果: ${result:-请求失败}"
    echo "$result"
}

# 根据备注标识查找并删除本设备添加的旧IP
cleanup_device_ips() {
    local current_ip="$1"
    local whitelist=$(get_whitelist)
    
    if [ -z "$whitelist" ] || [ "$whitelist" = "[]" ] || [ "$whitelist" = '{"data":[]}' ]; then
        log "白名单为空或获取失败"
        return 1
    fi
    
    log "检查白名单中本设备($DEVICE_TAG)添加的IP..."
    
    # 解析JSON格式白名单，查找包含本设备标识的条目
    # JSON格式: {"data":[{"IP":"1.2.3.4","MEMO":"N1-AUTO"}]} 注意字段是大写
    local old_ips=$(echo "$whitelist" | grep -oE '"IP":"[0-9.]+"' | sed 's/"IP":"//g' | sed 's/"//g')
    local memos=$(echo "$whitelist" | grep -oE '"MEMO":"[^"]*"' | sed 's/"MEMO":"//g' | sed 's/"//g')
    
    # 将IP和备注转换为数组
    local ip_array=()
    local memo_array=()
    while IFS= read -r line; do
        [ -n "$line" ] && ip_array+=("$line")
    done <<< "$old_ips"
    while IFS= read -r line; do
        [ -n "$line" ] && memo_array+=("$line")
    done <<< "$memos"
    
    local deleted_count=0
    log "白名单中共 ${#ip_array[@]} 条记录"
    for i in "${!ip_array[@]}"; do
        local ip="${ip_array[$i]}"
        local memo="${memo_array[$i]:-}"
        
        # 检查备注是否包含本设备标识，且IP不是当前IP
        if [[ "$memo" == *"$DEVICE_TAG"* ]] && [ "$ip" != "$current_ip" ]; then
            log "发现本设备旧IP: $ip (备注: $memo)，正在删除..."
            delete_whitelist "$ip"
            ((deleted_count++))
            sleep 1
        fi
    done
    
    if [ $deleted_count -eq 0 ]; then
        log "未找到需要删除的本设备旧IP"
    else
        log "已删除 $deleted_count 条本设备旧IP记录"
    fi
    
    return 0
}

# 更新白名单（带完整错误处理）
update_whitelist() {
    local old_ip="$1"
    local new_ip="$2"
    
    log "开始更新携趣白名单..."
    
    # 根据备注标识清理本设备的所有旧IP（更可靠）
    cleanup_device_ips "$new_ip"
    
    # 如果传入了旧IP且与新IP不同，也尝试删除（双重保障）
    if [ -n "$old_ip" ] && [ "$old_ip" != "$new_ip" ]; then
        delete_whitelist "$old_ip"
        sleep 1
    fi
    
    # 添加新IP
    local add_result=$(add_whitelist "$new_ip")
    
    # 检查是否成功（支持多种返回格式）
    if echo "$add_result" | grep -qiE "成功|SUCCESS|ok|添加成功"; then
        log "白名单更新成功!"
        return 0
    elif echo "$add_result" | grep -qiE "IpRep"; then
        log "IP已存在于白名单中"
        return 0
    elif [ -z "$add_result" ]; then
        log "白名单更新失败: 网络请求无响应"
        return 1
    else
        log "白名单更新可能失败: $add_result"
        return 1
    fi
}

# 检查网络连通性
check_network() {
    if curl -s --connect-timeout 3 "http://www.baidu.com" >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

# 检查IP是否在白名单中（同时检查是否是本设备添加的）
check_ip_in_whitelist() {
    local ip="$1"
    local whitelist=$(get_whitelist)
    
    if [ -z "$whitelist" ] || [ "$whitelist" = "[]" ] || [ "$whitelist" = '{"data":[]}' ]; then
        log "白名单为空或获取失败"
        return 1  # 获取失败，假设不在白名单中
    fi
    
    # 检查IP是否在白名单中（JSON格式，字段是大写的）
    if echo "$whitelist" | grep -q "\"IP\":\"$ip\""; then
        # 进一步检查是否是本设备添加的
        if echo "$whitelist" | grep -qi "$DEVICE_TAG"; then
            log "IP在白名单中，且为本设备添加"
        else
            log "IP在白名单中，但非本设备添加"
        fi
        return 0  # IP在白名单中
    else
        return 1  # IP不在白名单中
    fi
}

# 主逻辑
main() {
    log "============================================"
    log "开始检测公网IP..."
    log "设备: $DEVICE_NAME | 时区: ${TZ:-Asia/Shanghai}"
    
    # 日志轮转
    rotate_log
    
    # 检查网络连通性
    if ! check_network; then
        log "网络不通，跳过本次检测"
        log "检测完成"
        log "============================================"
        exit 0
    fi
    
    # 获取当前IP
    current_ip=$(get_current_ip)
    
    if [ -z "$current_ip" ]; then
        log "获取公网IP失败，请检查网络"
        exit 1
    fi
    
    log "当前公网IP: $current_ip"
    
    # 读取上次保存的IP
    if [ -f "$IP_FILE" ]; then
        last_ip=$(cat "$IP_FILE" 2>/dev/null | tr -d '\n\r ')
    else
        last_ip=""
    fi
    
    # 对比IP
    if [ "$current_ip" != "$last_ip" ]; then
        local message=""
        local change_type=""
        
        if [ -z "$last_ip" ]; then
            log "首次记录IP: $current_ip"
            message="🌐 首次记录公网IP

══════════════════
💻 设备: $DEVICE_NAME
🌍 当前IP: $current_ip
══════════════════"
            change_type="首次记录"
        else
            log "IP已变化! 旧IP: $last_ip -> 新IP: $current_ip"
            message="🔄 公网IP已变化

══════════════════
💻 设备: $DEVICE_NAME
❌ 旧IP: $last_ip
✅ 新IP: $current_ip
══════════════════"
            change_type="IP变化"
        fi
        
        # 更新携趣白名单
        update_whitelist "$last_ip" "$current_ip"
        whitelist_status=$?
        
        if [ $whitelist_status -eq 0 ]; then
            message="$message

✅ 携趣白名单已自动更新"
        else
            message="$message

⚠️ 携趣白名单更新失败"
        fi
        
        # 保存新IP
        echo "$current_ip" > "$IP_FILE"
        
        # 发送通知
        message="$message

⏰ 时间: $(date '+%Y-%m-%d %H:%M:%S')"
        send_notify "[$DEVICE_NAME] $change_type" "$message"
    else
        log "IP未变化: $current_ip"
        
        # IP未变化时，检查是否在白名单中（防止被手动删除），但不发通知
        log "验证IP是否在白名单中..."
        if ! check_ip_in_whitelist "$current_ip"; then
            log "IP不在白名单中，自动添加..."
            add_whitelist "$current_ip"
        else
            log "IP已在白名单中，无需操作"
        fi
    fi
    
    log "检测完成"
    log "============================================"
}

# 支持命令行参数
case "${1:-}" in
    --check|check)
        # 仅检查当前IP，不更新
        echo "当前公网IP: $(get_current_ip)"
        ;;
    --whitelist|whitelist)
        # 查看当前白名单
        echo "当前白名单:"
        get_whitelist
        ;;
    --force|force)
        # 强制更新白名单
        current_ip=$(get_current_ip)
        if [ -n "$current_ip" ]; then
            echo "强制更新白名单: $current_ip"
            add_whitelist "$current_ip"
            echo "$current_ip" > "$IP_FILE"
        else
            echo "获取IP失败"
        fi
        ;;
    --help|help|-h)
        echo "用法: $0 [选项]"
        echo ""
        echo "选项:"
        echo "  (无参数)     正常检测并更新IP"
        echo "  --check     仅检查当前公网IP"
        echo "  --whitelist 查看当前白名单"
        echo "  --force     强制更新白名单"
        echo "  --help      显示帮助信息"
        echo ""
        echo "环境变量:"
        echo "  XIEQU_UID      携趣代理UID"
        echo "  XIEQU_UKEY     携趣代理密钥"
        echo "  DEVICE_NAME    设备名称（默认: N1）"
        echo "  DINGTALK_WEBHOOK  钉钉Webhook（可选）"
        ;;
    *)
        main
        ;;
esac
