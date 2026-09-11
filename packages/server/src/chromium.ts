/**
 * A very small Chrome DevTools Protocol client.
 *
 * Two callers, and they want the same four things — launch, open a tab, run an
 * expression in it, collect console errors:
 *
 *   - `eval/run-e2e.ts` and `eval/run-injection-eval.ts`, with the extension
 *     loaded, to check the built extension in a real browser;
 *   - `src/render.ts`, without it, to render a client-side-rendered policy page
 *     so the server can read text that only exists after the site's own
 *     JavaScript has run.
 *
 * Puppeteer would do this too, but it is a large dependency for what amounts to
 * "open a tab, read the DOM, collect console errors", and it pins its own
 * browser download.
 *
 * It lives in the server package because that is the half that ships it; the
 * evaluation harnesses import it across the workspace.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ConsoleProblem {
  page: string;
  text: string;
}

/**
 * Chromium derives an unpacked extension's ID from its absolute path: sha256,
 * first 16 bytes, each hex nibble mapped 0-f onto a-p.
 */
export function unpackedExtensionId(distPath: string): string {
  const hex = createHash('sha256').update(distPath).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/** The main document's response, as far as the network layer got. */
export interface MainResponse {
  status: number;
  mimeType: string;
  url: string;
}

export interface Tab {
  targetId: string;
  sessionId: string;
  /** Console errors and exceptions seen since the tab opened. */
  problems: string[];
  /**
   * The main document's HTTP response, or null if the navigation never got one.
   *
   * `src/render.ts` needs it to tell "the policy page is a 404" apart from "the
   * policy page rendered nothing", which are different sentences in the popup.
   */
  mainResponse: MainResponse | null;
  /** Chromium's own reason the navigation failed — DNS, refused connection. */
  navigationError: string | null;
  evaluate<T>(expression: string): Promise<T>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  extensionDir?: string;
  hostResolverRules?: string;
  ignoreCertificateErrors?: boolean;
  port?: number;
  /** Defaults to `PPG_CHROMIUM`, then to whatever `chromium` is on PATH. */
  binary?: string;
  /** Containers usually have no user namespaces; `PPG_CHROMIUM_NO_SANDBOX=1`. */
  noSandbox?: boolean;
  /** Called when the browser process or its socket goes away. */
  onDisconnect?: () => void;
}

export class Browser {
  private constructor(
    private readonly ws: WebSocket,
    private readonly proc: Bun.Subprocess,
    private readonly profileDir: string,
    readonly extensionId: string,
  ) {}

  private nextId = 1;
  private readonly pending = new Map<number, (value: any) => void>();
  private readonly listeners = new Set<(message: any) => void>();

  static async launch(options: LaunchOptions = {}): Promise<Browser> {
    const port = options.port ?? 9333;
    const profileDir = mkdtempSync(join(tmpdir(), 'ppg-chrome-'));

    const args = [
      options.binary ?? Bun.env.PPG_CHROMIUM ?? 'chromium',
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
    ];
    if (options.noSandbox ?? Bun.env.PPG_CHROMIUM_NO_SANDBOX === '1') args.push('--no-sandbox');
    if (options.extensionDir) {
      args.push(
        `--load-extension=${options.extensionDir}`,
        `--disable-extensions-except=${options.extensionDir}`,
        // Chrome 137 turned `--load-extension` off by default. Without this the
        // extension appears to load and then every one of its pages is an error
        // page, which is a confusing way to be told the flag was ignored.
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
      );
    }
    if (options.hostResolverRules) args.push(`--host-resolver-rules=${options.hostResolverRules}`);
    if (options.ignoreCertificateErrors) args.push('--ignore-certificate-errors');
    args.push('about:blank');

    // Nothing reads these, and a Chromium whose stderr pipe fills up blocks
    // before it opens the debugging port — which on a machine with noisy GPU
    // logging is every time.
    const proc = Bun.spawn(args, { stdout: 'ignore', stderr: 'ignore' });

    type Version = { webSocketDebuggerUrl: string };
    let version: Version | null = null;
    // Both spellings of "this machine": an environment whose NO_PROXY lists
    // `localhost` but writes 127.0.0.0/8 as a CIDR sends the literal address
    // through an HTTP proxy, which cannot reach a port on this host.
    const endpoints = [`http://127.0.0.1:${port}/json/version`, `http://localhost:${port}/json/version`];

    for (let attempt = 0; attempt < 80 && !version; attempt++) {
      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint);
          if (response.ok) {
            version = (await response.json()) as Version;
            break;
          }
        } catch {
          /* not up yet */
        }
      }
      if (!version) await Bun.sleep(250);
    }
    if (!version) throw new Error('chromium devtools endpoint never came up');

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((done) => (ws.onopen = done));

    const browser = new Browser(
      ws,
      proc,
      profileDir,
      options.extensionDir ? unpackedExtensionId(options.extensionDir) : '',
    );

    ws.onclose = () => browser.handleDisconnect();
    ws.onerror = () => browser.handleDisconnect();
    browser.onDisconnect = options.onDisconnect;

    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && browser.pending.has(message.id)) {
        browser.pending.get(message.id)!(message.result);
        browser.pending.delete(message.id);
      } else if (message.method) {
        for (const listener of browser.listeners) listener(message);
      }
    };

    return browser;
  }

  /**
   * Whether this browser is still usable.
   *
   * The harnesses run once and exit, so they never had to care. A server does:
   * a Chromium that has died must not leave every later request waiting on a
   * promise that will never settle.
   */
  private alive = true;
  private onDisconnect: (() => void) | undefined;

  get connected(): boolean {
    return this.alive;
  }

  private handleDisconnect(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const [, reject] of this.rejecters) reject(new Error('chromium disconnected'));
    this.rejecters.clear();
    this.pending.clear();
    this.onDisconnect?.();
  }

  private readonly rejecters = new Map<number, (error: Error) => void>();

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<any> {
    if (!this.alive) return Promise.reject(new Error('chromium disconnected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.rejecters.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      this.pending.set(id, (value) => {
        clearTimeout(timer);
        this.rejecters.delete(id);
        resolve(value);
      });
      this.rejecters.set(id, (error) => {
        clearTimeout(timer);
        reject(error);
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  /**
   * Opens a tab and leaves it open.
   *
   * Some checks need two tabs alive at once — the extension's own page has to
   * be able to see the fixture tab in `chrome.tabs.query`, which it cannot do
   * if the fixture was closed first.
   */
  async openTab(url: string, settleMs = 1_500): Promise<Tab> {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });

    const problems: string[] = [];
    const state: { mainResponse: MainResponse | null } = { mainResponse: null };
    const listener = (message: any) => {
      if (message.sessionId !== sessionId) return;
      // Only the document itself; the images and scripts it pulls in say
      // nothing about whether the policy was served.
      if (
        message.method === 'Network.responseReceived' &&
        message.params.type === 'Document' &&
        !state.mainResponse
      ) {
        const response = message.params.response;
        state.mainResponse = {
          status: response.status,
          mimeType: response.mimeType ?? '',
          url: response.url ?? url,
        };
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        problems.push((message.params.args ?? []).map((a: any) => a.value ?? a.description).join(' '));
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        problems.push(details.exception?.description ?? details.text);
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        // Every fixture 404s on /favicon.ico; that says nothing about the
        // extension and would drown out the errors that matter.
        if (!/favicon/.test(message.params.entry.url ?? '')) problems.push(message.params.entry.text);
      }
    };
    this.listeners.add(listener);

    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Log.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
    await this.send('Network.enable', {}, sessionId);
    const navigated = await this.send('Page.navigate', { url }, sessionId);
    await Bun.sleep(settleMs);

    return {
      targetId,
      sessionId,
      problems,
      get mainResponse() {
        return state.mainResponse;
      },
      navigationError: navigated?.errorText ?? null,
      evaluate: async <T>(expression: string): Promise<T> => {
        const evaluated = await this.send(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
        );
        if (evaluated.exceptionDetails) {
          const detail = evaluated.exceptionDetails;
          throw new Error(detail.exception?.description ?? detail.text);
        }
        return evaluated.result?.value as T;
      },
      close: async () => {
        this.listeners.delete(listener);
        await this.send('Target.closeTarget', { targetId });
      },
    };
  }

  /** Opens a tab, evaluates once, and closes it. */
  async visit<T>(url: string, expression: string, settleMs = 1_500): Promise<{ value: T; problems: string[] }> {
    const tab = await this.openTab(url, settleMs);
    const value = await tab.evaluate<T>(expression);
    await tab.close();
    return { value, problems: tab.problems };
  }

  close(): void {
    this.alive = false;
    this.ws.close();
    this.proc.kill();
    rmSync(this.profileDir, { recursive: true, force: true });
  }
}
