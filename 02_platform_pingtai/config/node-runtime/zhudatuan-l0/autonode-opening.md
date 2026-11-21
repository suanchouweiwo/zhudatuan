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
| 对象存储、Secret Store、KMS 变量 | 在宿主机提供 profile 所列的服务凭据。子服务的 Secret Store 凭据须能读取对应的子节点绑定，对象存储服务端与其三个调用方使用同一个对象存储凭据。 |

子服务按 `{node_token}` 生成自己的数据库、会话、微信和支付引用。填入环境变量
只会提供访问凭据，对应的子节点条目仍由现有 Secret Store 和业务资源准备流程提供。
共享回环服务的端口与证书路径沿用主打团 L0 配置，子店对象存储端口取 AutoNode
为该任务分配的端口。

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
