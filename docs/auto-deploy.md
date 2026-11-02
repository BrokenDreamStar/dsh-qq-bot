# 自动部署

推送到 Gitea 的 `main` 分支后，192.168.5.17 上的 `dsh-autodeploy.timer` 每 30 秒检查一次三个仓库的 `origin/main`，发现新提交就执行 `~/deploy-dsh.sh`：

```
git pull --ff-only → npm install / npm ci → npm run build → npm test → sudo systemctl restart dsh
```

任何一步失败都会中止，不会带着失败的构建重启 dsh。

## 涉及的仓库

- `starm/dsh-qq-bot`
- `starm/dsh-deepseek-peak-reminder`
- `starm/dsh-deepseek-status-monitor`

## 使用

```bash
git push gitea main
```

推送后最多约 30 秒自动生效。`./deploy.sh` 仍然可用：它推送后会立即通过 SSH 触发部署并回显日志，适合需要马上看到结果的时候；它与自动部署共用 `flock`，不会并发执行。

## 查看状态与日志

```bash
systemctl list-timers dsh-autodeploy.timer
journalctl -u dsh-autodeploy.service -n 50
tail -f ~/autodeploy.log   # 发现变更的记录
tail -f ~/deploy.log       # 构建/测试/重启的完整日志
```

## 手动触发一次检查

```bash
sudo systemctl start dsh-autodeploy.service
```

## 注意

- 只检查 `main` 分支；推送其他分支不会触发部署。
- 远端工作区如果有未提交改动，`git pull --ff-only` 会失败并中止本次部署（这是刻意的保护）。
- 部署脚本自身带 `flock`，手动部署与自动部署不会同时跑。
- 定时器由 systemd 管理，随 dsh 主机开机自启。
