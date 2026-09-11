/**
 * Sends work to the model, through whichever path the user chose.
 *
 * Both modes run the same prompts, the same schema validation and the same
 * post-processing — the only difference is who holds the API key:
 *
 *   managed  the extension posts to a small Hono server, which holds the key, a
 *            shared SQLite cache and a headless browser. This is what makes it
 *            possible for somebody to test the extension without setting up an
 *            account — and the reason it needs a login: an open one is a free
 *            LLM and a free page fetcher for anybody who finds the port.
 *   direct   the extension calls the user's own OpenAI-compatible endpoint.
 *            Nothing but the endpoint sees the request.
 */
import {
  LoginResponseSchema,
  ManagedStatusSchema,
  PolicyRenderResponseSchema,
  buildFormPrompt,
  buildPolicyPrompt,
  chatJson,
  finalisePolicySummary,
  FormAssessmentSchema,
  LlmError,
  PolicySummaryResponseSchema,
  PolicySummarySchema,
  PROMPT_VERSION,
  testConnection,
  type ConnectionCheck,
  type EndpointConfig,
  type FormAssessRequest,
  type FormAssessment,
  type PolicyRenderResponse,
  type PolicySummary,
  type Settings,
} from '@ppg/shared';

/* ------------------------------------------------------- managed: the login */

/**
 * Where the bearer token lives between requests.
 *
 * `chrome.storage.session` rather than a module variable: the service worker is
 * killed and restarted constantly, and logging in again on every wake would
 * spend a bcrypt verification each time. It is memory-backed and cleared when
 * the browser closes, which is the right lifetime for a credential derived from
 * a password.
 */
const TOKEN_KEY = 'managedToken';

interface StoredToken {
  token: string;
  /** Which server and account it belongs to; a changed setting invalidates it. */
  managedUrl: string;
  username: string;
}

function managedBase(settings: Settings): string {
  return settings.managedUrl.replace(/\/+$/, '');
}

function requireCredentials(settings: Settings): void {
  if (!settings.managedUsername || !settings.managedPassword) {
    throw new LlmError(
      'credentials',
      'Managed 模式未填帳號密碼。喺設定頁填返 server 嗰邊開嘅帳號。',
    );
  }
}

async function storedToken(settings: Settings): Promise<string | null> {
  const stored = (await chrome.storage.session.get(TOKEN_KEY))[TOKEN_KEY] as StoredToken | undefined;
  if (!stored) return null;
  if (stored.managedUrl !== managedBase(settings) || stored.username !== settings.managedUsername) {
    return null;
  }
  return stored.token;
}

async function forgetToken(): Promise<void> {
  await chrome.storage.session.remove(TOKEN_KEY);
}

async function login(settings: Settings): Promise<string> {
  requireCredentials(settings);

  let response: Response;
  try {
    response = await fetch(`${managedBase(settings)}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: settings.managedUsername,
        password: settings.managedPassword,
      }),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch (cause) {
    throw new LlmError(
      'network',
      `連唔到 managed server（${settings.managedUrl}）。開咗 bun run server 未？ ${cause}`,
    );
  }

  if (response.status === 401 || response.status === 429) {
    const detail = response.status === 429 ? '登入失敗太多次，等 15 分鐘再試。' : '帳號或者密碼唔啱。';
    throw new LlmError('credentials', detail, response.status);
  }
  if (!response.ok) {
    throw new LlmError('server', `managed server ${response.status} on /api/login`);
  }

  const { token } = LoginResponseSchema.parse(await response.json());
  await chrome.storage.session.set({
    [TOKEN_KEY]: {
      token,
      managedUrl: managedBase(settings),
      username: settings.managedUsername,
    } satisfies StoredToken,
  });
  return token;
}

/**
 * One authenticated request, with a single retry after a login.
 *
 * Tokens live in the server's memory, so a restart invalidates every one of
 * them. Without the retry that surfaces as "帳號或者密碼唔啱" on a perfectly
 * good password, once, every time the server is restarted — which during
 * development is constantly.
 */
async function authedFetch(
  settings: Settings,
  path: string,
  init: RequestInit,
): Promise<Response> {
  requireCredentials(settings);

  const send = async (token: string): Promise<Response> =>
    fetch(`${managedBase(settings)}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(settings.timeoutMs),
    });

  let token = (await storedToken(settings)) ?? (await login(settings));

  let response: Response;
  try {
    response = await send(token);
  } catch (cause) {
    throw new LlmError(
      'network',
      `連唔到 managed server（${settings.managedUrl}）。開咗 bun run server 未？ ${cause}`,
    );
  }

  if (response.status !== 401) return response;

  await forgetToken();
  token = await login(settings);
  try {
    return await send(token);
  } catch (cause) {
    throw new LlmError('network', `連唔到 managed server（${settings.managedUrl}）。 ${cause}`);
  }
}

export interface PolicyInput {
  domain: string;
  policyUrl: string;
  text: string;
  truncated: boolean;
}

function endpointFrom(settings: Settings): EndpointConfig {
  return {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    timeoutMs: settings.timeoutMs,
  };
}

async function postToManaged<T>(settings: Settings, path: string, body: unknown): Promise<T> {
  const response = await authedFetch(settings, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (response.status === 401) {
    throw new LlmError('credentials', 'Managed server 唔接受呢組帳號密碼。', 401);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new LlmError('server', `managed server ${response.status}: ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

/**
 * Why the server could not be asked to render.
 *
 * A failure here is never fatal — the extension can read policy pages itself —
 * but it decides what the popup says when nothing else works either, and
 * "server is not running" and "server does not know this account" send the user
 * to completely different places.
 */
export type RenderUnavailable = 'not-managed' | 'no-credentials' | 'unreachable' | 'rejected';

export type RenderOutcome =
  | { ok: true; response: PolicyRenderResponse }
  | { ok: false; reason: RenderUnavailable };

/**
 * Asks the server to open these URLs in a real browser and read the first one
 * that is a document.
 *
 * This is tried before the extension's own readers in managed mode: the pages
 * that need it are the ones a plain fetch cannot read at all, and doing it here
 * costs the user's browser nothing.
 */
export async function renderPolicy(settings: Settings, urls: string[]): Promise<RenderOutcome> {
  if (settings.mode !== 'managed' || urls.length === 0) return { ok: false, reason: 'not-managed' };
  if (!settings.managedUsername || !settings.managedPassword) {
    return { ok: false, reason: 'no-credentials' };
  }

  try {
    const payload = await postToManaged<unknown>(settings, '/api/policy/render', {
      urls: urls.slice(0, 5),
    });
    return { ok: true, response: PolicyRenderResponseSchema.parse(payload) };
  } catch (error) {
    const kind = error instanceof LlmError ? error.kind : 'server';
    return { ok: false, reason: kind === 'credentials' ? 'rejected' : 'unreachable' };
  }
}

export async function summarisePolicy(
  settings: Settings,
  input: PolicyInput,
  contentHash: string,
): Promise<PolicySummary> {
  if (settings.mode === 'managed') {
    const payload = await postToManaged<unknown>(settings, '/api/policy/summarize', {
      domain: input.domain,
      policyUrl: input.policyUrl,
      text: input.text,
      truncated: input.truncated,
      contentHash,
    });
    // The managed server is ours, but it is still across a network boundary,
    // so its response is validated exactly like the model's.
    return PolicySummarySchema.parse(payload);
  }

  const { value } = await chatJson(
    endpointFrom(settings),
    buildPolicyPrompt(input),
    PolicySummaryResponseSchema,
  );

  const { summary } = finalisePolicySummary(value, {
    domain: input.domain,
    policyUrl: input.policyUrl,
    sourceText: input.text,
    truncated: input.truncated,
    promptVersion: PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
  });
  return summary;
}

export async function assessForm(
  settings: Settings,
  request: FormAssessRequest,
): Promise<FormAssessment> {
  if (settings.mode === 'managed') {
    const payload = await postToManaged<unknown>(settings, '/api/form/assess', request);
    return FormAssessmentSchema.parse(payload);
  }

  const { value } = await chatJson(
    endpointFrom(settings),
    buildFormPrompt(request),
    FormAssessmentSchema,
  );
  return value;
}

/**
 * In managed mode this checks our server, not the model behind it: the user
 * cannot fix the server's key from here, so "can I reach it, and does it know
 * me?" is the question they can actually act on.
 *
 * It logs in on purpose. A reachable port says nothing about whether the
 * credentials in the settings are the ones the server was given, and the
 * whole point of the button is to find that out before the first summary
 * fails.
 */
export async function checkConnection(settings: Settings): Promise<ConnectionCheck> {
  if (settings.mode === 'managed') {
    const started = performance.now();
    const since = () => Math.round(performance.now() - started);

    if (!settings.managedUsername || !settings.managedPassword) {
      return { ok: false, latencyMs: since(), message: '未填帳號密碼。Server 嗰邊行 `bun run auth add <username>` 開一個。' };
    }

    try {
      // Straight to the authenticated route: the retry inside `authedFetch`
      // logs in if the stored token is stale, so one call answers both
      // questions.
      const response = await authedFetch(settings, '/api/status', { method: 'GET' });
      if (!response.ok) {
        return {
          ok: false,
          latencyMs: since(),
          message: `Managed server 回應 ${response.status}`,
        };
      }
      const status = ManagedStatusSchema.parse(await response.json());
      return {
        ok: true,
        model: status.model,
        latencyMs: since(),
        message: `Managed server 正常，已經認得「${status.username}」（${status.model}${
          status.hasKey ? '' : '，但 server 未設定 API key'
        }）`,
      };
    } catch (error) {
      if (error instanceof LlmError && error.kind === 'credentials') {
        return { ok: false, latencyMs: since(), message: error.message };
      }
      return {
        ok: false,
        latencyMs: since(),
        message: `連唔到 ${settings.managedUrl}。喺 repo 入面行 bun run server 先。`,
      };
    }
  }

  return testConnection(endpointFrom(settings));
}
