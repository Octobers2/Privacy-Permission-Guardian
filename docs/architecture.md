# 架構

## 一句話

Content script 抽 DOM、畫橫額；service worker 做評分、快取同模型呼叫；
`packages/shared/` 係兩條路（本機 BYOK 同 managed server）唯一嗰份邏輯。

## 圖

```
┌──────────────────── Browser (Chrome / Edge, MV3) ─────────────────────┐
│                                                                       │
│  content script  (25 KB，每頁載入)     service worker (一個 session 一次)│
│  ├─ form-scanner ────────────────►    ├─ scoreForm（規則引擎）          │
│  │   extractForms(document)            ├─ chrome.storage 摘要快取       │
│  ├─ policy-scout（只搵連結）──────►     ├─ badge 顏色                   │
│  ├─ 讀 live DOM（唯讀，唔改頁面）        └─ llm-router ─┬── managed ──┐  │
│  └─ banner (Shadow DOM，零 library)                    └── direct    │  │
│                                                                     │  │
│  offscreen document：fetch + sandbox iframe（唔行 script）           │  │
│  背景分頁：畀網站自己 render（BYOK 模式先用）                          │  │
│  popup.html / options.html  (Svelte 5 + @material/web)              │  │
└─────────────────────────────────────────────────────────────────────┼──┘
                                                                      │
         managed（預設，要登入）                 direct / BYOK          │
               │                                        │              │
               ▼                                        ▼              │
   ┌──── Hono on Bun :8787 ────┐         ┌── 用戶自填 endpoint ──┐      │
   │  /api/login（bcrypt）      │         │  POST {base}/chat/    │◄────┘
   │  /api/policy/render ──┐    │────────►│       completions     │
   │  /api/policy/summarize│    │         └───────────────────────┘
   │  /api/form/assess     │    │
   │  /api/status          ▼    │   auth.txt（username:bcrypt-hash）
   │  bun:sqlite 共用快取  headless Chromium（CDP，冇 Puppeteer）
   └────────────────────────────┘
```

## 四個唔明顯但關鍵嘅決定

### 1. 評分喺 service worker，唔喺頁面

規則引擎要 public suffix list（tldts）同 zod，合共約 330 kB。喺 worker
入面一個 browser session 載入一次，可以接受；喺用戶去嘅每一個網站都載入，
就同「輕量私隱工具」呢個前提直接矛盾。

Content script 淨低 DOM 抽取同繪圖，實測 **25 KB**（入面 6 KB 係 sanitizer）。呢件事回歸過兩次
（一次係 import 咗規則引擎，一次係 `@ppg/shared` 未聲明 `sideEffects: false`），
兩次都冇報錯 —— 插件照行，只係靜靜雞肥咗。所以 `eval/bundle-budget.ts`
喺 e2e 度守住個 60 KB 預算。

### 2. 條款頁點讀：server 行先，瀏覽器喺後面接住

呢一節之前寫住「唔會喺 server 讀」，理由係 server-side fetch 會撞
Cloudflare、bot 攔截同地區重導向，攞返嚟嘅未必係用戶被要求同意嗰一版。
嗰啲理由到今日一樣成立 —— 但另一邊嘅代價變咗：**而家大站嘅條款頁基本上
全部係 client-rendered**（Next.js、Meta、TikTok）。純 fetch 攞到嘅只係一個
殼，入面一個字都冇。

所以而家係咁分工：

| | |
|---|---|
| **Managed 模式** | Server 開一個 headless Chromium（CDP，唔用 Puppeteer）去 render。要登入先用得。 |
| **Direct / BYOK** | 冇 server，全部喺瀏覽器度做 —— 落面條階梯 |
| **Server 幫唔到手時**（未登入、連唔到、佢都讀唔到） | 一樣跌返落條階梯 |

階梯（詳見 threat-model.md）：

1. 用戶身處嘅就係條款頁 → **唯讀**咁讀 live DOM
2. Offscreen sandbox iframe（唔執行任何 script）→ 靜態條款頁喺呢級搞掂
3. 背景分頁 → 畀網站喺自己 origin render，然後讀。分頁 `active: false`，
   用戶見唔到，讀完即關。

階梯留住唔係為咗保險咁簡單：**server 冇用戶嘅 session**，要登入先睇到嘅
條款頁得瀏覽器讀到；而畀人 block 資料中心流量嘅網站，block 嘅係 server，
唔係用戶。

#### 點解唔喺 content script 度 fetch

錯咗兩重：content script 個 `fetch` 受**該網頁自己嘅 CSP** 管（GitHub、
Reddit 連自己嗰版私隱政策都 fetch 唔到），而 `DOMParser` 文件冇 browsing
context，`getComputedStyle` 全部返空字串 —— 所有靠 computed style 嘅剝離
檢查靜靜雞失效。Offscreen document 兩樣都有：extension 權限加真渲染引擎。

連結搜尋仍然留喺 content script —— 得 live 頁面知道自己個 footer 連去邊。

#### 抽文字**唔可以**改個 DOM

`stripInvisibleContent` 係喺原地 `remove()` 嘢嘅。落喺 fetch 返嚟嘅文件度
冇問題；落喺用戶望緊嗰一版，就係自己拆人哋個頁 —— body 入面每個
`<style>`、每個 `aria-hidden` 子樹都會消失，React 一 re-render 就散。
Instagram、Facebook 撳「分析」之後成版走晒 style，就係呢件事。

而家 `extractVisibleText` 行 `collectVisibleText`：同一套 `isHidden` 規則，
一次**唯讀**遍歷，見到睇唔到嘅嘢就連整個子樹跳過。順帶平反咗一件事 ——
跳過一個 `display:none` 嘅 menu 只使一次 `getComputedStyle`，而唔係入面
每個元素一次。`test/sanitize.test.ts` 有個測試比對行完前後個 `innerHTML`，
一個字唔同就紅燈。

### 3. Managed backend 要登入

Server 手上有 API key，同埋一個開得到任何網址嘅瀏覽器。冇登入嘅話，
個 port 就係其他人嘅免費 LLM 加免費 fetcher。

- `auth.txt`（repo 根目錄，gitignore 咗）：`username:bcrypt-hash` 一行一個。
  `bun run auth add <name>` 加，用 `Bun.password`，唔使裝 bcrypt。
- `POST /api/login` 用密碼換一個 token，token 淨係擺喺 server 個 `Map` 入面。
  冇 JWT、冇 secret 要管；代價係重啟 server 之後所有 token 失效 —— 插件收到
  401 會自己登入多次再試，所以用戶唔會察覺。
- 插件將 token 擺喺 `chrome.storage.session`（service worker 隨時會被殺，
  每次醒返都重新 bcrypt 一次太蠢），瀏覽器閂咗就冇。
- `/api/policy/render` 會擋私有網段（`169.254.169.254`、`10/8`、loopback…）。
  登入決定「邊個」問得，呢個決定「問得啲乜」。

### 4. `packages/shared/` 用 TypeScript，唔用 Python server

因為要支援 BYOK 直連，prompt、zod schema、sanitizer、引文核對、計分
喺 extension 同 server **兩邊都要跑**。放喺 shared 就寫一次；分兩種語言
就要各維護一份 prompt，一個禮拜就會走樣，然後兩個模式靜靜雞畀唔同答案。

## 資料流：表單提示

```
DOMContentLoaded / MutationObserver
  → extractForms(document, location.href)      shared/extract-form.ts
  → { page, form } 只有欄位 metadata，冇 value
  → sendMessage({ type: 'assess', observations })
      worker: scoreForm(observation, { allowlist }) shared/rules.ts
              ├─ detectLookalike(hostname)          shared/lookalike.ts
              └─ classifyField × N
      → { verdict, reasons[] }
  → showBanner(...)                             content/banner.ts
```

`ruleScore ≥ llmThreshold`（預設 30）先會問模型。`≥ 60` 就算完全冇網絡
都直接出警告。

## 資料流：條款摘要

```
用戶撳 popup 「分析呢個網站」
  → worker: chrome.tabs.sendMessage({ type: 'extract-current-page' })
      content: 呢版本身就係條款頁？係就唯讀咁抽（唔改 DOM）
                                               content/index.ts
  → worker: chrome.tabs.sendMessage({ type: 'policy-candidates' })
      content: policyCandidates(document)       content/policy-scout.ts

  → managed：worker: renderPolicy(urls)         background/llm-router.ts
      server: POST /api/policy/render（要 Bearer token）
              → isPublicUrl 擋私有網段            server/render.ts
              → headless Chromium 開分頁，等佢 render
              → 注入 render-probe（就係 extractVisibleText 本身）
  → 讀唔到 / 冇 server：worker: readPolicy(urls) background/offscreen.ts
      offscreen: fetch(url, credentials:'include')
                 → sandboxed iframe（冇 allow-scripts）→ 真 computed style
                 → pickMainContent → extractVisibleText
  → 仲係讀唔到：readInBackgroundTab(url)         background/background-tab.ts

                                               shared/sanitize.ts  ← 防禦第 1 層
  → sha256Hex(text) → 查快取（domain + hash + PROMPT_VERSION）
  → buildPolicyPrompt → wrapUntrusted           shared/prompts.ts   ← 第 2 層
  → chatJson(..., PolicySummaryResponseSchema)  shared/openai-compat.ts ← 第 3 層
  → finalisePolicySummary → isVerbatim 逐點核對  shared/policy.ts    ← 第 4 層
  → riskScore(kept)                             shared/score.ts
  → 寫快取 → popup 用文字插值 render              ← 第 5 層
```

五層防禦嘅細節同量度結果見 [threat-model.md](threat-model.md) 同
[evaluation.md](evaluation.md)。

## 目錄

| 位置 | 內容 |
|---|---|
| `packages/shared/src/` | schemas、rules、lookalike、sanitize、prompts、openai-compat、policy、score、domain、extract-form |
| `packages/extension/src/content/` | form-scanner、policy-scout、banner（唯一喺人哋頁面跑嘅 code） |
| `packages/extension/src/background/` | service worker、llm-router（連 managed 登入）、cache、offscreen 同背景分頁管理 |
| `packages/extension/src/offscreen/` | 條款頁嘅 fetch 同渲染（唯一有渲染引擎又唔受網頁 CSP 管嘅地方） |
| `packages/extension/src/ui/` | Popup、Options、MD3 components、生成嘅 token |
| `packages/server/src/` | Hono app、auth（auth.txt + token）、render（headless Chromium）、chromium（CDP client）、render-probe、bun:sqlite 快取 |
| `scripts/auth.ts` | `bun run auth add / list / remove` |
| `eval/` | fixtures、labels.csv、三個 harness、fixture server（CDP client 喺 server 度，兩邊共用） |

## 建置

`@crxjs/vite-plugin` 由 `manifest.json` 出發，一個 config 處理三種 target
（extension 頁、service worker ESM、content script）。

**冇用 SvelteKit**：MV3 嘅 `extension_pages` CSP 唔准任何遠端 script source，
所以 Vite dev server 嘅 HMR 連唔到 extension 頁面 —— 而 HMR 正正係
SvelteKit dev server 嘅主要價值。Routing / SSR / load / form actions
喺插件度全部用唔著，仲會 emit inline hydration script 撞 CSP，要一個會隨
版本更新而爛嘅 post-build hack 去補。CRXJS 用 background-script reload
繞開 CSP，component 寫法完全一樣。

**MD3 色彩**由 `scripts/gen-theme.ts` 喺開發時生成一次，
`@material/material-color-utilities` 留喺 devDependencies，唔會入 bundle。
出兩份：`:root` 畀 extension 頁，`:host` 畀 Shadow DOM 入面嘅 banner。
MD3 本身只有 `error` 一個語意色，`success` 同 `warning` 係用 custom color
功能額外生成，令三個風險等級喺 light / dark 行為一致。
