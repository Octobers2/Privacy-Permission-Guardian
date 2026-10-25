/**
 * A report that a site has no terms of service we can find. Anyone can send one (the extension asks first), so it carries the
 * least that makes it useful: the page address and the addresses that were tried. Nothing about the user, and no page text.
 */
import { z } from 'zod';
import { PolicyUrl, RESULT_TTL_MS } from './results.ts';

export const MAX_TRIED = 20;
/** A report lives this long after the last one for the same site, like a result. */
export const REPORT_TTL_MS = RESULT_TTL_MS;

export const MissingTermsReportSchema = z
  .object({
    /** The page the user was on, without query or fragment. */
    url: PolicyUrl,
    /** Addresses that were looked at for terms, on the same site. */
    tried: z.array(PolicyUrl).max(MAX_TRIED).default([]),
  })
  .strict();
export type MissingTermsReport = z.infer<typeof MissingTermsReportSchema>;

export const MissingTermsViewSchema = z
  .object({
    domain: z.string(),
    reports: z.number().int().min(1),
    firstReportedAt: z.string().datetime(),
    lastReportedAt: z.string().datetime(),
  })
  .strict();
export type MissingTermsView = z.infer<typeof MissingTermsViewSchema>;
