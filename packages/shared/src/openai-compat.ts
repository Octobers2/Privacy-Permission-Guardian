/**
 * A minimal client for any OpenAI-compatible `/chat/completions` endpoint.
 *
 * Deliberately not the official SDK: the extension needs this to run inside an
 * MV3 service worker, the settings page lets the user point at OpenAI,
 * OpenRouter, DeepSeek, Groq or a local Ollama, and the only feature actually
 * used is "send two messages, get JSON back". A fetch wrapper is smaller than
 * the SDK and does not care which vendor is on the other end.
 *
 * The response is validated against a schema here rather than by the caller,
 * because a model reading attacker-controlled page text is an untrusted source
 * and there should be exactly one place that decides whether its output is
 * usable.
 */
import type { ZodType } from 'zod';
import type { Prompt } from './prompts.ts';

export interface EndpointConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export type LlmErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'model_not_found'
  | 'timeout'
  | 'network'
  | 'server'
  | 'invalid_response';

/** Carries a message meant to be shown to the user, not logged and forgotten. */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

const HUMAN_MESSAGES: Record<LlmErrorKind, string> = {
  auth: 'API key 唔啱或者冇權限（401/403）。檢查下設定入面嘅 key。',
  rate_limit: '短時間內叫得太密（429）。等陣再試，或者調高敏感度門檻減少呼叫。',
  model_not_found: '搵唔到呢個 model（404）。檢查下 model 名同 base URL 有冇填錯。',
  timeout: '等太耐冇回應。可以喺進階設定調高 timeout。',
  network:
    '連唔到呢個 endpoint。檢查下 base URL；如果係本機 Ollama，記得設定 OLLAMA_ORIGINS=chrome-extension://*。',
  server: 'Endpoint 內部錯誤。通常係對方嘅問題，等陣再試。',
  invalid_response: '模型回覆嘅格式唔啱，已經改用規則引擎嘅結果。',
};

export function humanMessageFor(error: unknown): string {
  if (error instanceof LlmError) return HUMAN_MESSAGES[error.kind];
  return '出咗個預期之外嘅錯誤。';
}

function errorKindForStatus(status: number): LlmErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 404) return 'model_not_found';
  return 'server';
}

/** `https://api.openai.com/v1/` and `https://api.openai.com/v1` both work. */
function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path}`;
}

/**
 * Pulls the JSON object out of a completion.
 *
 * Providers that ignore `response_format` tend to wrap the object in a fenced
 * code block or add a sentence before it, so this looks for the outermost
 * braces rather than insisting the whole string parses.
 */
export function extractJson(content: string): unknown {
  const withoutFence = content.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try {
    return JSON.parse(withoutFence);
  } catch {
    /* fall through to the brace scan */
  }

  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new LlmError('invalid_response', 'no JSON object in the completion');
  }
  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    throw new LlmError('invalid_response', 'the completion did not contain valid JSON');
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

async function postChat(
  config: EndpointConfig,
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<string> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  let response: Response;
  try {
    response = await doFetch(endpointUrl(config.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === 'AbortError';
    throw new LlmError(aborted ? 'timeout' : 'network', String(cause));
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new LlmError(
      errorKindForStatus(response.status),
      `${response.status} ${response.statusText}: ${body.slice(0, 300)}`,
      response.status,
    );
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new LlmError('invalid_response', 'the endpoint returned no message content');
  }
  return content;
}

/** Retried once; anything the user has to fix themselves is not. */
function isRetryable(error: unknown): boolean {
  return (
    error instanceof LlmError &&
    (error.kind === 'rate_limit' || error.kind === 'server' || error.kind === 'network')
  );
}

export interface ChatJsonResult<T> {
  value: T;
  /** True when the first attempt produced output the schema rejected. */
  retried: boolean;
}

/**
 * Sends a prompt and returns a value that satisfies `schema`.
 *
 * On a schema failure it retries once, telling the model what was wrong. If the
 * second attempt also fails, it throws `invalid_response` — the caller is
 * expected to fall back to the rule engine rather than show the user something
 * nobody validated.
 */
export async function chatJson<T>(
  config: EndpointConfig,
  prompt: Prompt,
  schema: ZodType<T>,
  options: ChatOptions = {},
): Promise<ChatJsonResult<T>> {
  const messages: ChatMessage[] = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];

  let lastProblem = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    let content: string;
    try {
      content = await postChat(config, messages, options);
    } catch (error) {
      if (attempt === 0 && isRetryable(error)) {
        await new Promise((done) => setTimeout(done, 800));
        continue;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = extractJson(content);
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
      messages.push(
        { role: 'assistant', content: content.slice(0, 500) },
        { role: 'user', content: `你上一次嘅回覆唔係有效 JSON（${lastProblem}）。淨係輸出 JSON 物件，唔好加任何其他文字。` },
      );
      continue;
    }

    const validated = schema.safeParse(parsed);
    if (validated.success) return { value: validated.data, retried: attempt > 0 };

    lastProblem = validated.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    messages.push(
      { role: 'assistant', content: content.slice(0, 500) },
      { role: 'user', content: `你上一次嘅回覆唔符合要求嘅格式：${lastProblem}。請重新輸出，只要 JSON 物件。` },
    );
  }

  throw new LlmError('invalid_response', `schema still unsatisfied after a retry: ${lastProblem}`);
}

export interface ConnectionCheck {
  ok: boolean;
  model?: string;
  latencyMs: number;
  message: string;
}

/**
 * The "test connection" button.
 *
 * Sends the smallest possible completion rather than hitting `/models`: some
 * gateways expose `/models` without a key, so a green tick there would say
 * nothing about whether the key works or the model name is real.
 */
export async function testConnection(
  config: EndpointConfig,
  options: ChatOptions = {},
  now: () => number = () => performance.now(),
): Promise<ConnectionCheck> {
  const started = now();
  try {
    const content = await postChat(
      { ...config, maxTokens: 32, temperature: 0 },
      [
        { role: 'system', content: 'Reply with the JSON object {"ok":true} and nothing else.' },
        { role: 'user', content: 'ping' },
      ],
      options,
    );
    extractJson(content);
    return {
      ok: true,
      model: config.model,
      latencyMs: Math.round(now() - started),
      message: `連線正常（${config.model}）`,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(now() - started),
      message: humanMessageFor(error),
    };
  }
}
