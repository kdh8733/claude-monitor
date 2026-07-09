#!/usr/bin/env bash
# M4: 수집기 죽음 관측. crontab 이 하루 한 번 부른다.
# 정책: 건강하면 조용히 종료한다(스팸 방지). 건강하지 않을 때만 한 줄 보고한다.
#       "한도 임박 알림"이 아니다 - 그건 ROADMAP 이 보류했다. 이건 파이프라인 무결성이다.
#
# 텔레그램 전송은 선택이다. CLAUDE_MONITOR_SECRETS 에 TELEGRAM_BOT_TOKEN 과
# TELEGRAM_CHAT_ID(또는 TELEGRAM_CHANNEL_CLAUDE)를 담은 파일 경로를 주면 보낸다.
# 없으면 stdout 에만 낸다. 공개 레포이므로 시크릿 경로를 코드에 굳히지 않는다.
set -uo pipefail

export HOME="${HOME:-/root}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

NODE="${CLAUDE_MONITOR_NODE:-$(command -v node || true)}"
if [[ -z "$NODE" ]]; then
    for candidate in "$HOME"/.nvm/versions/node/*/bin/node /usr/local/bin/node /usr/bin/node; do
        [[ -x "$candidate" ]] && NODE="$candidate" && break
    done
fi
[[ -x "$NODE" ]] || { echo "node not found" >&2; exit 1; }

cd "$REPO"
REPORT="$("$NODE" collector/health-main.ts)"
STATUS=$?

echo "$REPORT"
[[ $STATUS -eq 0 ]] && exit 0   # 건강함 - 조용히 종료

SECRETS="${CLAUDE_MONITOR_SECRETS:-}"
[[ -n "$SECRETS" && -f "$SECRETS" ]] || exit 1   # 보낼 곳이 없다. 로그에는 남았다.

python3 - "$REPORT" "$SECRETS" <<'PY'
import sys, urllib.request, urllib.parse
from pathlib import Path
text = "claude-monitor: " + sys.argv[1]
env = {}
for line in Path(sys.argv[2]).read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
token = env["TELEGRAM_BOT_TOKEN"]
chat = env.get("TELEGRAM_CHANNEL_CLAUDE") or env["TELEGRAM_CHAT_ID"]
api = f"https://api.telegram.org/bot{token}/sendMessage"
data = urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()
try:
    urllib.request.urlopen(urllib.request.Request(api, data=data), timeout=30)
except Exception as e:
    print("send fail:", e, file=sys.stderr)
PY
exit 1
