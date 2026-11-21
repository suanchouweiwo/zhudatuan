# 主打团 L0 开店运行配置

主节点 `node:zhudatuan:l0` 新发出的开店 `ACTIVATE` 请求引用
`/opt/sfl/control/autonode/zhudatuan-l0-runtime-profile.json`。把同目录的
`zhudatuan-l0-runtime-profile.json` 放在该路径。Cloudflare 区域由已有 AutoNode
逻辑按任务的 `zhudatuan.com` 基础域查询。已落库的任务继续读取原请求中保存的
profile 路径，实例生命周期入口仍由原有配置管理。

## 210 上的凭据注入

在后续实际接入时，将 `sfl-autonode-control.zhudatuan-l0.conf` 放到
`/etc/systemd/system/sfl-autonode-control.service.d/zhudatuan-l0.conf`。
按 `autonode.env.example` 在 210 生成
`/opt/sfl/control/autonode/zhudatuan-l0.env`，由 root 持有，权限 `0600`。
systemd 读取这个 `NAME=value` 文件，AutoNode 启动的激活子进程继承其中的变量。

| 变量 | 210 上的来源 |
| --- | --- |
| `AUTONODE_ZHUDUATUAN_CLOUDFLARE_TOKEN` | 读取 `/opt/sfl/control/autonode/cloudflare-token` 的现有令牌，ID 尾号 `c8773fd9`。原文件继续供实例生命周期入口使用。 |
| `AUTONODE_ZHUDUATUAN_IDENTITY_DATABASE_URL` | 使用主打团 L0 开店服务的 `DATABASE_API_CONNECTION_REF`，从现有 Secret Store 取得 `zhudatuanprovisioningapi` 的连接值。 |
| KMS 变量 | 在宿主机沿用现有 L0 的 KMS 配置及工作负载凭据。 |
| 微信和支付应用配置 | 优先读取 L0 Secret Store 对应条目。若 L0 目录尚无条目，可通过同一宿主机环境文件提供 L0 的配置。 |

首次激活把主打团 L0 当前使用的商城、服务、Console 和登录产物解析到实际版本目录，
写入子店的 `targets/<target>/current`。后续重试沿用首次记录的产物目录。
涉及支付的任务也会绑定支付回调和支付任务产物。

子店 Secret Store 使用 AutoNode 分配的独立回环端口。首次激活把 L0 的数据库连接和任务
需要继承的微信、支付配置映射到子节点自己的引用，并生成该店的会话、索引、报价密钥
和服务 bearer。条目只写到子店 `runtime/secrets.json`，服务从该店的环境读取地址和
凭据。对象存储端口与 bearer 也按子店分配。所需产物或继承条目缺失时，原任务回执
会列出对应的外部依赖。

## 新店源站证书

新开店会生成 `<slug>.zhudatuan.com`、`api-<slug>.zhudatuan.com`、
`console-<slug>.zhudatuan.com`、`accounts-<slug>.zhudatuan.com`。
一张 SAN 含 `*.zhudatuan.com` 的 Cloudflare Origin CA 证书就能覆盖四个入口。
可在 210 生成私钥和 CSR，再在 Cloudflare 的 SSL/TLS → 源服务器签发，
把证书、私钥和签发链对应的 Origin CA 根证书放进
`/opt/sfl/control/autonode/zhudatuan-l0-tls/`，分别命名为
`origin.crt`、`origin.key`、`origin-ca.crt`。

AutoNode 将这三个文件复制到新店的 `runtime/tls/`。Caddy 加载证书和私钥，
cloudflared 保留 `matchSNItoHost: true`，并通过 `caPool` 信任对应的根证书。
现有回环证书继续用于对象存储和内部服务。签发只需做一次，开店任务复用证书文件。
签发属于 Cloudflare SSL/TLS 权限范围，可由控制台完成，开店令牌只用于现有的 DNS 和 Tunnel 操作。

[Cloudflare Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/) ·
[Cloudflare Tunnel 源站参数](https://developers.cloudflare.com/tunnel/reference/origin-parameters/)
