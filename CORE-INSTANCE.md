# LK 核心与主打团 L0

2026-10-04，按 Ethan 的明确决定归位。本文记录位置与实现，不新增标准或发布流程。

```text
桌面/
├─ L-kernel/                         LK 的完整共用源码
│  ├─ LAW.md、AGENTS.md              现有协作与标准入口
│  ├─ .git/                         共用 Git 历史，当前主工作区
│  ├─ 01_core_hexin/
│  │  ├─ apps/                      控制台、登录、商城、小程序
│  │  ├─ services/                  后端服务
│  │  ├─ packages/                  共享组件、VI、SDK、配置
│  │  ├─ extensions/                支付与供应商适配
│  │  └─ prototypes/console-studio/  新后台视觉原型，端口 3001
│  ├─ L-kernel/                     现有 @shop/l-kernel 纯规则包
│  ├─ 02_platform_pingtai/           数据库、基础设施与现有节点绑定
│  ├─ 04_tools/                     现有开发、构建与发布工具
│  │  └─ runtime/windows/           Windows 独立 Node 与原生依赖
│  ├─ 05_docs_ziliao/                标准、架构与设计资料
│  ├─ .codex-temp/
│  │  ├─ legacy-worktrees/zdt-next/  原 Windows 分支与本地修改
│  │  ├─ delivery-control/          现有发布控制面工作树
│  │  └─ dev-migration/             迁移记录与旧连接入口
│  └─ package.json、package-lock.json、node_modules/
└─ L0 主打团/                       主打团实例
   ├─ sfl-node-registry.declaration.json  独立 L0 输入：节点与登录/品牌绑定
   ├─ node-manifest.json            旧投影，兼容尚未切换的消费者
   ├─ .env.local                    实例环境参数
   ├─ env/                          6 份公开环境样例，非实际运行环境
   ├─ 配置整理说明.md                输入、产物和后续接线说明
   ├─ L-kernel/                     指向共用核心的目录连接
   ├─ 启动后台.cmd、构建后台.cmd      调用核心现有 npm/Vite 入口
   ├─ 启动登录.cmd、构建登录.cmd      调用核心登录前端入口
   ├─ 构建服务.cmd                   调用核心现有服务 builder
   ├─ 启动商城.cmd、构建商城.cmd      调用核心商城与原 runtime builder
   ├─ 生成小程序参数.cmd             调用核心现有三字段参数生成器
   ├─ 整理发布输入.cmd               调用现有节点生成器装配发布输入
   ├─ 查看VI原型.cmd                 调用核心中的原型
   └─ dist/                         后台构建与配置生成输出
      ├─ console/
      ├─ auth-web/
      ├─ services/<target>/
      ├─ storefront-web/            商城 client/server 与原 production runtime 包
      ├─ release-preview/           第五步五目标装配目录，本机装配已完成
      └─ config/
         ├─ node-manifests/zhudatuan-l0.json
         ├─ identity-node-projection.json
         ├─ miniapp-environment.json
         ├─ console-runtime.json     第五步入口从实际构建生成，本机装配已完成
         └─ identity-runtime.json    既有 SDK 身份注册表，本机装配已完成
```

标准、服务实现、组件、前端源码、依赖清单和构建工具归核心。L0 不安装第二份核心依赖、不复制后台源码，通过 `LK_INSTANCE_ROOT` 指定自己的配置目录。

Console 的 Vite 配置通过 `LK_INSTANCE_ROOT` 读取实例环境目录和 `sfl-node-registry.declaration.json`。本机启动与正式构建已统一消费该声明；本机节点投影直接从声明生成，再把 Console 域名绑定适配到当前 localhost，版本仍是开发状态。Console 已不再读取实例根 `node-manifest.json`。未指定实例时保留原核心入口行为。

早期实例根 `node-manifest.json` 以迁移时的 `02_platform_pingtai/config/node-manifests/zhudatuan-l0.json` 为起点，现保留兼容未切换消费者。原生产注册表与发布绑定保留，本次不改变线上行为。

第一步实例配置整理已抽出 `L0 主打团/sfl-node-registry.declaration.json`，沿用 `sfl.node-registry-declaration.v1` 格式，只含主打团的一个 manifest 和对应 node binding。原节点、Realm、商城、组织范围、登录目标、域名、品牌及资源引用原值保留。运营组织 `tenant-zhudatuan` 和商城会员组织 `mall-zhudatuan` 仍分别使用，未调整账号或数据库。

现有 `04_tools/scripts/release/generate-node-manifests.mjs` 支持 `--instance-root`，已经从独立输入生成 `L0 主打团/dist/config/node-manifests/zhudatuan-l0.json`，第三步又复用同一入口输出既有格式的 `dist/config/identity-node-projection.json`。这些是声明投影，不是生产发布记录。

第二步已接通正式 Console 构建，`L0 主打团/dist/console/console-build.json` 仅含主打团 L0，API、登录入口与作用域沿该声明的 node binding 生成。后台外壳品牌文字、页面标题和正式 HTML 元信息、应用名称从同份声明读取，M 资产继续由核心共享。共用源码留在核心，L0 仅保留配置、入口与产物，核心原声明继续供未切换消费者使用。

第三步已接通登录前端与后端服务的配置、构建输入。登录前端 Vite 和现有回跳 origin policy 读取同份 L0 声明，身份域与组织 targets 沿既有投影生成；本机开发账号入口适配为 `127.0.0.1:3002`，正式域名和回跳保持实例值。服务现有 builder 与 workspace resolver 在 `LK_INSTANCE_ROOT` 下使用该外部声明，原默认来源保留；现有完整 Commerce 构建入口也复用该配置，但本轮仅成功构建 identity-api、web-api 两个服务目标及 auth-web，没有全量构建所有服务。

登录前端产物在 L0 的 `dist/auth-web`，服务目标产物在 `dist/services/<target>`。第三步当时未新建静态 `identity-runtime.json`；第五步生成接线见下文，服务器实际安装仍待第六步。当前没有可直接用于独立 identity-api 运行的完整实际环境文件；旧 legacy 通用环境并未移用为已就绪环境。本轮未启动真实身份服务或登录开发入口，未执行真实账号的完整登录。

第四步已把商城的 API、会员入口、Host/应用映射以及元信息和 WebManifest 接入同份实例声明，商城不再读取旧根 `node-manifest.json`。商城源码、依赖、M 图形和构建实现继续共享核心；默认状态、顶栏、设备切换、平板与页脚平台文字读取实例品牌，会员的企业信息与切换保持独立。实例新增 `启动商城.cmd`（3000）、`构建商城.cmd` 和 `生成小程序参数.cmd`。vinext 使用核心固定 dist 作为临时目录，沿原 production runtime builder 打包后归入实例 `dist/storefront-web`，没有另起发布路线。本轮 Console 目标构建一次并成功，商城构建、运行包打包和归档成功，产物包含 client、server、start.mjs 与 production-runtime.json；未启动商城或执行真实登录、交易。

第四步新增公开 `env/storefront.env.example`，仅给原运行时最小 APP_ENV、AUTH_MODE、STOREFRONT_HOST 与 STOREFRONT_PORT 样例；兼容公开 API 仍需既有商城 slug 与 Supabase 实际资源环境。身份注册表、Host、应用的 `NEXT_PUBLIC` 映射从实例编译投影，不另建人工 JSON；原 SFL runtime 覆盖能力保留。六份公开样例不代表已安装实际服务环境。

小程序参数已经沿原 `MiniappEnvironment` 三字段生成：API 为 `https://api.zhudatuan.com`、商城为 `mall-zhudatuan`、客户端版本为 `0.0.0`，输出至 `dist/config/miniapp-environment.json`。独立小程序目前只有 9 个骨架文件，缺少 app.json、页面、微信项目配置、可用 AppID 和编译上传入口，参数生成不代表完整小程序构建或上线。

后台创建向导取消旧固定域名承诺，仅提示系统分配短 hN 编号；原有任务结果展示继续读取 `task.result.access_entries`，不是本步新建结果消费者。后端 `AutoNodeControlClient` 仍固定 hbbtzn，尚未参数化，现声明也没有分配策略字段。本步不修改该策略、不编造公共配置格式。第六步线上部署及第三步实际运行缺项仍待后续接通。

第五步复用现有 Runner 的构建、输入物化和节点生成器，接入可选 `LK_INSTANCE_ROOT`。L0 新增薄入口 `整理发布输入.cmd`，已生成 `dist/config/console-runtime.json`、`identity-runtime.json` 和 `dist/release-preview`，本机装配已一次成功完成。装配复用已构建的 console、auth-web、storefront、identity-api、web-api 五目标及 7 项配置，保留既有 static、app/dist、service 目录，不新建 Runner、不重复构建，不打包上传或部署。默认 NodeManifest 仍为声明投影；runtime 的源码、build_id、build_count、摘要与真实 `console-build.json` 的 dirty 构建一致，作用域为 platform，完整四身份目标保存在独立 identity-node-projection.json，identity-runtime.json 沿用既有 SDK 的 consumer/admin 入口摘要，不新增字段；不伪造正式缓存包或目标机安装结论。

L0 声明与实例环境仍是日常可编辑来源，核心快照只用于发布。公开发布输入快照已保存至核心 `02_platform_pingtai/config/release-inputs/zhudatuan-l0`，仅包括实例声明和公开 `.env.local`。未来该输入随业务 Source SHA 进入原 Runner 构建和缓存，桌面绝对路径不作为远程发布输入。当前核心 HEAD 为 `c6ae9fab574e47807b7e06a8f8c8a789f5664af6`，仍有未提交改动；控制工作树 HEAD `e62ad5f5182799caf456561e7309ed44dc9b615c` 与当前远程默认分支 `zdt-next` 一致，其实际实现为 Runner 1.7，文件名继续使用 1.6。本步已修改控制工作树但没有提交或推送。旧 `candidate.mjs` 和 legacy recovery 不是本步普通发布路线。数据库、Secret、端口及服务器安装仍沿现有目标机配置，第六步再接入现有 runtime 落点。

控制树既有 dispatcher 已把可选 `ZDT_INSTANCE_PATH` 传至原 workflow 的 `instance_path`，实例相对目录为 `02_platform_pingtai/config/release-inputs/zhudatuan-l0`，原执行与 Hosted fallback 使用同一派发入口；不传参数仍沿原行为。公开快照环境只有 4 个公开键，未被 Git 忽略，可以随 Source SHA 版本化；目前没有包含本步代码和快照的正式 Source SHA，远程控制面也未合入。本机 dirty 预览不代表线上版本。

修改外部声明或环境参数后重新启动对应前端开发入口、重新构建正式产物；不承诺外部声明自动热更新。线上存在 `/console-runtime.json` 时仍优先服务器运行配置，后续服务与发布步骤再统一接入实例输入；本机产物核对详情见实例 `配置整理说明.md`。

第一步实例 `env/` 整理了 Web API、Catalog API、Catalog Jobs、Object Store 四份公开样例，第三步新增 Identity API 的公开域名与资源引用样例。确认过时的 Web/Catalog 来源域名与商城 host 映射已改为主打团；历史 FUFU 分发兼容键保留，样例中的该目标设为未启用。实际生产环境、资源与凭证仍沿现有部署，样例不代表已接通的服务。详细位置与字段用途见 L0 的 `配置整理说明.md`。

完整源码、未提交修改、已安装依赖、后台原型和共用 Git 历史均归桌面 `L-kernel`，根目录 `.git` 是实体历史目录。当前主工作区仍为 `codex/lk-login-core`，HEAD 为 `c6ae9fab574e47807b7e06a8f8c8a789f5664af6`。

原 `C:/dev/zdt-next` 保存在 `.codex-temp/legacy-worktrees/zdt-next`，保留 `codex/L-kernel` 分支、HEAD `6b74c668cae56f09e9792da76006fd94362eb15c` 及其本地修改；原 `lk-delivery-control` 保存在 `.codex-temp/delivery-control`，保留 detached HEAD `e62ad5f5182799caf456561e7309ed44dc9b615c`。两者是不同版本的保留工作树，共用当前 `.git`，不是新的共用源码入口。

原 `C:/dev/lk-login-core` 连接已移入 `.codex-temp/dev-migration/old-path-links/lk-login-core`；`桌面/L-K/主打团运营管理后台` 仍连接到核心中的原型。LK 的 Windows 独立运行时位于 `04_tools/runtime/windows`。`C:/dev` 中的其他项目保持原位置。

当前已完成目录继承、第一步实例输入整理、第二步 Console 启动与正式构建，以及第三步登录与后端的配置、构建接入。第四步商城配置、构建与原运行包归档完成，小程序参数已生成；第五步发布输入与本机装配已完成。实际服务环境、数据库连接、服务器 runtime 安装和生产绑定尚未统一到这份实例输入，其它业务消费者继续逐项接线。本轮没有账号、Owner 或数据库改动，也没有部署、线上更新或完整登录成功的结论。

`3001` 是视觉原型，`5173` 是实际 Console。原型数据仍是示例，不代表 L0 实际经营数据。

迁移后已确认：原有 76 项修改状态均保留，44 个工作区依赖连接指向桌面核心；L0 调用核心构建成功，产物写入自身目录；原型构建与启动成功。实际 Console 已从 L0 入口启动，未登录时 API 返回正常的 401，并沿原规则进入现有统一登录页。没有执行测试、发布或改变线上版本。

以上构建与启动是前一阶段源码归位的记录。上一轮目录迁移只收拢剩余 Git 历史、工作树、运行时与路径引用，保留既有版本和本地修改，当时没有重复构建、运行测试或部署生产。

上一轮目录迁移的位置核对完成：当时三个 Windows 工作树的 HEAD 和分支、全部 Git 引用与共用配置保持原值；核心的 129 项修改状态、旧分支的 23 项修改状态均保留，发布工作树无未提交修改。核心与保留旧分支各 44 个依赖连接均指向新的实际位置。`C:/dev` 已无 LK 目录，仅保留原有其他项目和文件。
