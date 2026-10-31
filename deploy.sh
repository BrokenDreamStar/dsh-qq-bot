#!/usr/bin/env bash
# 一键更新：把三个插件提交并推送到局域网 Gitea，然后让远端拉取、构建、测试并重启 dsh。
# 用法：./deploy.sh            （自动提交当前改动）
#       DSH_DEPLOY_REMOTE=... ./deploy.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE="${DSH_DEPLOY_REMOTE:-192.168.5.17}"

for repo in dsh-qq-bot dsh-deepseek-peak-reminder dsh-deepseek-status-monitor; do
	echo "== $repo"
	cd "$ROOT/$repo"
	git add -A
	if ! git diff --cached --quiet; then
		git commit -m "deploy: $(date '+%F %T')"
	fi
	git push gitea main
done

echo "== remote deploy ($REMOTE)"
ssh "$REMOTE" '~/deploy-dsh.sh; code=$?; tail -n 20 ~/deploy.log; exit $code'
