/**
 * Sends work to the model, through whichever path the user chose.
 *
 * Both modes run the same prompts, the same schema validation and the same
 * post-processing — the only difference is who holds the API key:
 *
 *   managed  the extension posts to a small local Hono server, which holds the
 *            key and a shared SQLite cache. This is what makes it possible for
 *            somebody to test the extension without setting up an account.
 *   direct   the extension calls the user's own OpenAI-compatible endpoint.
 *            Nothing but the endpoint sees the request.
 */
import {
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
  type PolicySummary,
  type Settings,
} from '@ppg/shared';

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
  let response: Response;
  try {
    response = await fetch(`${settings.managedUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch (cause) {
    throw new LlmError(
      'network',
      `連唔到 managed server（${settings.managedUrl}）。開咗 bun run server 未？ ${cause}`,
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new LlmError('server', `managed server ${response.status}: ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as T;
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
 * cannot fix the server's key from here, so "is the server reachable?" is the
 * question they can actually act on.
 */
export async function checkConnection(settings: Settings): Promise<ConnectionCheck> {
  if (settings.mode === 'managed') {
    const started = performance.now();
    try {
      const response = await fetch(`${settings.managedUrl.replace(/\/+$/, '')}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await response.json()) as { model?: string };
      return {
        ok: response.ok,
        model: body.model,
        latencyMs: Math.round(performance.now() - started),
        message: response.ok
          ? `Managed server 正常${body.model ? `（${body.model}）` : ''}`
          : `Managed server 回應 ${response.status}`,
      };
    } catch {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        message: `連唔到 ${settings.managedUrl}。喺 repo 入面行 bun run server 先。`,
      };
    }
  }

  return testConnection(endpointFrom(settings));
}
