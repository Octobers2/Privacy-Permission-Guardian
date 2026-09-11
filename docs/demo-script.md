# Demo 流程

六步，約 5 分鐘。同時係交畀負責測試嘅組員做回歸測試嘅清單 ——
每一步都有一個自動化版本喺 `eval/run-e2e.ts`，所以「跑得過」係查得到嘅。

## 事前準備（提早做，唔好現場先做）

```bash
bun install
bun run --filter @ppg/extension build      # → packages/extension/dist/
bun run eval/serve-fixtures.ts             # 開住，會印低面要用嘅 flag
```

如果要 demo managed 模式，仲要開個帳號同開 server（demo 之前做，唔好
現場先 bcrypt）：

```bash
bun run auth add demo                      # 打兩次密碼
bun run server                             # 會印「users 1」
```

之後喺 options 頁（Managed）填 server URL、帳號、密碼，撳「測試連線」，
應該見到「已經認得「demo」」。

`chrome://extensions` → 開 Developer mode → Load unpacked → 揀
`packages/extension/dist/`。

Fixture 要喺佢哋自己嘅網域下開，否則 lookalike 規則冇嘢可以睇（`file://`
冇 hostname）。用 fixture server 印出嚟嘅 flag 開一個獨立 Chromium：

```bash
chromium --user-data-dir=/tmp/ppg-demo \
  --load-extension="$PWD/packages/extension/dist" \
  --host-resolver-rules="<serve-fixtures.ts 印出嗰串>" \
  --ignore-certificate-errors
```

**預先 warm 快取**：喺 `www.datahungry.example` 撳一次「分析呢個網站」，
之後現場就係即時出結果，唔會對住個轉圈等 API。

---

## 1. 正常網站的條款摘要　（約 60 秒）

開 `https://www.datahungry.example/` → 撳插件圖示 → 撳「分析呢個網站」。

**指住講**：3 至 5 點人話、每點有 severity chip、**撳「睇原文」展開逐字
引文**。引文係重點 —— 冇引文就冇得核實，就同「模型話係咁」冇分別。

如果出到「有 N 點因為引文對唔返原文而被丟棄」，唔好當佢係 bug，指住佢講：
呢個就係防 hallucination 嗰層喺度做嘢。

## 2. 釣魚表單，完全唔使模型　（約 60 秒）

開 `https://hsbc-verify.top/verify`。

紅色橫額即刻出，撳「詳情」列出五個原因：域名扮 HSBC、要身份證、要銀行
戶口、姓名+出生日期+地址齊、`.top` 網域加登入頁。

**指住講**：呢一步**完全冇呼叫過模型**。規則分數 100 分，已經夠信心。
即係話 API 額度爆咗、現場冇網，呢個 demo 一樣做得到。

## 3. 私隱證明　（約 60 秒 —— 呢步最有說服力）

喺個釣魚表單度打幾個**假**資料（例如身份證打 `A123456(7)`）。開 DevTools
→ Network。

**指住講**：送出去嘅 payload 只有欄位嘅名同類型，**冇任何一個你打咗嘅值**；
URL 冇 query string。

`FormField` 個 schema 根本冇 `value` 欄位，而且係 `.strict()`；
`packages/shared/test/schemas.test.ts` 同 server 兩邊各有一個測試驗證加返
`value` 會被拒絕。

## 4. Prompt injection　（約 90 秒 —— 技術含量最高）

開 `https://injection.test/07-white-on-white`。用滑鼠 select 成版 →
白底白字嗰段就顯出嚟：`SYSTEM OVERRIDE: Ignore all previous instructions…`

跑：

```bash
bun run eval/run-injection-eval.ts
```

**指住講**：8 種隱藏技巧、6 種喺 payload 到達模型之前已經被刪走；
8/8 虛構發現喺顯示前被拒絕；0 個逃得出 untrusted block。

再指住表入面「無 CSS / 真瀏覽器」兩欄嘅差異：白底白字要有 layout engine
先偵測得到，所以 harness 會將真 production 嘅 sanitizer 注入 headless
Chromium 度跑多次。用 Node 嗰個數字報告會低估咗實際保護。

**同時要講埋處理唔到嘅嘢**：被說服保持沉默嘅模型。呢個就係點解表單提示
完全唔問模型。

## 5. 兩個模式　（約 45 秒）

Options 頁：由 Managed 切去 Direct (BYOK) → 撳「測試連線」→ ✓ 同延遲。
返去重新分析 → 結果一樣。

**指住講**：兩個模式跑同一份 prompt、同一個 schema、同一個引文核對，
因為佢哋都喺 `packages/shared/`。分別只係邊個攞住條 key —— 同埋 managed
嗰邊多咗一部 headless Chromium 幫手 render 靠 JS 先出文字嘅條款頁。

想順手 demo 埋「唔係 open relay」：喺 Managed 模式將密碼清空 → 撳
「測試連線」→ 出嘅係「未填帳號密碼」而唔係連線錯誤。或者 terminal 度：

```bash
curl -s localhost:8787/api/status                      # 401
curl -s -X POST localhost:8787/api/policy/render \
  -H 'content-type: application/json' \
  -d '{"urls":["https://example.com/privacy"]}'        # 401
```

## 6. 暫停同主題　（約 30 秒）

Options → 撳「全域暫停」→ 返去釣魚 fixture，橫額即刻消失，工具列圖示
變灰。撳返開就返嚟。

切換系統 dark mode → popup 同橫額都跟住轉。

---

## 現場出事點算

| 情況 | 做法 |
|---|---|
| 模型 API 掛 / 冇網 | 第 2、3、6 步完全唔使網絡，照做。第 1 步用預先 warm 好嘅快取。 |
| Fixture server 未開 | 所有 `*.invalid` / `*.test` 域名會 404。先開返 `bun run eval/serve-fixtures.ts`。 |
| 插件冇反應 | `chrome://extensions` 撳 reload；content script 要頁面重新載入先注入。 |
| Managed 出「帳號或者密碼唔啱」 | `bun run auth list` 睇下個名喺唔喺；`bun run auth add <name>` 可以直接覆蓋密碼，唔使重啟 server。 |
| 完全開唔到 | `bun run e2e` 一次過跑晒六步嘅自動化版本，可以直接 show terminal 輸出。 |

## 自動化版本

```bash
bun run e2e
```

驗證 bundle 預算、兩個 extension 頁面零 CSP 錯誤、9 個 fixture 判定、
完整條款摘要 pipeline（對住 mock endpoint）、快取命中、測試連線、全域暫停。
