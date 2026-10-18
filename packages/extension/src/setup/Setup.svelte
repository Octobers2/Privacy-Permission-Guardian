<script lang="ts">
  import '@material/web/button/filled-button.js';
  import '@material/web/button/outlined-button.js';
  import '@material/web/button/text-button.js';
  import { onMount, tick } from 'svelte';
  import { CATEGORY_LABELS, type ModelEntry } from '@ppg/shared';
  import { checkDevice, formatBytes, hasRoomFor, recommend, type DeviceReport } from '../engine/device.ts';
  import { isDownloaded, PpgEngine } from '../engine/engine.ts';
  import { DEFAULT_SERVER, loadPrefs, savePrefs } from '../prefs.ts';
  import DocumentStrip from '../ui/components/DocumentStrip.svelte';
  import Icon from '../ui/components/Icon.svelte';
  import Mark from '../ui/components/Mark.svelte';
  import Progress from '../ui/components/Progress.svelte';
  import Switch from '../ui/components/Switch.svelte';
  import TextField from '../ui/components/TextField.svelte';
  import { checkServer, fetchModels, normaliseServer, signIn } from './api.ts';
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

  // shared-only mode: no model, only what others have already shared
  let sharedOnly = $state(false);
  let sharedBusy = $state(false);

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

  async function useSharedOnly() {
    checkError = '';
    sharedBusy = true;
    try {
      serverUrl = normaliseServer(serverUrl);
      await checkServer(serverUrl);
      await engine?.unload();
      engine = null;
      await savePrefs({ setupDone: true, serverUrl, mode: 'shared', modelId: null, summary: 'off', account: null });
      sharedOnly = true;
      step = 'done';
    } catch (error) {
      checkError = error instanceof Error ? error.message : String(error);
    } finally {
      sharedBusy = false;
    }
  }

  async function finish() {
    finishing = true;
    await savePrefs({ setupDone: true, serverUrl, mode: 'device', modelId: selected?.id ?? null, summary: summaryOn ? 'server' : 'off', account });
    await engine?.unload(); // the offscreen document loads it again from the cache when it is needed
    engine = null;
    step = 'done';
    finishing = false;
  }

  // Where the example clauses sit in the welcome strip: spread through a document, in clusters, like real terms.
  const DEMO = [9, 22, 23, 41, 58, 59, 63, 80, 97, 104].map((index, i) => ({ index, category: (['arbitration', 'limitation_of_liability', 'unilateral_termination', 'contract_by_using', 'jurisdiction', 'unilateral_change', 'limitation_of_liability', 'content_removal', 'arbitration', 'choice_of_law'] as const)[i]! }));

  const allCorrect = $derived(testRows.length > 0 && testRows.every((r) => r.ok));
</script>

<div class="shell">
  <aside class="rail" aria-label="Setup progress">
    <div class="brand"><Mark size={32} /><span>Terms check</span></div>
    <ol class="steps">
      {#each STEPS as s, i}
        <li class:current={i === stepIndex} class:past={i < stepIndex} aria-current={i === stepIndex ? 'step' : undefined}>
          <span class="dot" aria-hidden="true">{#if i < stepIndex}<Icon name="check" size={14} />{:else}{i + 1}{/if}</span>
          <span class="name">{s.label}</span>
        </li>
      {/each}
    </ol>
    <p class="compact" aria-hidden="true">Step {stepIndex + 1} of {STEPS.length} · {STEPS[stepIndex]?.label}</p>
  </aside>

  <main>
    <section class="content" aria-live="polite">
      {#if step === 'welcome'}
        <div class="hero" aria-hidden="true"><DocumentStrip total={120} flagged={DEMO} reveal height={56} /></div>
        <h1 bind:this={heading} tabindex="-1">Read the fine print, without reading it</h1>
        <p class="lead">
          This extension reads a site’s terms of service and points out the clauses that tend to work against you, such as forced arbitration or the right to close your
          account without notice. It also warns you about forms that look like phishing.
        </p>
        <ul class="promises">
          <li><Icon name="laptop" size={22} /><div><strong>It runs on your computer.</strong> A small model is downloaded once and does the reading locally.</div></li>
          <li><Icon name="lock" size={22} /><div><strong>Your pages stay with you.</strong> Nothing you read is sent anywhere unless you choose to share it.</div></li>
          <li><Icon name="upload" size={22} /><div><strong>Sharing is optional.</strong> If you opt in, only the flagged clauses of public terms pages are shared, never a page that shows personal data.</div></li>
        </ul>
        {#if alreadySetUp}<p class="note">Setup was already completed on this browser. Continue to check the model again or choose a different one.</p>{/if}
        <div class="actions"><md-filled-button onclick={() => (step = 'device')}>Get started</md-filled-button></div>
      {:else if step === 'device'}
        <h1 bind:this={heading} tabindex="-1">Check this computer</h1>
        <p class="lead">The model needs a graphics card that supports WebGPU. This takes a few seconds.</p>
        <TextField label="Server address" bind:value={serverUrl} type="url" supportingText="Where the model is downloaded from." />

        {#if checking}
          <div class="working"><Progress value={null} label="Checking your computer" /><p class="note">Checking…</p></div>
        {/if}
        {#if checkError}<p class="error" role="alert"><Icon name="alert" size={18} />{checkError}</p>{/if}

        {#if device && !checking}
          <dl class="facts">
            <dt>Graphics</dt>
            <dd class:bad={!device.webgpu || device.software}>
              <Icon name={device.webgpu && !device.software ? 'check' : 'alert'} size={16} />
              {device.webgpu ? (device.gpu ?? 'Detected') : 'Not available'}{device.software ? ' (software only)' : ''}
            </dd>
            <dt>Memory limit per buffer</dt>
            <dd>{device.maxStorageBufferBindingSize ? formatBytes(device.maxStorageBufferBindingSize) : '–'}</dd>
            <dt>Free browser storage</dt>
            <dd>{device.storage ? formatBytes(device.storage.quota - device.storage.usage) : 'Unknown'}</dd>
            <dt>Models offered</dt>
            <dd>{models.length}</dd>
          </dl>
          {#each device.problems as problem}<p class="error" role="alert"><Icon name="alert" size={18} />{problem}</p>{/each}
          {#if models.length === 0 && !device.problems.length}
            <p class="error" role="alert"><Icon name="alert" size={18} />The server has no models for this version of the extension.</p>
          {/if}
        {/if}

        {#if device && !checking}
          <div class="panel" id="shared-option">
            <h2>{device.problems.length ? 'No model on this computer' : 'Or skip the model'}</h2>
            <p>
              You can use the extension without a model. It then looks up what other people’s computers have already found in a site’s terms. Nothing is read or analysed on this
              computer, and no graphics card is needed. The server is told the name of each website you look up, nothing else. Sites nobody has read yet show no result.
            </p>
            <div class="actions left"><md-outlined-button onclick={useSharedOnly} disabled={sharedBusy}>Use shared results only</md-outlined-button></div>
          </div>
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
        <h1 bind:this={heading} tabindex="-1">Choose a model</h1>
        <p class="lead">You can change this later in the settings. The download happens once and is kept in your browser.</p>
        <div class="models" role="radiogroup" aria-label="Model">
          {#each models as m (m.id)}
            <label class="model" class:chosen={selectedId === m.id}>
              <input type="radio" name="model" value={m.id} bind:group={selectedId} />
              <span class="body">
                <span class="title">
                  {m.name}
                  {#if recommended?.id === m.id}<span class="badge">Recommended</span>{/if}
                </span>
                <span class="desc">
                  {m.tier === 'fast'
                    ? 'Quick on most computers and accurate enough for everyday use.'
                    : 'The most accurate option, with a bigger download. Best with a dedicated graphics card.'}
                </span>
                <span class="stats">
                  <span class="stat strong">{formatBytes(m.sizeBytes)} download</span>
                  <span class="stat">Clause score {m.tasks.tos.testMacroF1?.toFixed(2) ?? '–'}</span>
                  {#if m.tasks.pii}<span class="stat">Catches {Math.round((m.tasks.pii.testRecall ?? 0) * 100)}% of private pages</span>{/if}
                </span>
              </span>
              <span class="tick" aria-hidden="true"><Icon name="check" size={18} /></span>
            </label>
          {/each}
        </div>
        {#if recommendation}<p class="note">{recommendation}</p>{/if}
        {#if downloadError}<p class="error" role="alert"><Icon name="alert" size={18} />{downloadError}</p>{/if}
        <div class="actions">
          <md-text-button onclick={() => (step = 'device')}>Back</md-text-button>
          <md-filled-button onclick={download} disabled={!selected}>Download {selected ? formatBytes(selected.sizeBytes) : ''}</md-filled-button>
        </div>
      {:else if step === 'download'}
        <h1 bind:this={heading} tabindex="-1">Downloading {selected?.name ?? 'the model'}</h1>
        {#if !downloadError}
          <Progress value={progress.fraction > 0 ? progress.fraction : null} label="Download progress" />
          <p class="progress-text">
            <strong>{Math.round(progress.fraction * 100)}%</strong>
            {#if selected}<span>{formatBytes(selected.sizeBytes * progress.fraction)} of {formatBytes(selected.sizeBytes)}</span>{/if}
          </p>
          <p class="note">{progress.text}</p>
          <p class="note">You can leave this tab open in the background. If the download is interrupted, files that finished are kept.</p>
        {:else}
          <p class="error" role="alert"><Icon name="alert" size={18} />{downloadError}</p>
          <div class="actions">
            <md-text-button onclick={() => (step = 'model')}>Back</md-text-button>
            <md-filled-button onclick={download} disabled={downloading}>Try again</md-filled-button>
          </div>
        {/if}
      {:else if step === 'test'}
        <h1 bind:this={heading} tabindex="-1">Quick test</h1>
        <p class="lead">Asking the model a few things it should know. This confirms it works on your graphics card.</p>
        {#if testing && testRows.length === 0}<Progress value={null} label="Running the test" />{/if}
        <table class="results">
          <tbody>
            {#each testRows as row}
              <tr class:wrong={!row.ok}>
                <td class="mark" aria-label={row.ok ? 'as expected' : 'different from expected'}>{row.ok ? '✓' : '•'}</td>
                <td class="what">{row.what}</td>
                <td class="answer">{row.answer}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if testError}<p class="error" role="alert"><Icon name="alert" size={18} />Something went wrong: {testError}</p>{/if}
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
        <h1 bind:this={heading} tabindex="-1">Two optional extras</h1>
        <div class="panel">
          <h2>Plain-language summaries</h2>
          <Switch
            checked={summaryOn}
            label="Explain flagged clauses in plain English"
            description="When on, the flagged clauses of a public terms page (never the whole page, and never a page that shows personal data) are sent to the server, which asks an AI model to write a short explanation. Off by default; change it any time in the settings."
            onchange={(value) => (summaryOn = value)}
          />
        </div>
        <div class="panel">
          <h2>Share what you find</h2>
          {#if account}
            <p>Signed in as <strong>{account.username}</strong>. Results from public terms pages will be shared so others can look them up.</p>
            <div class="actions left"><md-text-button onclick={() => (account = null)}>Sign out</md-text-button></div>
          {:else}
            <p>
              If you have a contributor account, you can share what the model finds so other people can look it up without running a model. Only flagged clauses from public
              terms pages are shared, with no personal data and no browsing history. Skip this if you do not have an account.
            </p>
            <TextField label="Username" bind:value={username} />
            <TextField label="Password" bind:value={password} type="password" />
            {#if signInError}<p class="error" role="alert"><Icon name="alert" size={18} />{signInError}</p>{/if}
            <div class="actions left"><md-outlined-button onclick={doSignIn} disabled={signInBusy || !username || !password}>Sign in</md-outlined-button></div>
          {/if}
        </div>
        <div class="actions">
          <md-text-button onclick={() => (step = 'test')}>Back</md-text-button>
          <md-filled-button onclick={finish} disabled={finishing}>Finish setup</md-filled-button>
        </div>
      {:else}
        <div class="done-mark" aria-hidden="true"><Icon name="check" size={30} /></div>
        <h1 bind:this={heading} tabindex="-1">You’re all set</h1>
        {#if sharedOnly}
          <p class="lead">Browse as usual. On any site, open the toolbar icon and choose <strong>Look up results</strong> to see what others found in its terms. Pin the extension to keep it in view.</p>
          <ul class="summary-list">
            <li>Mode: <strong>shared results only</strong>. No model is installed.</li>
          </ul>
          <p class="note">You can add an on-device model later from the extension’s settings.</p>
        {:else}
          <p class="lead">Browse as usual. When you open a site’s terms of service, open the toolbar icon and choose <strong>Read the terms</strong>. Pin the extension to keep it in view.</p>
          <ul class="summary-list">
            <li>Model: <strong>{selected?.name ?? 'installed'}</strong>, kept in this browser.</li>
            <li>Summaries: <strong>{summaryOn ? 'on' : 'off'}</strong>. Sharing: <strong>{account ? `on, as ${account.username}` : 'off'}</strong>.</li>
          </ul>
          <p class="note">You can change all of this, switch models, or remove the download from the extension’s settings.</p>
        {/if}
        <div class="actions"><md-filled-button onclick={() => window.close()}>Close this tab</md-filled-button></div>
      {/if}
    </section>
  </main>
</div>

<style>
  .shell {
    min-height: 100vh;
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
  }

  /* ---- left rail: where you are in a sequence, so numbering is information here */
  .rail {
    position: sticky;
    top: 0;
    align-self: start;
    height: 100vh;
    box-sizing: border-box;
    padding: 32px 28px;
    background: var(--md-sys-color-surface-container-low);
    border-right: 1px solid var(--md-sys-color-outline-variant);
    display: flex;
    flex-direction: column;
    gap: 36px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    font-weight: 600;
    font-size: 1.0625rem;
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .steps li {
    position: relative;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 9px 0;
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.875rem;
  }
  .steps li:not(:last-child)::after {
    content: '';
    position: absolute;
    left: 12px;
    top: 36px;
    width: 1px;
    height: 14px;
    background: var(--md-sys-color-outline-variant);
  }
  .dot {
    flex: none;
    display: grid;
    place-items: center;
    width: 25px;
    height: 25px;
    border-radius: 50%;
    border: 1px solid var(--md-sys-color-outline);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    background: var(--md-sys-color-surface-container-low);
  }
  .past .dot {
    background: var(--md-sys-color-primary);
    border-color: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
  }
  .current {
    color: var(--md-sys-color-on-surface);
    font-weight: 600;
  }
  .current .dot {
    border: 2px solid var(--md-sys-color-primary);
    color: var(--md-sys-color-primary);
  }
  .compact {
    display: none;
    margin: 0;
    font-size: 0.8125rem;
    color: var(--md-sys-color-on-surface-variant);
  }

  /* ---- content */
  main {
    padding: 56px 40px 80px;
    display: flex;
    justify-content: center;
  }
  .content {
    width: 100%;
    max-width: 580px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  h1 {
    margin: 0;
    font-size: 1.875rem;
    font-weight: 600;
    line-height: 1.18;
    letter-spacing: -0.012em;
    text-wrap: balance;
  }
  h1:focus {
    outline: none;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  p {
    margin: 0;
  }
  .lead {
    font-size: 1rem;
    line-height: 1.55;
    color: var(--md-sys-color-on-surface-variant);
    max-width: 62ch;
  }
  .hero {
    padding: 8px 0 12px;
  }
  .promises {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .promises li {
    display: flex;
    gap: 16px;
    align-items: flex-start;
    line-height: 1.5;
  }
  .promises :global(svg) {
    margin-top: 2px;
    color: var(--md-sys-color-primary);
  }
  .note {
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.875rem;
  }
  .error {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    color: var(--md-sys-color-on-error-container);
    background: var(--md-sys-color-error-container);
    padding: 12px 16px;
    border-radius: var(--ppg-radius-control);
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
    margin-top: 0;
  }
  .working {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0;
    margin: 0;
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--ppg-radius-surface);
    overflow: hidden;
  }
  .facts dt,
  .facts dd {
    margin: 0;
    padding: 12px 16px;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
  }
  .facts dt:nth-last-of-type(1),
  .facts dd:last-of-type {
    border-bottom: 0;
  }
  .facts dt {
    color: var(--md-sys-color-on-surface-variant);
    padding-right: 32px;
  }
  .facts dd {
    display: flex;
    align-items: center;
    gap: 8px;
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
    position: relative;
    display: flex;
    gap: 16px;
    align-items: flex-start;
    padding: 18px 20px;
    border-radius: var(--ppg-radius-surface);
    border: 1px solid var(--md-sys-color-outline-variant);
    cursor: pointer;
    background: var(--md-sys-color-surface);
    transition: border-color 140ms var(--ppg-ease), background-color 140ms var(--ppg-ease);
  }
  .model:hover {
    border-color: var(--md-sys-color-outline);
  }
  .model.chosen {
    border: 2px solid var(--md-sys-color-primary);
    padding: 17px 19px;
    background: var(--md-sys-color-surface-container-low);
  }
  .model:focus-within {
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: 2px;
  }
  .model input {
    position: absolute;
    opacity: 0;
    inset: 0;
    cursor: pointer;
  }
  .model .body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .title {
    font-size: 1.0625rem;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .badge {
    padding: 2px 9px;
    border-radius: 6px;
    background: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .desc {
    color: var(--md-sys-color-on-surface-variant);
  }
  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
    margin-top: 4px;
  }
  .stat {
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid var(--md-sys-color-outline-variant);
    font-size: 0.75rem;
    color: var(--md-sys-color-on-surface-variant);
  }
  .stat.strong {
    color: var(--md-sys-color-on-surface);
    font-weight: 600;
  }
  .model .tick {
    flex: none;
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 1px solid var(--md-sys-color-outline);
    color: transparent;
  }
  .model.chosen .tick {
    background: var(--md-sys-color-primary);
    border-color: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
  }
  .progress-text {
    display: flex;
    align-items: baseline;
    gap: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--md-sys-color-on-surface-variant);
  }
  .progress-text strong {
    font-size: 1.5rem;
    color: var(--md-sys-color-on-surface);
  }
  .results {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  .results td {
    padding: 12px 12px 12px 0;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
    vertical-align: top;
  }
  .results .mark {
    width: 24px;
    color: var(--md-sys-color-success);
    font-weight: 700;
  }
  .results .wrong .mark {
    color: var(--md-sys-color-warning);
  }
  .results .answer {
    text-align: right;
    font-weight: 600;
    white-space: nowrap;
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 20px;
    border-radius: var(--ppg-radius-surface);
    background: var(--md-sys-color-surface-container-low);
  }
  .done-mark {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--md-sys-color-success-container) 55%, var(--md-sys-color-surface));
    color: var(--md-sys-color-success);
  }
  .summary-list {
    margin: 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* ---- narrow: the rail becomes a one-line progress header */
  @media (max-width: 760px) {
    .shell {
      display: block;
    }
    .rail {
      position: static;
      height: auto;
      border-right: 0;
      border-bottom: 1px solid var(--md-sys-color-outline-variant);
      padding: 16px 20px;
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .steps {
      display: none;
    }
    .compact {
      display: block;
    }
    main {
      padding: 28px 20px 56px;
    }
    h1 {
      font-size: 1.5rem;
    }
  }
</style>
