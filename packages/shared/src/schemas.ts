/**
 * The wire contract for forms and sign-in: the content script, the service worker, the backend and the LLM.
 * (Results and summaries have their own modules: results.ts, summary.ts.)
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

/* ------------------------------------------------- managed backend: login */

export const LoginRequestSchema = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(256),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

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

/**
 * What the content script noticed about the page itself, as opposed to about a
 * form on it.
 *
 * This shape travels from the content script to the service worker and stops
 * there. It is deliberately absent from `FormAssessRequestSchema`: the list of
 * hosts a page talked to is exactly the kind of thing `docs/threat-model.md`
 * promises does not leave the browser, and the model gets rule ids instead —
 * which it already did.
 *
 * Ids only, no free text: a matched pattern is an id from `page-signals.ts`,
 * never a snippet of the page, so nothing attacker-controlled rides along.
 */
export const PageSignalsSchema = z
  .object({
    iconUrls: z.array(z.string()),
    referencedHosts: z.array(z.string()),
    sendingHosts: z.array(z.string()),
    exfilSinks: z.array(z.string()),
    devtoolsBlocks: z.array(z.string()),
  })
  .strict();
export type PageSignalsWire = z.infer<typeof PageSignalsSchema>;

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
