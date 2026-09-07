/**
 * A very small Chrome DevTools Protocol client, enough to drive headless
 * Chromium with the extension loaded.
 *
 * Puppeteer would do this too, but it is a large dependency for what amounts to
 * "open a tab, read the DOM, collect console errors", and it pins its own
 * browser download.
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

export interface Tab {
  targetId: string;
  sessionId: string;
  /** Console errors and exceptions seen since the tab opened. */
  problems: string[];
  evaluate<T>(expression: string): Promise<T>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  extensionDir?: string;
  hostResolverRules?: string;
  ignoreCertificateErrors?: boolean;
  port?: number;
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
      'chromium',
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
    ];
    if (options.extensionDir) {
      args.push(`--load-extension=${options.extensionDir}`, `--disable-extensions-except=${options.extensionDir}`);
    }
    if (options.hostResolverRules) args.push(`--host-resolver-rules=${options.hostResolverRules}`);
    if (options.ignoreCertificateErrors) args.push('--ignore-certificate-errors');
    args.push('about:blank');

    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });

    let version: { webSocketDebuggerUrl: string } | null = null;
    for (let attempt = 0; attempt < 80 && !version; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) version = (await response.json()) as typeof version;
      } catch {
        /* not up yet */
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

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
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
    const listener = (message: any) => {
      if (message.sessionId !== sessionId) return;
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
    await this.send('Page.navigate', { url }, sessionId);
    await Bun.sleep(settleMs);

    return {
      targetId,
      sessionId,
      problems,
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
    this.ws.close();
    this.proc.kill();
    rmSync(this.profileDir, { recursive: true, force: true });
  }
}
