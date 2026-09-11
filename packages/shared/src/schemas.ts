/**
 * The wire contract between the content script, the service worker, the
 * managed backend and the LLM.
 *
 * Everything crossing a trust boundary is validated against these schemas.
 * That matters most for LLM responses: the model is reading attacker-controlled
 * page text, so its output is treated as untrusted input rather than as data we
 * asked for. `.strict()` everywhere is deliberate — an unexpected key means the
 * response is not the shape we asked for, and we would rather fall back to the
 * rule engine than render something we do not understand.
 *
 * Both the extension and the server import this file. It must stay free of
 * browser and Node APIs.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ shared */

export const SEVERITIES = ['low', 'medium', 'high'] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof SeveritySchema>;

export const VERDICTS = ['safe', 'caution', 'danger'] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

/* ------------------------------------------------- feature A: policy summary */

export const POLICY_CATEGORIES = [
  'data_collection',
  'third_party_sharing',
  'tracking_ads',
  'location',
  'retention',
  'user_rights',
  'account_deletion',
  'jurisdiction',
  'children',
  /**
   * Not a clause category: emitted when the document itself tries to steer the
   * analyser (hidden "ignore previous instructions" text and friends). Turning
   * an injection attempt into a reportable finding is more useful to the reader
   * than silently dropping it.
   */
  'manipulation_attempt',
] as const;
export const PolicyCategorySchema = z.enum(POLICY_CATEGORIES);
export type PolicyCategory = z.infer<typeof PolicyCategorySchema>;

export const PolicyPointSchema = z
  .object({
    category: PolicyCategorySchema,
    severity: SeveritySchema,
    /** One short line. Length caps are loose: they exist to catch a model that
     *  dumps the document back at us, not to police wording. */
    title: z.string().min(1).max(120),
    detail: z.string().min(1).max(400),
    /** Must appear verbatim in the source document; checked separately. */
    quote: z.string().min(1).max(600),
  })
  .strict();
export type PolicyPoint = z.infer<typeof PolicyPointSchema>;

/** Exactly what the model is asked to return. */
export const PolicySummaryResponseSchema = z
  .object({ points: z.array(PolicyPointSchema).min(1).max(8) })
  .strict();
export type PolicySummaryResponse = z.infer<typeof PolicySummaryResponseSchema>;

/** What we store and render, after scoring and quote verification. */
export const PolicySummarySchema = z
  .object({
    domain: z.string().min(1),
    policyUrl: z.string().url(),
    /** True when the document was cut short; surfaced in the UI so we never
     *  imply the whole thing was read. */
    truncated: z.boolean(),
    /** Derived from the point severities in score.ts — never taken from the model. */
    riskScore: z.number().int().min(0).max(100),
    points: z.array(PolicyPointSchema),
    /** Number of points dropped because their quote was not in the source. */
    droppedPoints: z.number().int().min(0),
    promptVersion: z.string().min(1),
    generatedAt: z.string().datetime(),
  })
  .strict();
export type PolicySummary = z.infer<typeof PolicySummarySchema>;

export const PolicySummarizeRequestSchema = z
  .object({
    domain: z.string().min(1),
    policyUrl: z.string().url(),
    /** Already sanitised and truncated by the extension. */
    text: z.string().min(1).max(40_000),
    truncated: z.boolean(),
    /** sha256 of the sanitised text; the cache key together with promptVersion. */
    contentHash: z.string().length(64),
  })
  .strict();
export type PolicySummarizeRequest = z.infer<typeof PolicySummarizeRequestSchema>;

/* --------------------------------------------- managed backend: rendering */

/**
 * Asks the backend to open these URLs in a real browser and read the first one
 * that looks like a document.
 *
 * A list rather than one URL because the candidates are ordered guesses and the
 * server is the thing that can try them cheaply — one round trip instead of
 * five, and the caller does not have to interpret each failure to decide
 * whether to try the next.
 */
export const PolicyRenderRequestSchema = z
  .object({
    urls: z.array(z.string().url()).min(1).max(5),
  })
  .strict();
export type PolicyRenderRequest = z.infer<typeof PolicyRenderRequestSchema>;

export const RENDER_FAILURE_REASONS = [
  'blocked-host',
  'fetch-failed',
  'http-error',
  'not-html',
  'too-short',
  'render-unavailable',
] as const;

export const PolicyRenderResponseSchema = z
  .object({
    policy: z
      .object({
        policyUrl: z.string().url(),
        text: z.string(),
        truncated: z.boolean(),
      })
      .strict()
      .nullable(),
    failures: z
      .array(
        z.object({ url: z.string(), reason: z.enum(RENDER_FAILURE_REASONS) }).strict(),
      ),
  })
  .strict();
export type PolicyRenderResponse = z.infer<typeof PolicyRenderResponseSchema>;

/* ------------------------------------------------- managed backend: login */

export const LoginRequestSchema = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(256),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z
  .object({
    token: z.string().min(1),
    /** Epoch milliseconds. The extension does not use it; a human reading the response does. */
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/** What `/api/status` answers — the managed half of a connection test. */
export const ManagedStatusSchema = z
  .object({
    ok: z.boolean(),
    model: z.string(),
    baseUrl: z.string(),
    hasKey: z.boolean(),
    promptVersion: z.string(),
    cachedSummaries: z.number().int().min(0),
    username: z.string(),
  })
  .strict();
export type ManagedStatus = z.infer<typeof ManagedStatusSchema>;

/* ---------------------------------------------------- feature B: form risk */

/**
 * A form field as the rule engine sees it.
 *
 * There is no `value` key, and there never will be one. Field values are the
 * thing this extension exists to protect; only the shape of the form leaves the
 * page.
 */
export const FormFieldSchema = z
  .object({
    type: z.string(),
    name: z.string(),
    id: z.string(),
    autocomplete: z.string(),
    placeholder: z.string(),
    label: z.string(),
    required: z.boolean(),
  })
  .strict();
export type FormField = z.infer<typeof FormFieldSchema>;

export const PageContextSchema = z
  .object({
    /** Origin + path only; the query string is stripped before this is built. */
    url: z.string(),
    hostname: z.string(),
    isHttps: z.boolean(),
    title: z.string(),
  })
  .strict();
export type PageContext = z.infer<typeof PageContextSchema>;

export const FormDescriptorSchema = z
  .object({
    fields: z.array(FormFieldSchema),
    /** Absolute origin the form posts to, or null when it posts to itself. */
    actionOrigin: z.string().nullable(),
    method: z.string(),
    submitText: z.string(),
  })
  .strict();
export type FormDescriptor = z.infer<typeof FormDescriptorSchema>;

export const FormObservationSchema = z
  .object({ page: PageContextSchema, form: FormDescriptorSchema })
  .strict();
export type FormObservation = z.infer<typeof FormObservationSchema>;

export const RuleHitSchema = z
  .object({
    id: z.string().min(1),
    points: z.number().int(),
    /** Shown to the user in the banner, so it has to read as a reason. */
    detail: z.string().min(1),
  })
  .strict();
export type RuleHit = z.infer<typeof RuleHitSchema>;

export const RuleResultSchema = z
  .object({
    score: z.number().int().min(0),
    hits: z.array(RuleHitSchema),
    verdict: VerdictSchema,
  })
  .strict();
export type RuleResult = z.infer<typeof RuleResultSchema>;

/** Exactly what the model is asked to return for a form. */
export const FormAssessmentSchema = z
  .object({
    verdict: VerdictSchema,
    confidence: z.number().min(0).max(1),
    reasons: z.array(z.string().min(1).max(300)).min(1).max(5),
    advice: z.string().min(1).max(400),
    checklist: z.array(z.string().min(1).max(200)).max(5),
  })
  .strict();
export type FormAssessment = z.infer<typeof FormAssessmentSchema>;

export const FormAssessRequestSchema = z
  .object({
    page: PageContextSchema,
    fields: z.array(FormFieldSchema),
    actionOrigin: z.string().nullable(),
    ruleScore: z.number().int().min(0),
    /** Rule ids only — the human-readable detail is regenerated locally. */
    ruleHits: z.array(z.string()),
    textSnippet: z.string().max(2_000),
  })
  .strict();
export type FormAssessRequest = z.infer<typeof FormAssessRequestSchema>;

/* --------------------------------------------------------------- settings */

export const LLM_MODES = ['managed', 'direct'] as const;
export const LlmModeSchema = z.enum(LLM_MODES);
export type LlmMode = z.infer<typeof LlmModeSchema>;

export const SettingsSchema = z
  .object({
    mode: LlmModeSchema,
    /** Managed mode: our own Hono server. */
    managedUrl: z.string(),
    /**
     * Managed mode credentials.
     *
     * The server holds the API key and drives a browser, so it is not an open
     * relay; these are what `auth.txt` on the server side is checked against.
     * Kept in `chrome.storage.local` for the same reason as `apiKey` — see
     * `packages/extension/src/settings.ts`.
     */
    managedUsername: z.string(),
    managedPassword: z.string(),
    /** Direct mode: any OpenAI-compatible endpoint. */
    baseUrl: z.string(),
    apiKey: z.string(),
    model: z.string(),
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    /** Global off switch; reflected in the toolbar badge. */
    paused: z.boolean(),
    /** Registrable domains the user never wants warnings on. */
    allowlist: z.array(z.string()),
    /** Rule score at or above which a form is escalated to the model. */
    llmThreshold: z.number().int().min(0).max(100),
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  mode: 'managed',
  managedUrl: 'http://localhost:8787',
  managedUsername: '',
  managedPassword: '',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0,
  // `max_tokens` is a cap, not a target: raising it costs nothing for an
  // ordinary model, and a reasoning model spends most of its allowance thinking
  // before it writes a single character of the answer.
  maxTokens: 4_000,
  timeoutMs: 60_000,
  paused: false,
  allowlist: [],
  llmThreshold: 30,
};
