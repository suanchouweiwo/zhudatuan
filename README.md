# LK 共用核心

本机完整源码位于桌面 `L-kernel`，包括标准、服务、依赖、共享能力、前端和现有工具。桌面 `L0 主打团` 使用自己的节点与环境配置，加载这里的共用实现。目录职责和实际完成范围见 [核心与实例说明](CORE-INSTANCE.md)。

下面保留既有源码地图和开发命令。历史工程名称、分支与路径不覆盖上述本机位置；业务模块仍按原实现逐项归入共用核心。

## 目錄地圖

| 目錄 | 中文含義 | 是否屬於主線 |
| --- | --- | --- |
| `01_core_hexin/apps/` | 前端應用 | 是 |
| `01_core_hexin/services/` | 後端服務 | 是 |
| `01_core_hexin/packages/` | 共享代碼 | 是 |
| `01_core_hexin/extensions/` | 支付、供應商和外部擴展 | 是 |
| `02_platform_pingtai/database/` | 數據庫合同和遷移 | 是 |
| `02_platform_pingtai/infrastructure/` | 雲資源、部署和租戶配置 | 是 |
| `02_platform_pingtai/config/` | 全局配置 | 是 |
| `03_quality_ceshi/tests/` | 測試與驗收 | 是 |
| `04_tools/tools/` | 可執行開發工具 | 支撐主線 |
| `04_tools/scripts/` | 倉庫維護腳本 | 支撐主線 |
| `05_docs_ziliao/docs_wendang/` | 架構、決策和說明 | 說明資料 |
| `05_docs_ziliao/docs_wendang/runbooks_yunwei/` | 運維操作手冊 | 說明資料 |
| `05_docs_ziliao/VI_shijue/` | 視覺標準和歷史版本 | 設計資料 |
| `06_history_lishi/` | 舊主線參考代碼 | 不參與構建 |
| `06_history_lishi/archive_guidang/` | 備份和歸檔 | 不參與構建 |

## 已鎖定的兩套前端

- 消費 Web：`01_core_hexin/apps/storefront-web`，來自使用者確認的 27 吋／Laptop 標準版本。
- 營運後臺：`01_core_hexin/apps/console`，來自使用者確認的 4173 新版後臺。
- 統一登入：`01_core_hexin/apps/auth-web`，是消費 Web 的必要運行依賴。

## API 邊界

目前保留兩條彼此隔離的 API 鏈路，這是為了讓兩套已確認前端先保持可運行，而不是宣稱合同已經統一：

1. 核心營運鏈路：`01_core_hexin/apps/console` → `01_core_hexin/services/commerce` → `02_platform_pingtai/database/supabase`。
2. 消費端相容鏈路：`01_core_hexin/apps/storefront-web`／`01_core_hexin/apps/auth-web` → `01_core_hexin/services/commerce-api` → `02_platform_pingtai/database/storefront-compatibility/supabase`。

兩套合同不可共用同一組 Migration：新版使用 `@shop/*` Canonical Operation；消費端目前仍使用 `@smart-wing/*` REST/RPC 合同。正式合流需要新增 Adapter/BFF 並逐項驗證，不能直接覆蓋。

8 月 21 日的 206 個 Canonical Operations 已核實為目前 217 個 Operations 的嚴格子集，無 API 原碼需要搬回。詳細矩陣、權限修復與未完成證據見 [`05_docs_ziliao/docs_wendang/operations/2026-08-27-api-recovery-log.md`](./05_docs_ziliao/docs_wendang/operations/2026-08-27-api-recovery-log.md)。正式制品集合由 [`02_platform_pingtai/config/artifacts.json`](./02_platform_pingtai/config/artifacts.json) 鎖定；在真資料庫與外部 Provider 驗收前，兩條軌道均保持 `releaseEligible=false`。

## 本地命令

```bash
cp 01_core_hexin/apps/console/.env.example 01_core_hexin/apps/console/.env.local
npm ci
npm run dev:console
npm run dev:storefront
npm run dev:auth
```

構建：

```bash
npm run build:console
npm run build:storefront
npm run build:auth
npm run build:commerce
```

`01_core_hexin/services/commerce-api` 的完整 REST Router 目前由 `01_core_hexin/apps/storefront-web` Worker 同源嵌入，會隨 Storefront 一起構建；歷史 `adminServer.ts` 只包含 Health／AI 接口，不是完整相容 API 制品。

## 建議域名

- `www.zhudatuan.com`：消費 Web
- `auth.zhudatuan.com`：統一登入
- `console.zhudatuan.com`：營運後臺
- `api.zhudatuan.com`：核心營運 API
- `chat.zhudatuan.com`：客服系統

目前的消費端相容 API 應與消費 Web 同源部署，或使用獨立的內部相容域名；在合同統一前不要直接掛到核心 `/api/v1`。

## 安全規則

- 只提交 `.env.example`，正式密鑰由阿里雲／Cloudflare Secret 注入。
- 不提交 `node_modules`、`dist`、`.next`、`.wrangler`、TLS 私鑰或支付證書。
- `02_platform_pingtai/database/supabase` 與 `02_platform_pingtai/database/storefront-compatibility/supabase` 必須部署到隔離的測試資料庫。
- 來源、選擇理由與已知差異見 `SOURCE-MANIFEST.md`。

## 已驗證基線

2026-08-27 已在 Node `22.22.3` 完成：

- `npm ci`
- 根工作區 typecheck
- 根工作區 unit tests
- Console、Storefront、Auth 與核心 API 的獨立 build；相容 REST Router 隨 Storefront Worker 構建
- 根目錄單命令 `npm run build`
- 165 個 Migration Replay 與購物車／報價／訂單／支付／財務 MVP Kernel
- Canonical 與 Compatibility 的 Audience／Target 身份隔離測試
- production dependencies audit：0 個已知漏洞

Vinext 的開發／構建依賴目前仍由 `image-size` 帶入 2 個 high severity DoS advisory；不進 production dependency 集，正式升級前需用完整回歸驗證取代，不能直接執行強制 major upgrade。
