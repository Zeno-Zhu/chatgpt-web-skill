#!/usr/bin/env bash
# chatgpt-web · 一键安装到各个 agent 的 skill 目录
#
# 用法:
#   bash scripts/install.sh                 # 安装到检测到的所有 agent
#   bash scripts/install.sh --dry-run       # 只打印将做什么，不改动任何文件
#   bash scripts/install.sh --only dsh      # 只装到指定宿主
#   bash scripts/install.sh --agent trae    # 顺手写入该宿主的实例名配置
#
# 设计原则:
#   - 只复制能力文件（SKILL/参考/脚本），绝不复制运行数据（tasks/、profile、请求记录）
#   - dry-run 优先，任何覆盖前都会打印目标路径
#   - 找不到宿主不报错，只提示手工路径
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0
ONLY=""
AGENT_NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --agent) AGENT_NAME="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

# 宿主 → skill 目录（按存在与否自动筛选）
declare -a HOSTS=(
  "dsh:$HOME/.dsh/skills"
  "claude:$HOME/.claude/skills"
  "codex:$HOME/.codex/skills"
  "trae:$HOME/.trae/skills"
  "trae-cn:$HOME/.trae-cn/skills"
  "cursor:$HOME/.cursor/skills"
  "workbuddy:$HOME/.workbuddy/skills"
)

FILES=(SKILL.md COORDINATION.md THINKING.md README.md package.json package-lock.json)
DIRS=(scripts references)

run() {
  if [ "$DRY_RUN" = "1" ]; then echo "  [dry-run] $*"; else eval "$@"; fi
}

installed=0
for entry in "${HOSTS[@]}"; do
  name="${entry%%:*}"
  base="${entry#*:}"
  if [ -n "$ONLY" ] && [ "$ONLY" != "$name" ]; then continue; fi
  # 宿主根目录不存在就跳过（除非显式 --only）
  host_root="$(dirname "$base")"
  if [ ! -d "$host_root" ]; then
    [ -n "$ONLY" ] && echo "跳过 $name：$host_root 不存在"
    continue
  fi
  dest="$base/chatgpt-web"
  echo "安装到 $name → $dest"
  run "mkdir -p '$dest'"
  for f in "${FILES[@]}"; do run "cp '$SRC/$f' '$dest/'"; done
  for d in "${DIRS[@]}"; do run "cp -R '$SRC/$d' '$dest/'"; done

  # 依赖：优先离线复用源目录的 node_modules
  if [ -d "$SRC/node_modules" ]; then
    run "cp -R '$SRC/node_modules' '$dest/'"
  else
    run "(cd '$dest' && npm install --offline --no-audit --no-fund || npm install --no-audit --no-fund)"
  fi

  # 可选：为该宿主固定实例名，使各 agent 并行而不互相抢锁
  if [ -n "$AGENT_NAME" ]; then
    printf 'CHATGPT_AGENT=%s\n' "$AGENT_NAME" > "$dest/.env.agent"
    echo "  已写入实例名: $AGENT_NAME"
  fi
  installed=$((installed + 1))
done

echo
if [ "$installed" = "0" ]; then
  echo "没有检测到可安装的宿主。可手工复制到任意位置后直接调用 scripts/chatgpt.mjs。"
else
  echo "完成：$installed 个宿主。"
fi
cat <<'EOF'

下一步（每个宿主都要做一次）：
  1) node <skill>/scripts/chatgpt.mjs doctor     # 预检：能否用 / 缺什么 / 下一步做什么
  2) node <skill>/scripts/chatgpt.mjs launch     # 首次会打开一个自动化 Chrome
  3) 让用户在那个窗口登录一次 ChatGPT（登录态长期有效）
  4) node <skill>/scripts/chatgpt.mjs doctor     # 期望 ready: true

多 agent 并行（可选）：给每个宿主不同的实例名，profile/端口/锁会全部隔离
  export CHATGPT_AGENT=trae
EOF
