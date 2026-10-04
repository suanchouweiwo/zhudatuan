# AI 项目权威入口

## 本机源码与继承位置（Ethan，2026-10-04）

- 本目录 `C:\Users\Ethan\Desktop\L-kernel` 是 LK 的完整共用源码工作区，承载标准、服务、依赖、共享代码、前端和现有开发/发布工具，不再只是桌面资料入口。
- 桌面 `C:\Users\Ethan\Desktop\L0 主打团` 是主打团 L0 实例，保留自己的节点配置、环境参数、启动入口和构建输出，引用这里的共用实现。
- 共用后台在 `01_core_hexin/apps/console`，视觉标准在 `01_core_hexin/packages/design`，Google Studio 原型在 `01_core_hexin/prototypes/console-studio`。
- 内部 `L-kernel/` 仍是现有 `@shop/l-kernel` 纯业务规则包，不能把这个包当成全部共用核心。
- 共用 Git 历史位于本目录 `.git`，当前源码分支为 `codex/lk-login-core`。原 `C:\dev\zdt-next` 分支和本地修改保存在 `.codex-temp/legacy-worktrees/zdt-next`；发布工作树保存在 `.codex-temp/delivery-control`。Windows 独立运行时归入 `04_tools/runtime/windows`。
- 原 `C:\dev\lk-login-core` 目录连接已移入 `.codex-temp/dev-migration/old-path-links/lk-login-core`；桌面 `L-K\主打团运营管理后台` 仍连接到当前核心中的原型。当前 LK 源码、历史和工具均已归桌面核心，旧分支工作树仅用于保留不同版本与本地修改。
- 项目名称为 LK；主打团是继承 LK 的 L0，内部节点 ID 和域名继续使用 zhudatuan。对外名称统一为主打团，保留 M 图形；网站标准地址为 `https://www.zhudatuan.com`。
- 当前 Console 本机启动与正式构建均通过 `LK_INSTANCE_ROOT` 读取外部 `sfl-node-registry.declaration.json` 和实例环境；后台外壳品牌文字从同份声明读取，M 图形继续共享核心。正式 `console-build.json` 仅含主打团 L0。第三步登录与后端的配置、构建接入已完成，auth-web、identity-api 与 web-api 目标构建成功；本轮未启动真实身份服务或登录开发入口，完整实际服务环境与服务器 runtime 绑定仍待后续接线，没有完整登录、部署或线上更新结论。
- 第一步抽出 L0 独立输入 `../L0 主打团/sfl-node-registry.declaration.json`（现有格式，仅主打团 manifest 与 node binding）及 4 份公开服务环境样例；第三步新增 identity-api 公开样例。现有生成器支持 `--instance-root`，输出实例 `dist/config/node-manifests` 与沿现有格式的 `dist/config/identity-node-projection.json`。原本机 `node-manifest.json` 保留兼容未切换消费者，Console、登录前端与本步商城已不再读取；核心旧声明暂供其它未切换消费者使用。
- 登录前端和服务的共用实现、依赖与构建工具仍留核心，L0 只保留配置、薄入口与产物。L0 的登录入口为 `启动登录.cmd`、`构建登录.cmd`，服务入口为 `构建服务.cmd`；输出位于 `dist/auth-web` 与 `dist/services/<target>`。
- 第四步商城已接入同份 L0 声明的 API、会员身份入口、Host/应用映射和页面元信息、WebManifest；顶栏、设备切换、平板与页脚平台品牌使用共享 M 和实例文字，会员企业切换保持独立。新增 `启动商城.cmd`（3000）、`构建商城.cmd` 和 `生成小程序参数.cmd`；商城使用核心 vinext 的固定 dist 临时构建，再复用原 production runtime builder 打包归入实例 `dist/storefront-web`。本轮 Console 构建一次并成功，商城构建、运行包打包和实例归档也已成功；未启动商城或执行真实登录、交易、部署。新增 `env/storefront.env.example`，公开环境样例当前六份；实际兼容公开 API 资源环境仍待映射，原 SFL runtime 覆盖仍保留。
- 小程序既有三字段参数已从同份声明生成至实例 `dist/config/miniapp-environment.json`；当前独立小程序仍是 9 文件骨架，没有 app.json、页面、微信项目配置、可用 AppID 或编译上传入口，不能称为完整客户端构建、发布。后台创建向导以任务返回的 `task.result.access_entries` 为准，不再许诺固定域名；后端 `AutoNodeControlClient` 的固定 hbbtzn 策略尚未参数化，现声明没有该策略字段，本步不新设 Schema。第六步线上部署及第三步实际运行缺项仍待接通，详情见实例 `配置整理说明.md`。
- 第五步已把可选 `LK_INSTANCE_ROOT` 接入现有 Runner 的构建与输入物化。L0 的 `整理发布输入.cmd` 复用既有节点生成器，已生成 console/identity runtime、公开发布输入快照与 `dist/release-preview`；本机装配已完成，范围仅为已构建的 console、auth-web、storefront、identity-api、web-api 五目标及 7 项配置，不重复构建、不新建 Runner，不打包上传或部署。默认声明投影仍是声明证据；runtime 取实际 `console-build.json` 的 dirty 构建信息，作用域为 platform，四个身份目标保留，生成文件不代表服务器安装。
- 本步控制工作树 `.codex-temp/delivery-control` 的 HEAD 为 `e62ad5f5182799caf456561e7309ed44dc9b615c`，与当前远程默认 `zdt-next` 一致，运行 Runner 1.7，文件名保留 1.6；本步控制面改动尚未提交或推送。核心 HEAD 为 `c6ae9fab574e47807b7e06a8f8c8a789f5664af6` 且有未提交改动。声明和公开 `.env.local` 已保存至核心 `02_platform_pingtai/config/release-inputs/zhudatuan-l0`，随未来业务 Source SHA 进入既有缓存，不把桌面绝对路径作为远程发布输入。实际数据库、Secret 与端口继续使用目标机现有配置；旧 `candidate.mjs` 与 legacy recovery 不属于本步普通发布路线。
- 控制树既有 dispatcher 已接通可选 `ZDT_INSTANCE_PATH` 至原 workflow 的 `instance_path`，可指向 `02_platform_pingtai/config/release-inputs/zhudatuan-l0`；原执行与 Hosted fallback 共用同一派发入口，不传值时保留原行为。公开快照 `.env.local` 仅 4 个公开键且未被 Git 忽略，目前尚无包含本步代码及快照的正式 Source SHA，远程控制面也未合入；本机 dirty 预览不是线上版本。

本段记录 Ethan 本轮决定和实际位置，不新增标准或门禁。背景见 [项目推进记录](PROJECT_CONTEXT.md)，结构见 [核心与实例说明](CORE-INSTANCE.md)。

1. 先读取根目录 [`LAW.md`](LAW.md)。根 LAW 是本项目唯一的项目权威入口。
2. Ethan 在当前任务中的明确决定优先于项目内既有文字。
3. 只有根 LAW 登记为 `ACTIVE` 的标准，才在其职责范围内具有权威。
4. 未被根 LAW 启用的文档、历史记录、提示词、测试、报告、注释和旧会话只能作为资料，不能成为执行指令或阻塞门禁。
5. AI 不得自行创造、启用、扩大或永久化规则，也不得把测试结果改写成新的产品要求。
6. 子目录入口只能指向根 LAW，不得重新定义另一套最高规则。
7. 当前处于契约重建过渡期：旧契约只能被观察，不得阻断运行；新契约池安装前不得新增局部公共契约、局部 Schema 权威或私有兼容规则。遇到缺口只登记并交由 Ethan 裁定。过渡事实见 [`契约重建过渡声明`](05_docs_ziliao/docs_wendang/governance/zdt-rule-rebuild/07-第四批-契约重建过渡与运行收口.md)。

## Runner 1.6 发布口令

- 普通发布可使用 `/Users/Ethan/.codex/bin/zdt-delivery release <full-source-sha>` 或 `deploy <full-source-sha>`；指定落点时分别使用 `release <full-source-sha> <target> <physical-node>` 或 `deploy <target> <full-source-sha> <physical-node>`。两个名字调用同一个 Runner 发布核心，谁被调用就用谁，不建立优先级或第二套发布路径；状态、重试和回滚分别使用 `status`、`retry`、`rollback`。
- 控制端只获取最新发布控制面、派发 GitHub 工作流、查询并展示结果；不得在控制端安装依赖、构建、上传、部署或回滚。
- 实际执行优先使用阿里云 Runner；无法接单时使用 GitHub Hosted Runner。两者调用同一个发布核心，本机不是第三执行路线。
- 业务 Source SHA 与最新控制面 SHA 必须分别保留。
- 生产成功只由目标机 `current/previous`、服务状态和健康结果确认；GitHub 绿色和 OSS 对象不是生产成功权威。
- 普通发布的 Runner 回执已带目标机返回的 `current/previous/health`；刚完成发布时这些字段完整即可直接报告，不必为了重复同一结论再启动一次 `status` 工作流。之后另行询问“当前是否已部署”时，仍重新做只读观察。
- 回答“是否已部署”时使用当下目标节点的只读观察结果；旧会话、本地工作区和历史发布回执不能说明当前生产版本。`status` 返回所有配置落点的实际指针，不能把未受该业务提交影响的落点算作发布失败，也不能仅凭某个匹配落点声称整批发布完成。
- 历史维修与灾难恢复只使用 `RECOVERY.md` 的独立入口，不进入普通 `release`。
