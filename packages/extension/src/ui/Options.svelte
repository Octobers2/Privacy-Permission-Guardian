<script lang="ts">
  import '@material/web/button/filled-button.js';
  import '@material/web/button/text-button.js';
  import '@material/web/radio/radio.js';
  import type { ConnectionCheck } from '@ppg/shared';
  import { DEFAULT_SETTINGS, LLM_MODES, registrableDomain, type Settings } from '@ppg/shared';
  import { loadSettings, saveSettings } from '../settings.ts';
  import Section from './components/Section.svelte';
  import Switch from './components/Switch.svelte';
  import TextField from './components/TextField.svelte';

  let settings = $state<Settings>({ ...DEFAULT_SETTINGS });
  let loaded = $state(false);
  let savedAt = $state(0);
  let newAllowlistEntry = $state('');
  let connection = $state<ConnectionCheck | null>(null);
  let testing = $state(false);

  const MODE_LABELS: Record<(typeof LLM_MODES)[number], { title: string; detail: string }> = {
    managed: {
      title: 'Managed backend',
      detail:
        '經 server 呼叫模型，同埋由佢用真瀏覽器打開條款頁（JS 先 render 嘅網站要靠呢樣）。' +
        'API key 留喺 server，要帳號密碼先用得。',
    },
    direct: {
      title: 'Direct (BYOK)',
      detail: '插件直接連你自己嘅 OpenAI-compatible endpoint。Key 只存喺呢部機。',
    },
  };

  loadSettings().then((stored) => {
    settings = stored;
    loaded = true;
  });

  async function persist(patch: Partial<Settings>): Promise<void> {
    settings = await saveSettings(patch);
    savedAt = Date.now();
  }

  async function testConnection(): Promise<void> {
    testing = true;
    connection = null;
    try {
      connection = await chrome.runtime.sendMessage({ type: 'test-connection' });
    } finally {
      testing = false;
    }
  }

  function addAllowlistEntry(): void {
    const domain = registrableDomain(newAllowlistEntry.trim().replace(/^https?:\/\//, ''));
    if (!domain) return;
    void persist({ allowlist: [...new Set([...settings.allowlist, domain])] });
    newAllowlistEntry = '';
  }

  function removeAllowlistEntry(domain: string): void {
    void persist({ allowlist: settings.allowlist.filter((d) => d !== domain) });
  }
</script>

<main>
  <header>
    <h1 class="md-typescale-headline-small">Privacy &amp; Permission Guardian</h1>
    <p class="md-typescale-body-medium">設定</p>
  </header>

  {#if loaded}
    <Section title="提示" description="控制插件喺網頁上嘅行為。">
      <Switch
        label="全域暫停"
        description="暫停之後唔會掃描任何頁面，工具列圖示會顯示暫停狀態。"
        checked={settings.paused}
        onchange={(paused) => persist({ paused })}
      />

      <label class="field">
        <span class="md-typescale-body-medium">敏感度：規則分數去到 {settings.llmThreshold} 分先問模型</span>
        <input
          type="range"
          min="10"
          max="80"
          step="5"
          value={settings.llmThreshold}
          oninput={(event) =>
            persist({ llmThreshold: Number((event.target as HTMLInputElement).value) })}
        />
        <span class="md-typescale-body-small hint">
          調低會問得密啲、捉多啲，但會用多啲 token；調高就相反。規則本身照樣離線運作。
        </span>
      </label>
    </Section>

    <Section title="模型 endpoint" description="任何 OpenAI-compatible 嘅 /chat/completions 都用得。">
      <fieldset>
        <legend class="md-typescale-label-large">連接方式</legend>
        {#each LLM_MODES as mode (mode)}
          <!--
            svelte-ignore a11y_label_has_associated_control
            Same as Switch.svelte: md-radio is form-associated.
          -->
          <label class="radio-row">
            <md-radio
              name="mode"
              value={mode}
              checked={settings.mode === mode}
              onchange={() => persist({ mode })}
            ></md-radio>
            <span>
              <span class="md-typescale-body-large">{MODE_LABELS[mode].title}</span>
              <span class="md-typescale-body-small hint">{MODE_LABELS[mode].detail}</span>
            </span>
          </label>
        {/each}
      </fieldset>

      {#if settings.mode === 'managed'}
        <TextField
          label="Server URL"
          bind:value={settings.managedUrl}
          supportingText="本機 Hono server 嘅位址"
        />
        <TextField
          label="帳號"
          bind:value={settings.managedUsername}
          supportingText="Server 嗰邊行 `bun run auth add <username>` 開嘅帳號"
        />
        <TextField
          label="密碼"
          type="password"
          bind:value={settings.managedPassword}
          supportingText="同 API key 一樣，只存喺呢部機嘅 chrome.storage.local，唔會同步"
        />
        <div class="actions">
          <md-filled-button
            onclick={() =>
              persist({
                managedUrl: settings.managedUrl,
                managedUsername: settings.managedUsername,
                managedPassword: settings.managedPassword,
              })}
          >
            儲存
          </md-filled-button>
          <md-text-button disabled={testing} onclick={testConnection}>
            {testing ? '測試緊…' : '測試連線'}
          </md-text-button>
        </div>
      {:else}
        <TextField label="Base URL" bind:value={settings.baseUrl} supportingText="例如 https://api.openai.com/v1" />
        <TextField
          label="API key"
          type="password"
          bind:value={settings.apiKey}
          supportingText="只存喺呢部機嘅 chrome.storage.local，唔會同步去其他裝置"
        />
        <TextField label="Model" bind:value={settings.model} supportingText="例如 gpt-4o-mini" />
        <div class="actions">
          <md-filled-button
            onclick={() =>
              persist({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model })}
          >
            儲存
          </md-filled-button>
          <md-text-button disabled={testing} onclick={testConnection}>
            {testing ? '測試緊…' : '測試連線'}
          </md-text-button>
        </div>
      {/if}
      <details>
        <summary class="md-typescale-label-large">進階</summary>
        <div class="advanced">
          <TextField
            label="Max tokens"
            type="number"
            value={String(settings.maxTokens)}
            supportingText="上限而唔係目標，調高對普通模型零成本。推理模型（Qwen3、DeepSeek-R1 之類）思考會食走大部分額度，建議 4000 以上。"
            onchange={(value) => persist({ maxTokens: Number(value) || DEFAULT_SETTINGS.maxTokens })}
          />
          <TextField
            label="Temperature"
            type="number"
            value={String(settings.temperature)}
            supportingText="0 = 每次結果一致。摘要同判斷都唔需要創意。"
            onchange={(value) => persist({ temperature: Number(value) })}
          />
          <TextField
            label="Timeout (ms)"
            type="number"
            value={String(settings.timeoutMs)}
            supportingText="本機模型或者長條款，可能要調高。"
            onchange={(value) => persist({ timeoutMs: Number(value) || DEFAULT_SETTINGS.timeoutMs })}
          />
        </div>
      </details>

      {#if connection}
        <p class="md-typescale-body-medium result" data-ok={connection.ok} aria-live="polite">
          {connection.ok ? '✓' : '✗'}
          {connection.message}
          {#if connection.ok}<span class="hint">（{connection.latencyMs} ms）</span>{/if}
        </p>
      {/if}
    </Section>

    <Section title="唔提示嘅網站" description="喺呢啲網域上唔會顯示任何表單提示。">
      {#if settings.allowlist.length === 0}
        <p class="md-typescale-body-medium hint">仲未有。喺提示橫額撳「呢個網站唔再提示」就會加入呢度。</p>
      {:else}
        <ul>
          {#each settings.allowlist as domain (domain)}
            <li>
              <span class="md-typescale-body-large">{domain}</span>
              <md-text-button onclick={() => removeAllowlistEntry(domain)}>移除</md-text-button>
            </li>
          {/each}
        </ul>
      {/if}
      <div class="add-row">
        <TextField label="加入網域" bind:value={newAllowlistEntry} placeholder="example.com" />
        <md-filled-button onclick={addAllowlistEntry}>加入</md-filled-button>
      </div>
    </Section>

    <Section title="呢個插件收咩、唔收咩">
      <ul class="facts">
        <li><strong>唔會外傳</strong>你喺表單打嘅任何內容 —— 只傳欄位嘅名稱同類型。</li>
        <li>送出去嘅網址<strong>剝走咗 query string</strong>。</li>
        <li>唔會記錄瀏覽歷史；快取只存到網域層級。</li>
        <li>
          插件需要「讀取所有網站資料」嘅權限，因為要喺任何一頁掃描表單。呢個權限大，所以我哋寫低咗
          全部細節喺 <code>docs/threat-model.md</code>。
        </li>
        <li>網站有辦法偵測到你裝咗呢個插件（MV3 content script 嘅已知限制）。</li>
        <li>
          用 managed 模式嘅時候，條款頁嘅<strong>網址</strong>會傳去你填嗰個 server，由佢用真瀏覽器
          打開嚟讀。佢用嘅唔係你嘅登入狀態，所以要登入先睇到嘅條款頁仍然由你部機自己讀。
        </li>
      </ul>
    </Section>

    {#if savedAt}
      <p class="md-typescale-body-small saved" aria-live="polite">已儲存</p>
    {/if}
  {/if}
</main>

<style>
  main {
    max-width: 680px;
    margin: 0 auto;
    padding: 32px 20px 64px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  header h1 {
    margin: 0;
  }
  header p {
    margin: 2px 0 0;
    color: var(--md-sys-color-on-surface-variant);
  }
  fieldset {
    border: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  legend {
    padding: 0 0 8px;
    color: var(--md-sys-color-on-surface-variant);
  }
  .radio-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    cursor: pointer;
  }
  .radio-row span span {
    display: block;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .hint {
    color: var(--md-sys-color-on-surface-variant);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  ul li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 0;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
  }
  ul.facts {
    list-style: disc;
    padding-left: 20px;
    gap: 8px;
  }
  ul.facts li {
    display: list-item;
    border: none;
    padding: 0;
    color: var(--md-sys-color-on-surface-variant);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .result {
    margin: 0;
    padding: 10px 12px;
    border-radius: 8px;
  }
  .result[data-ok='true'] {
    background: var(--md-sys-color-success-container);
    color: var(--md-sys-color-on-success-container);
  }
  .result[data-ok='false'] {
    background: var(--md-sys-color-error-container);
    color: var(--md-sys-color-on-error-container);
  }
  details {
    border-top: 1px solid var(--md-sys-color-outline-variant);
    padding-top: 12px;
  }
  summary {
    cursor: pointer;
    color: var(--md-sys-color-on-surface-variant);
  }
  .advanced {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding-top: 16px;
  }
  .add-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .saved {
    color: var(--md-sys-color-on-surface-variant);
    text-align: right;
  }
  input[type='range'] {
    width: 100%;
    accent-color: var(--md-sys-color-primary);
  }
  code {
    font-size: 0.9em;
    background: var(--md-sys-color-surface-container-high);
    padding: 1px 5px;
    border-radius: 4px;
  }
</style>
