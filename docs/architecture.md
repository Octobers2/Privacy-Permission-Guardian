# 架構

## 一句話

Content script 抽 DOM、畫橫額；service worker 做評分、快取同模型呼叫；
`packages/shared/` 係兩條路（本機 BYOK 同 managed server）唯一嗰份邏輯。

## 圖

```
┌──────────────────── Browser (Chrome / Edge, MV3) ─────────────────────┐
│                                                                       │
│  content script  (23 KB，每頁載入)     service worker (一個 session 一次)│
│  ├─ form-scanner ────────────────►    ├─ scoreForm（規則引擎）          │
│  │   extractForms(document)            ├─ chrome.storage 摘要快取       │
│  ├─ policy-scout ────────────────►    ├─ badge 顏色                    │
│  │   搵條款連結 → fetch → sanitize      └─ llm-router ─┬── managed ──┐  │
│  └─ banner (Shadow DOM，零 library)                    └── direct    │  │
│                                                                     │  │
│  popup.html / options.html  (Svelte 5 + @material/web)              │  │
└─────────────────────────────────────────────────────────────────────┼──┘
                                                                      │
         managed（預設）                        direct / BYOK          │
               │                                        │              │
               ▼                                        ▼              │
   ┌──── Hono on Bun :8787 ────┐         ┌── 用戶自填 endpoint ──┐      │
   │  /api/policy/summarize     │         │  POST {base}/chat/    │◄────┘
   │  /api/form/assess          │────────►│       completions     │
   │  /health                   │         └───────────────────────┘
   │  bun:sqlite 共用快取        │
   └────────────────────────────┘
```

## 三個唔明顯但關鍵嘅決定

### 1. 評分喺 service worker，唔喺頁面

規則引擎要 public suffix list（tldts）同 zod，合共約 330 kB。喺 worker
入面一個 browser session 載入一次，可以接受；喺用戶去嘅每一個網站都載入，
就同「輕量私隱工具」呢個前提直接矛盾。

Content script 淨低 DOM 抽取同繪圖，實測 **18.5 KB**。呢件事回歸過兩次
（一次係 import 咗規則引擎，一次係 `@ppg/shared` 未聲明 `sideEffects: false`），
兩次都冇報錯 —— 插件照行，只係靜靜雞肥咗。所以 `eval/bundle-budget.ts`
喺 e2e 度守住個 60 KB 預算。

### 2. 條款頁喺 offscreen document 讀，唔係 server、亦唔係 content script

Server-side fetch 會撞 Cloudflare、bot 攔截同地區重導向，攞返嚟嘅好可能
唔係用戶被要求同意嗰一版。

但喺 content script 讀都係錯，而且錯咗兩重：佢個 `fetch` 受**該網頁自己
嘅 CSP** 管（GitHub、Reddit 連自己嗰版私隱政策都 fetch 唔到），而
`DOMParser` 文件冇 browsing context，`getComputedStyle` 全部返空字串 ——
所有靠 computed style 嘅剝離檢查靜靜雞失效。

Offscreen document 兩樣都有：extension 權限（唔受網頁 CSP 管、帶用戶
session）加真渲染引擎。抓返嚟嘅 HTML 放入一個 `sandbox` 但冇
`allow-scripts` 嘅 iframe：冇嘢執行得到，但 stylesheet 載入到，
`getComputedStyle` 講真話。

連結搜尋仍然留喺 content script —— 得 live 頁面知道自己個 footer 連去邊。

### 3. `packages/shared/` 用 TypeScript，唔用 Python server

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
  → worker: chrome.tabs.sendMessage({ type: 'policy-candidates' })
      content: policyCandidates(document)       content/policy-scout.ts
  → worker: readPolicy(urls)                    background/offscreen.ts
      offscreen: fetch(url, credentials:'include')
                 → sandboxed iframe（冇 allow-scripts）→ 真 computed style
                 → pickMainContent → extractVisibleText
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
| `packages/extension/src/background/` | service worker、llm-router、cache、offscreen 管理 |
| `packages/extension/src/offscreen/` | 條款頁嘅 fetch 同渲染（唯一有渲染引擎又唔受網頁 CSP 管嘅地方） |
| `packages/extension/src/ui/` | Popup、Options、MD3 components、生成嘅 token |
| `packages/server/src/` | Hono app、bun:sqlite 快取 |
| `eval/` | fixtures、labels.csv、三個 harness、CDP client、fixture server |

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
