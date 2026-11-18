# Runner 1.7 简单发布

状态：ACTIVE

2026-11-19：主打团 `zhudatuan-l0` 与福福网 `l0-2-l0` 已迁到 `47.111.123.210`，普通 Runner 的 SSH 落点使用该地址。目录、实例身份、各目标现有版本与数据库保持继承；`47.96.160.168` 保留数据与版本，旧业务进程及 Tunnel 停用。主打团 HTTPS 由 210 现有 Traefik 按域名透传到独立 LK Caddy，福福网继续使用原 Tunnel。既有“指定目标只发布指定目标、继承同步显式开启”的行为保持。

普通发布只有一个入口：

```text
./02_platform_pingtai/infrastructure/github-actions-runner/zdt-delivery release <full-source-sha>
./02_platform_pingtai/infrastructure/github-actions-runner/zdt-delivery deploy <full-source-sha>
./02_platform_pingtai/infrastructure/github-actions-runner/zdt-delivery release <full-source-sha> <target> <physical-node>
./02_platform_pingtai/infrastructure/github-actions-runner/zdt-delivery deploy <target> <full-source-sha> <physical-node>
./02_platform_pingtai/infrastructure/github-actions-runner/zdt-delivery status <full-source-sha-or-r16-release-id>
./02_platform_pingtai/infrastructure/github-actions-runner/zdt-delivery retry <r16-release-id> [target physical-node]
./02_platform_pingtai/infrastructure/github-actions-runner/zdt-delivery rollback <target> <physical-node>
```

控制端每次读取最新 `origin/zdt-next`，只派发 `delivery-1-6.yml`、查询 GitHub 运行并展示结果。控制端不安装依赖、不构建、不上传制品、不连接生产，也不执行回滚。

普通 `release/retry` 在目标部署前由同一个 Runner 核心同步远端 Agent 和策略，不要求人工先更新。发布不再比较远端文件与本地文件的精确哈希作为阻断门禁；实际运行版本仍记入回执。`status` 只读，`rollback` 不依赖同步动作。

GitHub 工作流先选择可立即执行的阿里云 Build Runner；没有匹配 Runner、Runner offline/busy 或状态不可读时直接使用 `ubuntu-24.04`。两种执行位置都调用 `.github/actions/runner-1-6/action.yml`，后者只调用同一个 `scripts/runner-1-6.sh` 和 `runner-1-6.mjs` 核心。阿里云任务若在核心启动前失败，GitHub Hosted 执行相同核心；核心启动后不自动换路。

不带目标的 `release` 使用完整业务 Source SHA 计算受影响目标，保持数据库迁移、运行时和前端的依赖顺序。可读的普通 OSS 制品缓存会复用；缓存缺失或内容不完整时重新构建。

带 `<target> <physical-node>` 的 `release/retry` 只处理该目标和节点；缓存缺失时由同一个 Runner 构建对应制品，再继续部署。总耗时包括准备与目标切换；120 秒是观测目标，不是阻断发布或恢复的门禁。

指定主打团 L0 的单个目标同样只发布该目标，不自动扩展为六目标，也不自动同步继承实例。不带目标时仍按源码变化计算受影响目标，不强制扩展为 L0 整批。

只有 Ethan 明确要求核心整批升级时，才使用既有多目标口令列出六个目标：

```bash
zdt-delivery release <full-source-sha> identity-api zhudatuan-l0 web-api zhudatuan-l0 purchase-api zhudatuan-l0 storefront zhudatuan-l0 auth-web zhudatuan-l0 console zhudatuan-l0
```

继承实例同步是独立的显式选项，默认关闭。只有 Ethan 明确要求同步时，才在本次 L0 发布口令前设置 `ZDT_SYNC_INSTANCES=true`；派发器将其传给工作流的 `sync_instances`，阿里云与 Hosted 接管均沿用同一选项。即使明确发布六个目标，未指定同步也不会更新继承实例版本记录或派发继承实例发布。同步本身仍复用现有 `synchronizeL0Release`，保留既有实例与数据行为。

OSS 只是缓存和不可变制品存储，不是审批者。正常路径和目标节点都不创建全局锁、目录锁或解锁状态，也不存在 Seal、Closure、Claim、Lease 或另一份可部署权威。若两个切换并发，后完成的旧任务发现 `current` 已被更新时只报告被新切换取代，不会把新版本回滚掉。

生产状态只读取目标机 `current`、`previous`、服务进程和健康结果。GitHub Actions 的绿色状态不是生产成功事实。用户状态固定为 `QUEUED / RUNNING / HEALTHY / FAILED / ROLLED_BACK / UNKNOWN`；节点读取失败显示 `UNKNOWN`，不会冒充生产失败或阻止独立回滚。确认失败时输出阶段、目标、命令、退出码、底层输出、服务状态和恢复结果。

历史维修、灾难恢复和控制面安装仍由 [RECOVERY.md](RECOVERY.md) 的独立入口处理，不得被普通 `release` 调用。

“高级”只表示更快、更稳定、更自动、更容易恢复和扩展；不表示增加安全锁、审批、Seal、Closure、Claim、Lease、签名、证明链或其他门禁。
