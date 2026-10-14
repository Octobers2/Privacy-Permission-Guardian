<script lang="ts">
  import '@material/web/button/filled-button.js';
  import '@material/web/button/outlined-button.js';
  import '@material/web/button/text-button.js';
  import { onMount, tick } from 'svelte';
  import { CATEGORY_LABELS, type ModelEntry } from '@ppg/shared';
  import { checkDevice, formatBytes, hasRoomFor, recommend, type DeviceReport } from '../engine/device.ts';
  import { isDownloaded, PpgEngine } from '../engine/engine.ts';
  import { DEFAULT_SERVER, loadPrefs, savePrefs } from '../prefs.ts';
  import Progress from '../ui/components/Progress.svelte';
  import Switch from '../ui/components/Switch.svelte';
  import TextField from '../ui/components/TextField.svelte';
  import { fetchModels, normaliseServer, signIn } from './api.ts';
  import { CLAUSE_SAMPLES, PAGE_SAMPLES } from './samples.ts';

  type Step = 'welcome' | 'device' | 'model' | 'download' | 'test' | 'options' | 'done';
  const STEPS: { id: Step; label: string }[] = [
    { id: 'welcome', label: 'Welcome' },
    { id: 'device', label: 'Your computer' },
    { id: 'model', label: 'Choose a model' },
    { id: 'download', label: 'Download' },
    { id: 'test', label: 'Quick test' },
    { id: 'options', label: 'Options' },
    { id: 'done', label: 'Done' },
  ];

  let step = $state<Step>('welcome');
  let heading = $state<HTMLElement>();

  let serverUrl = $state(DEFAULT_SERVER);
  let alreadySetUp = $state(false);

  // step: your computer
  let device = $state<DeviceReport | null>(null);
  let models = $state<ModelEntry[]>([]);
  let recommended = $state<ModelEntry | null>(null);
  let recommendation = $state('');
  let checking = $state(false);
  let checkError = $state('');

  // step: choose a model
  let selectedId = $state<string | null>(null);
  const selected = $derived(models.find((m) => m.id === selectedId) ?? null);

  // step: download
  let progress = $state({ fraction: 0, text: 'Starting…' });
  let downloadError = $state('');
  let downloading = $state(false);
  let engine: PpgEngine | null = null;

  // step: test
  interface TestRow {
    what: string;
    answer: string;
    ok: boolean;
  }
  let testRows = $state<TestRow[]>([]);
  let testing = $state(false);
  let testSeconds = $state(0);
  let testError = $state('');

  // step: options
  let summaryOn = $state(false);
  let username = $state('');
  let password = $state('');
  let signInBusy = $state(false);
  let signInError = $state('');
  let account = $state<{ username: string; token: string; expiresAt: number } | null>(null);
  let finishing = $state(false);

  const stepIndex = $derived(STEPS.findIndex((s) => s.id === step));

  onMount(async () => {
    const prefs = await loadPrefs();
    serverUrl = prefs.serverUrl;
    summaryOn = prefs.summary === 'server';
    account = prefs.account;
    alreadySetUp = prefs.setupDone;
  });

  // Move focus to the new step's heading so keyboard and screen-reader users land where the content changed.
  $effect(() => {
    void step;
    void tick().then(() => heading?.focus());
  });

  async function runCheck() {
    checkError = '';
    checking = true;
    device = null;
    try {
      serverUrl = normaliseServer(serverUrl);
      const [report, available] = await Promise.all([checkDevice(), fetchModels(serverUrl)]);
      device = report;
      models = available;
      const pick = recommend(available, report);
      recommended = pick.model;
      recommendation = pick.reason;
      selectedId = pick.model?.id ?? available[0]?.id ?? null;
    } catch (error) {
      checkError = error instanceof Error ? error.message : String(error);
    } finally {
      checking = false;
    }
  }

  async function download() {
    if (!selected || !device) return;
    downloadError = '';
    if (!hasRoomFor(device, selected.sizeBytes)) {
      downloadError = `There is not enough free browser storage for ${formatBytes(selected.sizeBytes)}. Free up some disk space and try again.`;
      return;
    }
    step = 'download';
    downloading = true;
    progress = { fraction: 0, text: (await isDownloaded(serverUrl, selected)) ? 'Already downloaded. Loading…' : 'Starting…' };
    await savePrefs({ serverUrl, modelId: selected.id });
    // Ask the browser not to evict a multi-gigabyte cache when disk space runs low.
    void navigator.storage.persist?.();
    try {
      await engine?.unload();
      engine = await PpgEngine.load({ serverUrl, model: selected, onProgress: (p) => (progress = p) });
      step = 'test';
      void runTest();
    } catch (error) {
      downloadError = friendly(error);
    } finally {
      downloading = false;
    }
  }

  function friendly(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    if (/integrity|sha256/i.test(text)) return 'The downloaded file did not match the server’s checksum, so it was thrown away. Try again; if it keeps happening, tell the server’s owner.';
    if (/quota|storage/i.test(text)) return 'The browser ran out of storage space for the model. Free up some disk space and try again.';
    if (/device lost|out of memory|OOM/i.test(text)) return 'Your graphics card ran out of memory loading this model. Go back and choose the smaller one.';
    if (/fetch|network|Failed to/i.test(text)) return 'The download was interrupted. Files that finished are kept, so trying again picks up where it stopped.';
    return text;
  }

  async function runTest() {
    if (!engine) return;
    testError = '';
    testRows = [];
    testing = true;
    const started = performance.now();
    try {
      for (const sample of CLAUSE_SAMPLES) {
        const result = await engine.classify(sample.text);
        testRows = [...testRows, { what: `“${sample.text.slice(0, 56)}…”`, answer: CATEGORY_LABELS[result.category], ok: result.category === sample.expect }];
      }
      if (engine.model.tasks.pii) {
        for (const page of PAGE_SAMPLES) {
          const result = await engine.askPersonal(page.url, page.text);
          testRows = [
            ...testRows,
            { what: `Is ${page.label} personal?`, answer: result.personal ? 'Yes, personal' : 'No, public', ok: result.personal === page.expectPersonal },
          ];
        }
      }
      testSeconds = (performance.now() - started) / 1000;
    } catch (error) {
      testError = error instanceof Error ? error.message : String(error);
    } finally {
      testing = false;
    }
  }

  async function doSignIn() {
    signInError = '';
    signInBusy = true;
    try {
      account = await signIn(serverUrl, username.trim(), password);
      password = '';
    } catch (error) {
      signInError = error instanceof Error ? error.message : String(error);
    } finally {
      signInBusy = false;
    }
  }

  async function finish() {
    finishing = true;
    await savePrefs({ setupDone: true, serverUrl, modelId: selected?.id ?? null, summary: summaryOn ? 'server' : 'off', account });
    await engine?.unload(); // the offscreen document loads it again from the cache when it is needed
    engine = null;
    step = 'done';
    finishing = false;
  }

  const allCorrect = $derived(testRows.length > 0 && testRows.every((r) => r.ok));
</script>

<main>
  <header>
    <p class="brand md-typescale-title-medium">Privacy &amp; Permission Guardian</p>
    <ol class="steps" aria-label="Setup progress">
      {#each STEPS as s, i}
        <li class:current={i === stepIndex} class:past={i < stepIndex} aria-current={i === stepIndex ? 'step' : undefined}>
          <span class="dot" aria-hidden="true">{i < stepIndex ? '✓' : i + 1}</span>
          <span class="name">{s.label}</span>
        </li>
      {/each}
    </ol>
  </header>

  <section class="card" aria-live="polite">
    {#if step === 'welcome'}
      <h1 bind:this={heading} tabindex="-1" class="md-typescale-headline-medium">Read the fine print, without reading it</h1>
      <p>
        This extension reads a website’s terms of service for you and points out clauses that tend to work against users, such as forced
        arbitration or the right to close your account without notice. It also warns you about forms that look like phishing.
      </p>
      <ul class="promises">
        <li><strong>It runs on your computer.</strong> A small AI model is downloaded once and does the reading locally.</li>
        <li><strong>Your pages stay with you.</strong> Nothing you read is sent anywhere unless you choose to share it.</li>
        <li><strong>Sharing is optional.</strong> If you opt in, only the flagged clauses of public policy pages are shared, never a page that shows personal data.</li>
      </ul>
      {#if alreadySetUp}
        <p class="note">Setup was already completed on this browser. Continue to check the model again or choose a different one.</p>
      {/if}
      <div class="actions"><md-filled-button onclick={() => (step = 'device')}>Get started</md-filled-button></div>
    {:else if step === 'device'}
      <h1 bind:this={heading} tabindex="-1" class="md-typescale-headline-medium">Check this computer</h1>
      <p>The model needs a graphics card that supports WebGPU. This takes a few seconds.</p>
      <TextField label="Server address" bind:value={serverUrl} type="url" supportingText="Where the model is downloaded from." />

      {#if checking}
        <div class="working"><Progress value={null} label="Checking your computer" /><p>Checking…</p></div>
      {/if}
      {#if checkError}
        <p class="error" role="alert">{checkError}</p>
      {/if}

      {#if device && !checking}
        <dl class="facts">
          <dt>Graphics</dt>
          <dd class:bad={!device.webgpu || device.software}>
            {device.webgpu ? (device.gpu ?? 'Detected') : 'Not available'}{device.software ? ' (software only)' : ''}
          </dd>
          <dt>Memory limit per buffer</dt>
          <dd>{device.maxStorageBufferBindingSize ? formatBytes(device.maxStorageBufferBindingSize) : '–'}</dd>
          <dt>Free browser storage</dt>
          <dd>{device.storage ? formatBytes(device.storage.quota - device.storage.usage) : 'Unknown'}</dd>
          <dt>Models offered</dt>
          <dd>{models.length}</dd>
        </dl>
        {#each device.problems as problem}
          <p class="error" role="alert">{problem}</p>
        {/each}
        {#if models.length === 0 && !device.problems.length}
          <p class="error" role="alert">The server has no models for this version of the extension.</p>
        {/if}
      {/if}

      <div class="actions">
        <md-text-button onclick={() => (step = 'welcome')}>Back</md-text-button>
        {#if device && !device.problems.length && models.length}
          <md-outlined-button onclick={runCheck}>Check again</md-outlined-button>
          <md-filled-button onclick={() => (step = 'model')}>Continue</md-filled-button>
        {:else}
          <md-filled-button onclick={runCheck} disabled={checking}>{device ? 'Check again' : 'Check my computer'}</md-filled-button>
        {/if}
      </div>
    {:else if step === 'model'}
      <h1 bind:this={heading} tabindex="-1" class="md-typescale-headline-medium">Choose a model</h1>
      <p>You can change this later in the settings. The download happens once and is kept in your browser.</p>
      <div class="models" role="radiogroup" aria-label="Model">
        {#each models as m (m.id)}
          <label class="model" class:chosen={selectedId === m.id}>
            <input type="radio" name="model" value={m.id} bind:group={selectedId} />
            <span class="body">
              <span class="title md-typescale-title-medium">
                {m.name}
                {#if recommended?.id === m.id}<span class="badge">Recommended</span>{/if}
              </span>
              <span class="size">{formatBytes(m.sizeBytes)} download</span>
              <span class="desc">
                {m.tier === 'fast'
                  ? 'Quick on most computers and accurate enough for everyday use.'
                  : 'The most accurate option, with a bigger download. Best on a computer with a dedicated graphics card.'}
              </span>
              <span class="detail">
                Clause-detection score {m.tasks.tos.testMacroF1?.toFixed(2) ?? '–'}
                {#if m.tasks.pii}· personal-data check catches {Math.round((m.tasks.pii.testRecall ?? 0) * 100)}% of private pages{/if}
              </span>
            </span>
          </label>
        {/each}
      </div>
      {#if recommendation}<p class="note">{recommendation}</p>{/if}
      {#if downloadError}<p class="error" role="alert">{downloadError}</p>{/if}
      <div class="actions">
        <md-text-button onclick={() => (step = 'device')}>Back</md-text-button>
        <md-filled-button onclick={download} disabled={!selected}>
          Download {selected ? formatBytes(selected.sizeBytes) : ''}
        </md-filled-button>
      </div>
    {:else if step === 'download'}
      <h1 bind:this={heading} tabindex="-1" class="md-typescale-headline-medium">Downloading {selected?.name ?? 'the model'}</h1>
      {#if !downloadError}
        <Progress value={progress.fraction > 0 ? progress.fraction : null} label="Download progress" />
        <p class="progress-text">
          {Math.round(progress.fraction * 100)}%
          {#if selected}· {formatBytes(selected.sizeBytes * progress.fraction)} of {formatBytes(selected.sizeBytes)}{/if}
        </p>
        <p class="note">{progress.text}</p>
        <p class="note">You can leave this tab open in the background. If the download is interrupted, files that finished are kept.</p>
      {:else}
        <p class="error" role="alert">{downloadError}</p>
        <div class="actions">
          <md-text-button onclick={() => (step = 'model')}>Back</md-text-button>
          <md-filled-button onclick={download} disabled={downloading}>Try again</md-filled-button>
        </div>
      {/if}
    {:else if step === 'test'}
      <h1 bind:this={heading} tabindex="-1" class="md-typescale-headline-medium">Quick test</h1>
      <p>Asking the model a few things it should know. This confirms it works on your graphics card.</p>
      {#if testing && testRows.length === 0}<Progress value={null} label="Running the test" />{/if}
      <table class="results">
        <tbody>
          {#each testRows as row}
            <tr class:wrong={!row.ok}>
              <td class="mark" aria-label={row.ok ? 'as expected' : 'different from expected'}>{row.ok ? '✓' : '•'}</td>
              <td>{row.what}</td>
              <td class="answer">{row.answer}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if testError}<p class="error" role="alert">Something went wrong: {testError}</p>{/if}
      {#if !testing && testRows.length && !testError}
        <p class="note">
          {allCorrect ? 'Everything works as expected.' : 'The model works. Some answers differ from what we expected, which can happen with short samples.'}
          Answered {testRows.length} questions in {testSeconds.toFixed(1)} s.
        </p>
      {/if}
      <div class="actions">
        {#if testError}<md-filled-button onclick={runTest}>Try again</md-filled-button>{/if}
        <md-filled-button onclick={() => (step = 'options')} disabled={testing || !testRows.length}>Continue</md-filled-button>
      </div>
    {:else if step === 'options'}
      <h1 bind:this={heading} tabindex="-1" class="md-typescale-headline-medium">Two optional extras</h1>

      <h2 class="md-typescale-title-large">Plain-language summaries</h2>
      <Switch
        checked={summaryOn}
        label="Explain flagged clauses in plain English"
        description="When on, the flagged clauses of a public policy page (never the whole page, and never a page that shows personal data) are sent to the server, which asks an AI model to write a short explanation. Off by default; change it any time in the settings."
        onchange={(value) => (summaryOn = value)}
      />

      <h2 class="md-typescale-title-large">Share what you find</h2>
      {#if account}
        <p class="note">Signed in as <strong>{account.username}</strong>. Results from public policy pages will be shared so others can look them up.</p>
        <md-text-button onclick={() => (account = null)}>Sign out</md-text-button>
      {:else}
        <p>
          If you have a contributor account, you can share what the model finds so other people can look it up without running a model.
          Only flagged clauses from public policy pages are shared, with no personal data and no browsing history. Skip this if you do not have an account.
        </p>
        <TextField label="Username" bind:value={username} />
        <TextField label="Password" bind:value={password} type="password" />
        {#if signInError}<p class="error" role="alert">{signInError}</p>{/if}
        <div class="actions left">
          <md-outlined-button onclick={doSignIn} disabled={signInBusy || !username || !password}>Sign in</md-outlined-button>
        </div>
      {/if}

      <div class="actions">
        <md-text-button onclick={() => (step = 'test')}>Back</md-text-button>
        <md-filled-button onclick={finish} disabled={finishing}>Finish setup</md-filled-button>
      </div>
    {:else}
      <h1 bind:this={heading} tabindex="-1" class="md-typescale-headline-medium">You’re all set</h1>
      <p>
        Browse as usual. When you open a site’s terms or privacy policy, the toolbar icon shows what was found. Pin the extension to keep it in view.
      </p>
      <ul class="promises">
        <li>The model: <strong>{selected?.name ?? 'installed'}</strong>, kept in this browser.</li>
        <li>Summaries: <strong>{summaryOn ? 'on' : 'off'}</strong>. Sharing: <strong>{account ? `on, as ${account.username}` : 'off'}</strong>.</li>
      </ul>
      <p class="note">You can change all of this, switch models, or remove the download from the extension’s settings.</p>
      <div class="actions"><md-filled-button onclick={() => window.close()}>Close this tab</md-filled-button></div>
    {/if}
  </section>
</main>

<style>
  main {
    max-width: 760px;
    margin: 0 auto;
    padding: 24px 16px 64px;
    box-sizing: border-box;
  }
  .brand {
    margin: 0 0 16px;
    color: var(--md-sys-color-primary);
  }
  .steps {
    display: flex;
    gap: 4px;
    list-style: none;
    margin: 0 0 24px;
    padding: 0;
    flex-wrap: wrap;
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px 4px 4px;
    border-radius: 999px;
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.8125rem;
  }
  .steps li.current {
    background: var(--md-sys-color-secondary-container);
    color: var(--md-sys-color-on-secondary-container);
    font-weight: 600;
  }
  .dot {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 1px solid var(--md-sys-color-outline);
    font-size: 0.75rem;
  }
  .past .dot {
    background: var(--md-sys-color-primary);
    border-color: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
  }
  .current .dot {
    border-color: var(--md-sys-color-on-secondary-container);
  }
  @media (max-width: 640px) {
    .steps li:not(.current) .name {
      display: none;
    }
  }
  .card {
    background: var(--md-sys-color-surface-container-low);
    border-radius: 28px;
    padding: 32px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  @media (max-width: 480px) {
    .card {
      padding: 20px;
      border-radius: 20px;
    }
  }
  h1,
  h2,
  p,
  ul,
  dl {
    margin: 0;
  }
  h1:focus {
    outline: none;
  }
  h2 {
    margin-top: 8px;
  }
  .promises {
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .note {
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.875rem;
  }
  .error {
    color: var(--md-sys-color-error);
    background: var(--md-sys-color-error-container);
    padding: 12px 16px;
    border-radius: 12px;
    font-size: 0.875rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
  .actions.left {
    justify-content: flex-start;
  }
  .working {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 8px 24px;
    background: var(--md-sys-color-surface-container);
    padding: 16px;
    border-radius: 16px;
  }
  .facts dt {
    color: var(--md-sys-color-on-surface-variant);
  }
  .facts dd {
    margin: 0;
  }
  .facts dd.bad {
    color: var(--md-sys-color-error);
  }
  .models {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .model {
    display: flex;
    gap: 16px;
    padding: 16px;
    border-radius: 16px;
    border: 1px solid var(--md-sys-color-outline-variant);
    cursor: pointer;
    background: var(--md-sys-color-surface);
  }
  .model.chosen {
    border-color: var(--md-sys-color-primary);
    background: var(--md-sys-color-primary-container);
    color: var(--md-sys-color-on-primary-container);
  }
  .model:focus-within {
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: 2px;
  }
  .model input {
    margin-top: 4px;
    accent-color: var(--md-sys-color-primary);
  }
  .model .body {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .badge {
    margin-left: 8px;
    padding: 2px 8px;
    border-radius: 8px;
    background: var(--md-sys-color-tertiary-container);
    color: var(--md-sys-color-on-tertiary-container);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .size {
    font-weight: 600;
  }
  .detail {
    font-size: 0.75rem;
    opacity: 0.8;
  }
  .progress-text {
    font-variant-numeric: tabular-nums;
  }
  .results {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  .results td {
    padding: 8px 8px 8px 0;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
    vertical-align: top;
  }
  .results .mark {
    width: 24px;
    color: var(--md-sys-color-primary);
    font-weight: 700;
  }
  .results .wrong .mark {
    color: var(--md-sys-color-tertiary);
  }
  .results .answer {
    text-align: right;
    font-weight: 600;
    white-space: nowrap;
  }
</style>
