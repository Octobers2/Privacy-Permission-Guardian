import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { chatJson, extractJson, LlmError, testConnection, type EndpointConfig } from '../src/openai-compat.ts';

const CONFIG: EndpointConfig = {
  baseUrl: 'https://api.example.com/v1/',
  apiKey: 'sk-test',
  model: 'test-model',
  temperature: 0,
  maxTokens: 100,
  timeoutMs: 2_000,
};

const Schema = z.object({ verdict: z.enum(['safe', 'danger']) }).strict();
const PROMPT = { system: 'sys', user: 'usr' };

/** A fetch stand-in that replays scripted responses and records the requests. */
function mockFetch(responses: (Response | Error)[]) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    const next = responses.shift();
    if (!next) throw new Error('mock fetch ran out of responses');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function completion(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('extractJson', () => {
  test('parses a plain object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  test('unwraps a fenced code block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('finds the object when the model added a sentence first', () => {
    // Providers that ignore response_format do this constantly.
    expect(extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  test('throws when there is no object at all', () => {
    expect(() => extractJson('I cannot help with that.')).toThrow(LlmError);
  });
});

describe('chatJson', () => {
  test('joins the base url correctly whether or not it ends in a slash', async () => {
    for (const baseUrl of ['https://api.example.com/v1', 'https://api.example.com/v1/']) {
      const { impl, calls } = mockFetch([completion('{"verdict":"safe"}')]);
      await chatJson({ ...CONFIG, baseUrl }, PROMPT, Schema, { fetchImpl: impl });
      expect(calls[0]!.url).toBe('https://api.example.com/v1/chat/completions');
    }
  });

  test('sends the key as a bearer token and asks for JSON', async () => {
    const { impl, calls } = mockFetch([completion('{"verdict":"safe"}')]);
    await chatJson(CONFIG, PROMPT, Schema, { fetchImpl: impl });
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test');
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(calls[0]!.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });

  test('omits the authorization header when there is no key', async () => {
    // A local Ollama has no key, and sending "Bearer " upsets some gateways.
    const { impl, calls } = mockFetch([completion('{"verdict":"safe"}')]);
    await chatJson({ ...CONFIG, apiKey: '' }, PROMPT, Schema, { fetchImpl: impl });
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  test('returns the validated value', async () => {
    const { impl } = mockFetch([completion('{"verdict":"danger"}')]);
    const result = await chatJson(CONFIG, PROMPT, Schema, { fetchImpl: impl });
    expect(result).toEqual({ value: { verdict: 'danger' }, retried: false });
  });

  test('retries once with the validation error when the shape is wrong', async () => {
    const { impl, calls } = mockFetch([
      completion('{"verdict":"probably fine"}'),
      completion('{"verdict":"safe"}'),
    ]);
    const result = await chatJson(CONFIG, PROMPT, Schema, { fetchImpl: impl });

    expect(result.value).toEqual({ verdict: 'safe' });
    expect(result.retried).toBe(true);
    // The second attempt tells the model what was wrong instead of just asking again.
    const followUp = calls[1]!.body.messages.at(-1).content;
    expect(followUp).toContain('verdict');
  });

  test('gives up after one retry rather than showing unvalidated output', async () => {
    const { impl } = mockFetch([completion('{"verdict":"x"}'), completion('{"verdict":"y"}')]);
    await expect(chatJson(CONFIG, PROMPT, Schema, { fetchImpl: impl })).rejects.toThrow(
      /schema still unsatisfied/,
    );
  });

  test('rejects extra keys, so a model cannot smuggle fields past the caller', async () => {
    const { impl } = mockFetch([
      completion('{"verdict":"safe","runShell":"rm -rf /"}'),
      completion('{"verdict":"safe","runShell":"rm -rf /"}'),
    ]);
    await expect(chatJson(CONFIG, PROMPT, Schema, { fetchImpl: impl })).rejects.toThrow(LlmError);
  });

  test('does not retry an authentication failure', async () => {
    const { impl, calls } = mockFetch([new Response('nope', { status: 401 })]);
    await expect(chatJson(CONFIG, PROMPT, Schema, { fetchImpl: impl })).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(calls).toHaveLength(1);
  });

  test('maps status codes to actionable kinds', async () => {
    for (const [status, kind] of [[403, 'auth'], [404, 'model_not_found'], [500, 'server']] as const) {
      const { impl } = mockFetch([new Response('', { status }), new Response('', { status })]);
      await expect(chatJson(CONFIG, PROMPT, Schema, { fetchImpl: impl })).rejects.toMatchObject({ kind });
    }
  });

  test('reports a dead endpoint as a network problem', async () => {
    const { impl } = mockFetch([new TypeError('Failed to fetch'), new TypeError('Failed to fetch')]);
    await expect(chatJson(CONFIG, PROMPT, Schema, { fetchImpl: impl })).rejects.toMatchObject({
      kind: 'network',
    });
  });
});

describe('testConnection', () => {
  test('reports success with the model name and a latency', async () => {
    const { impl } = mockFetch([completion('{"ok":true}')]);
    let clock = 0;
    const check = await testConnection(CONFIG, { fetchImpl: impl }, () => (clock += 120));
    expect(check.ok).toBe(true);
    expect(check.model).toBe('test-model');
    expect(check.latencyMs).toBe(120);
  });

  test('turns a failure into something the user can act on', async () => {
    const { impl } = mockFetch([new Response('', { status: 401 })]);
    const check = await testConnection(CONFIG, { fetchImpl: impl });
    expect(check.ok).toBe(false);
    expect(check.message).toContain('API key');
  });
});
