#!/usr/bin/env bash
# dsh-voice-spacehold 体检：DSH 升级/重装/换 profile 之后，跑一下这个脚本，
# 就知道是「插件没装回去」还是「页面里的 DOM 契约变了」。
#
#   bash tools/doctor.sh
#
# 只读检查，不改任何文件。
set -u

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_NAME="dsh-voice-spacehold"
# 注意：DSH 自己会导出 DSH_PROFILE=desktop（相对名），这里要把它拼成绝对路径。
# 没有环境变量时，优先找「已经登记了本插件」的 profile，其次找一个唯一的 profile，最后退回 desktop。
if [ -z "${SPACEHOLD_PROFILE:-}" ]; then
  case "${DSH_PROFILE:-}" in
    /*) SPACEHOLD_PROFILE="$DSH_PROFILE" ;;
    ?*) SPACEHOLD_PROFILE="$HOME/.dsh/profiles/$DSH_PROFILE" ;;
  esac
fi
if [ -z "${SPACEHOLD_PROFILE:-}" ]; then
  for candidate in "$HOME"/.dsh/profiles/*/package.json; do
    [ -f "$candidate" ] || continue
    if grep -q "$PLUGIN_NAME" "$candidate" 2>/dev/null; then
      SPACEHOLD_PROFILE="$(dirname "$candidate")"
      break
    fi
  done
fi
if [ -z "${SPACEHOLD_PROFILE:-}" ]; then
  set -- "$HOME"/.dsh/profiles/*/
  if [ -f "${1:-}/package.json" ] && [ ! -f "${2:-}/package.json" ]; then
    SPACEHOLD_PROFILE="${1%/}"
  fi
fi
PROFILE="${SPACEHOLD_PROFILE:-$HOME/.dsh/profiles/desktop}"
NODE="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node || true)"

ok=0
fail=0
say() { printf '%s %s\n' "$1" "$2"; }
pass() { ok=$((ok + 1)); say '✅' "$1"; }
fail_() { fail=$((fail + 1)); say '❌' "$1"; [ -n "${2:-}" ] && printf '   → %s\n' "$2"; }

echo "插件目录: $PLUGIN_DIR"
echo "profile  : $PROFILE"
echo

# 1. 插件文件还在吗
[ -f "$PLUGIN_DIR/lib/client.js" ] && pass "lib/client.js 在" \
  || fail_ "lib/client.js 不见了" "从备份/仓库恢复整个插件目录"

if [ -n "$NODE" ] && [ -f "$PLUGIN_DIR/lib/client.js" ]; then
  "$NODE" --check "$PLUGIN_DIR/lib/client.js" >/dev/null 2>&1 && pass "client.js 语法正常" \
    || fail_ "client.js 语法错误" "$NODE --check $PLUGIN_DIR/lib/client.js"
fi

# 2. 符号链接
link="$PROFILE/node_modules/$PLUGIN_NAME"
if [ -L "$link" ]; then
  target="$(readlink "$link")"
  [ "$target" = "$PLUGIN_DIR" ] && pass "node_modules 符号链接指向本目录" \
    || pass "node_modules 符号链接指向 $target（github/npm 安装时正常）"
elif [ -e "$link" ]; then
  pass "node_modules/$PLUGIN_NAME 已安装（真实目录，github/npm 安装时正常）"
else
  fail_ "node_modules/$PLUGIN_NAME 不存在" "ln -sfn $PLUGIN_DIR $link"
fi

# 3. profile/package.json 里的两处登记
if [ -f "$PROFILE/package.json" ]; then
  python3 - "$PROFILE/package.json" "$PLUGIN_NAME" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(path, encoding='utf8'))
except Exception as error:
    print(f'❌ package.json 解析失败: {error}')
    sys.exit(2)
deps = data.get('dependencies') or {}
bundles = ((data.get('dsh') or {}).get('profile') or {}).get('bundles') or []
if name in deps:
    print(f'✅ dependencies 里有 {name}')
else:
    print(f'❌ dependencies 里没有 {name}')
    print(f'   → 加一行 "{name}": "link:<插件目录>"')
if name in bundles:
    print(f'✅ dsh.profile.bundles 里有 {name}')
else:
    print(f'❌ dsh.profile.bundles 里没有 {name}')
    print(f'   → 在 bundles 数组末尾追加 "{name}"')
PY
  rc=$?
  if [ $rc -ne 0 ]; then fail_ "profile/package.json 有问题" "见上"; fi
else
  fail_ "profile/package.json 不存在" "DSH 可能换了 profile 目录，用 SPACEHOLD_PROFILE=... 重跑"
fi

echo
echo "以上是「装没装上」。要确认「页面里还能不能用」，跑真机探针："
echo "  env -u ELECTRON_RUN_AS_NODE \\"
echo "    ~/.dsh/electron/Electron.app/Contents/MacOS/Electron \\"
echo "    $PLUGIN_DIR/tools/probe.cjs"
echo
echo "探针需要当前 GUI 的地址和 cookie（见 README）。如果探针里出现"
echo "「找不到听写按钮」「原语音插件进入 recording」失败，说明 DSH 升级改了"
echo "语音插件的 DOM/文案，只需改 lib/client.js 里的 TRIGGER_LABELS 和选择器。"

exit $(( fail > 0 ? 1 : 0 ))
