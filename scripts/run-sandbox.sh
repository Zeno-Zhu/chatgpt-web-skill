#!/usr/bin/env bash
# run-sandbox.sh — 受限沙箱环境下的一次性全链路 runner
#
# 为什么需要它：WorkBuddy 这类沙箱会在**工具调用结束时回收 GUI 子进程**，
# 由脚本拉起的 Chrome 活不过调用边界。所以 "launch → 下次调用再 send" 必然失败，
# 必须把 launch / 就绪轮询 / new / send / wait / read 压在同一次调用里跑完。
#
# 用法：
#   bash scripts/run-sandbox.sh --text-file <prompt.md 绝对路径> [选项]
#   bash scripts/run-sandbox.sh --check            # 只做 launch + 登录就绪检查，不发送
#
# 选项：
#   --text-file <path>   提问内容文件（必填，除非 --check）；支持 C:/ 与 /c/ 两种写法
#   --text <string>      直接把提问当参数（短问题用；与 --text-file 二选一）
#   --file <path>        附件，可重复
#   --out <dir>          产物目录（默认 $PWD/chatgpt-out）；自动转成 C:/ 形式
#   --request-id <id>    本次请求 id（默认自动生成）
#   --timeout <秒>       wait 的超时（默认 300）
#   --cdp <端口>         CDP 端口（默认 9444）
#   --check              只检查连通性与登录态
set -u

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SKILL_DIR" || exit 1

CDP=9444
TIMEOUT=300
OUT=""
TEXT_FILE=""
TEXT=""
REQ=""
FILES=()
CHECK=0

# Git Bash 的 /c/Users/x → C:/Users/x（给 Windows 程序必须用盘符形式）
winpath() {
  case "$1" in
    /[a-zA-Z]/*) printf '%s:/%s' "$(printf '%s' "${1:1:1}" | tr 'a-z' 'A-Z')" "${1:3}" ;;
    *) printf '%s' "$1" ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --text-file) TEXT_FILE="$(winpath "$2")"; shift 2 ;;
    --text)      TEXT="$2"; shift 2 ;;
    --file)      FILES+=("--file" "$(winpath "$2")"); shift 2 ;;
    --out)       OUT="$(winpath "$2")"; shift 2 ;;
    --request-id) REQ="$2"; shift 2 ;;
    --timeout)   TIMEOUT="$2"; shift 2 ;;
    --cdp)       CDP="$2"; shift 2 ;;
    --check)     CHECK=1; shift ;;
    -h|--help)   sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

[ -n "$OUT" ] || OUT="$(winpath "$PWD")/chatgpt-out"
[ -n "$REQ" ] || REQ="req-$(date +%Y%m%d-%H%M%S)"
export CHATGPT_OUT_DIR="$OUT"
mkdir -p "$OUT"

alive() { netstat -ano 2>/dev/null | grep -q "${CDP}.*LISTENING"; }
step() { echo; echo "======== $* ========"; }

step "1) 确保可调试 Chrome（CDP $CDP）"
if alive; then
  echo "已有可调试实例，复用"
else
  LO=""
  for i in 1 2 3 4 5 6; do
    LO=$(node scripts/chatgpt.mjs launch 2>&1)
    sleep 4
    alive && { echo "launch 成功（第 $i 次）"; break; }
    echo "第 $i 次未就绪"
  done
  if ! alive; then
    echo "$LO" | grep -q 'PROFILE_IN_USE' && {
      echo "profile 正被一个不带调试端口的浏览器占用 —— 这是 ask-user 出口，不要杀用户浏览器。"
      echo "请用户关掉那个窗口，或让用户自己带参启动："
      echo "  chrome.exe --remote-debugging-port=$CDP --user-data-dir=\"<profile 目录>\" --profile-directory=Default"
    }
    echo "$LO" | head -20
    exit 1
  fi
fi

step "2) 等待登录就绪（status 的 loggedIn 有误报，须轮询）"
LOGGED=0
for i in $(seq 1 12); do
  S=$(node scripts/chatgpt.mjs status 2>&1)
  printf 'status[%s]: loggedIn=%s  title=%s\n' "$i" \
    "$(echo "$S" | grep -o '"loggedIn": *[a-z]*' | head -1 | sed 's/.*: *//')" \
    "$(echo "$S" | grep -o '"title": *"[^"]*"' | head -1 | sed 's/.*: *//')"
  echo "$S" | grep -q '"loggedIn": true' && { LOGGED=1; break; }
  sleep 4
done
if [ "$LOGGED" != 1 ]; then
  echo "轮询后仍非 true。用 init 探测交叉验证（chatgptTrace 是更可靠的登录证据）："
  node scripts/chatgpt.mjs init 2>&1 | grep -iE 'userDataDir|profileDirectory|chatgptTrace|cookiesLocked' | head -12
  echo "按异常路由：NOT_LOGGED_IN 属 ask-user 出口 —— 让用户在被打开的窗口里登录，不要代劳。"
  exit 2
fi
echo "登录态确认 OK"

if [ "$CHECK" = 1 ]; then
  step "check 模式：到此为止（未发送任何消息）"
  exit 0
fi

if [ -z "$TEXT_FILE" ] && [ -z "$TEXT" ]; then
  echo "缺少 --text-file 或 --text（或加 --check 只做连通性检查）"; exit 2
fi

step "3) 开新会话"
node scripts/chatgpt.mjs new 2>&1 | grep -E '"ok"|"error"|"conversationId"|"url"|"code"'

step "4) 发送"
if [ -n "$TEXT_FILE" ]; then
  node scripts/chatgpt.mjs send --request-id "$REQ" --text-file "$TEXT_FILE" ${FILES[@]+"${FILES[@]}"} --json 2>&1 \
    | grep -E '"submitted"|"uploadedCount"|"pendingText"|"conversationId"|"error"|"code"'
else
  node scripts/chatgpt.mjs send --request-id "$REQ" --text "$TEXT" ${FILES[@]+"${FILES[@]}"} --json 2>&1 \
    | grep -E '"submitted"|"uploadedCount"|"pendingText"|"conversationId"|"error"|"code"'
fi

step "5) 等待回答（最长 ${TIMEOUT}s）"
node scripts/chatgpt.mjs wait --timeout "$TIMEOUT" --json 2>&1 \
  | grep -E '"status"|"done"|"responseChars"|"error"|"code"'

step "6) 取回并落盘 Markdown"
node scripts/chatgpt.mjs read --request-id "$REQ" --md --json 2>&1 | grep -vE '^\s*"text"' | head -30

step "7) 产物目录 $OUT"
ls -la "$OUT" 2>/dev/null | head -20
