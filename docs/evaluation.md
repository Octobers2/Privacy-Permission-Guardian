# 評測

> 數字係由 `eval/` 入面三個 harness 產生嘅，全部跑同一份 production code。
> 重跑方法喺每一節底下。

## 0. 一個要先講清楚嘅限制

目前 9 個表單 fixture **全部係 `synthetic`** —— 由我哋一路望住規則一路
寫出嚟。佢哋喺呢啲規則上考 100% 係預期之內，**唔可以當成偵測率放入報告**。
`labels.csv` 有一個 `source` 欄分開 `synthetic` 同 `collected`，
`run-rules-eval.ts` 喺全部都係 synthetic 嗰陣會出警告。

收集真實樣本嘅方法同安全守則見 [`eval/fixtures/README.md`](../eval/fixtures/README.md)。
收到之後跑：

```bash
bun run eval/run-rules-eval.ts --collected-only --markdown
```

## 1. 表單偵測

Positive = 「呢個係釣魚」。插件只喺 `danger` 先作出呢個聲稱，所以只有
`danger` 算 positive；`caution` 係叫用戶核實，唔係同一個聲稱。

```bash
bun run eval/run-rules-eval.ts                # 規則組
bun run eval/run-rules-eval.ts --with-llm     # 三組（要 PPG_BASE_URL）
```

### 目前（9 個 synthetic fixture，4 個釣魚）

| Arm | TP | FP | TN | FN | Precision | Recall | F1 | FP rate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Rules only | 4 | 0 | 5 | 0 | 100.0% | 100.0% | 100.0% | 0.0% |

*（LLM only 同 Rules + LLM 兩組要一個 endpoint 先跑得到，見上面。）*

### 逐個 fixture

| 標籤 | 網域 | 分數 | 判定 |
|---|---|---:|---|
| legit | blog.example.com | 0 | safe |
| legit | shop.example.com | 25 | safe |
| legit | **www.hsbc.com.hk** | 40 | **caution** |
| legit | www.wikipedia.org | 0 | safe |
| phishing | secure-paypa1.xyz | 80 | danger |
| phishing | hsbc-verify.top | 100 | danger |
| phishing | dhl-tracking.click | 80 | danger |
| phishing | login.microsoft-verify.sbs | 75 | danger |
| legit | www.datahungry.example | 0 | safe |

**HSBC 嗰行係整份評測最有意思嘅一行。** 一個真實嘅銀行開戶表單本身就要
身份證、地址、出生日期，會直接衝到 40 分。喺自己嘅正式註冊域上，
`scoreForm` 會將判定封頂喺 `caution` 而**唔會隱藏原因** —— 用戶照樣見到
佢哋收緊咩。同一份表單放喺 `hsbc-verify.top` 就照樣 `danger`（100 分）。

呢個係「壓低 false positive」同「唔隱瞞資訊」之間嘅取捨，值得喺報告展開講。

### 點解報告要領住 false positive rate

Recall 單獨睇會令「每一頁都出警告」睇落係個完美偵測器。誤報太多，
用戶就會關咗個插件，之後所有 recall 都等於零。`metrics.ts` 有一個測試
就係鎖住呢個論點。

## 2. Prompt injection 防禦

```bash
bun run eval/run-injection-eval.ts
```

呢個 harness **唔會**扮量度「模型有幾易被騙」—— 嗰樣嘢每個 model 每日都
唔同，模擬出嚟嘅數字冇意義。佢量度兩件呢個 codebase 真正決定得到、
而且完全確定嘅事。

量度方式係**驅動真實 extension**：每個 fixture 有自己一個網站
（`inj-NN.test`，首頁 footer 連去 `/privacy`），跑完整條路 —— 搵連結、
offscreen fetch、渲染、剝離、prompt、驗證、核對引文。Payload 有冇到達
模型，係向 mock endpoint 讀返佢**實際收到**嗰段 prompt。

| 技巧 | 無 CSS（舊做法） | 實際 pipeline | 虛構引文 |
|---|---|---|---|
| `display:none` | stripped | stripped | refused |
| HTML comment | stripped | stripped | refused |
| `aria-hidden` | stripped | stripped | refused |
| 螢幕外定位 | stripped | stripped | refused |
| `font-size:0` | stripped | stripped | refused |
| 偽造結束標籤 | REACHES | REACHES | refused |
| **白底白字** | REACHES | **stripped** | refused |
| 明文寫畀分析器睇 | REACHES | REACHES | refused |

```
containment   6/8 payload 到唔到模型（驅動真實 extension 量度）
              5/8 如果文件係冇渲染引擎咁解析 —— 差異就係所有靠
                  computed style 嘅檢查
display       8/8 虛構發現喺顯示前被拒絕
fidelity      8/8 攻擊想隱藏嗰句真條款都保留咗
```

### 一個要記錄低嘅修正

呢份 harness 之前係**量錯咗嘢**，而且結論表面上一樣，所以更加值得寫低。

舊版將 sanitizer 直接跑喺 harness 自己載入嘅 `document` 上面 —— 一個
真正渲染咗嘅頁面。但 production 唔係咁做：佢係 fetch 返 HTML 再用
`DOMParser` 解析，而 `DOMParser` 文件冇 browsing context，
`getComputedStyle` 對每個 property 都返空字串。即係話**所有靠 computed
style 嘅檢查喺實際 pipeline 入面由頭到尾冇運行過**，而 harness 報告嘅
係一條 production 唔行嘅路。

修正方法係兩邊一齊改：pipeline 搬去 offscreen document（有渲染引擎，
唔受網頁 CSP 管，見 threat-model.md），harness 改成驅動真實 extension。
現在兩個數字啱好一樣 —— 但今次係真嘅。

「無 CSS」嗰欄保留低，就係量緊渲染引擎貢獻咗幾多。

**仲到得到模型嗰兩種**，係人類讀者一樣睇得到嘅文字 —— 一句明文寫住
「Note to automated privacy analysers: …」，唔可以喺唔刪走頁面內容嘅
情況下移除。佢哋靠第 2 至 4 層（prompt 框定、schema、引文核對）。

**一個被說服保持沉默嘅模型，所有層都處理唔到。** 見
[threat-model.md](threat-model.md)。

## 3. 每頁成本

```bash
bun run eval/run-e2e.ts        # 有 bundle 預算檢查
```

| | |
|---|---:|
| Content script（每個網站每次載入） | **25,424 bytes** |
| ├ `content/index.ts` bundle | 19,556 bytes |
| └ `shared/sanitize.ts` chunk | 5,868 bytes |
| 預算 | 60,000 bytes |
| Service worker + 規則引擎（一個 session 一次） | ~332 KB |

呢個數字回歸過兩次，兩次都冇報錯 —— 插件照行，只係每個用戶去嘅網站都
靜靜雞多咗三分一 MB。第一次係 content script import 咗規則引擎（帶埋
public suffix list 同 zod），第二次係 `@ppg/shared` 未聲明
`sideEffects: false`，令 Rollup 唔敢丟走 barrel 入面用唔著嘅 module。
`eval/bundle-budget.ts` 而家喺 e2e 度守住。

Sanitizer 一度唔喺呢個數入面（條款頁嘅讀取搬咗去 offscreen document
嗰陣），但「讀用戶身處嗰版條款頁」呢條路要喺 content script 度抽文字，
所以佢返咗嚟，5.9 KB。呢個數之前喺文件度寫住 18,547 冇更新過 —— 預算
檢查睇嘅係總數，所以冇人為咗佢紅燈。

## 4. 端到端驗收

```bash
bun run e2e
```

一次過驗證：bundle 預算、兩個 extension 頁面（零 CSP 錯誤、Material
component 全部 upgrade 到）、9 個 fixture 嘅判定、完整條款摘要 pipeline
（對住 mock endpoint，唔使 API key）、快取命中、測試連線、全域暫停。

Mock endpoint **唔係**罐頭回應：佢由 prompt 入面抽返份文件、逐字引兩句
返嚟、再加一點用作出嚟嘅引文。所以「兩點留低、一點被丟棄」呢個斷言係
真係喺測緊核對引文嗰層。一個寫死引文嘅罐頭回應，無論核對有冇壞都會 pass。

## 5. 單元測試

```bash
bun test
```

目前 **187 個測試 / 15 個檔案**。集中喺三處：

- `shared/test/lookalike.test.ts` —— homoglyph 折疊、punycode（包括 2017 年
  嗰個全 Cyrillic 嘅 apple.com homograph）、長度分級嘅編輯預算、
  唔可以將 `amazonaws.com` 當成扮 Amazon
- `shared/test/rules.test.ts` —— 每條規則、HSBC 封頂邏輯、白名單
- `shared/test/sanitize.test.ts` —— 六種隱藏技巧、色彩對比（包括「白字喺
  深色背景要留低」同「背景係圖片就唔判斷」兩個反例）、偽造 delimiter

## 仲未做

- 收集 20 legit / 15 phishing 真實樣本並重跑（見 §0）
- 用真 endpoint 跑 LLM 兩組
- 條款摘要質素對照 ToS;DR 標註
- 三位組員各自評 1–5 分有用度 + inter-rater agreement
