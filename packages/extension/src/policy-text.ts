/**
 * A last check on a fetched page before it is analysed: does it read like a legal document at all?
 *
 * Finding the link is a guess from its wording, and a guess can land on an ordinary page (a "Road and Traffic Conditions" page was
 * once taken for a site's terms). Reading such a page wastes the user's time and produces findings about nothing, so the text has to
 * show several of the phrases legal documents are made of. The bar is low on purpose: a short, plain terms page passes, a news or
 * directory page does not.
 */
const CUES: RegExp[] = [
  /\bagree(?:s|d|ment)?\b/i,
  /\bliab(?:le|ility)\b/i,
  /\bwarrant(?:y|ies)\b/i,
  /\bdisclaim(?:s|er|ed)?\b/i,
  /\bgoverned\s+by\b|\bgoverning\s+law\b|\blaws?\s+of\b/i,
  /\bjurisdiction\b|\bcourts?\b/i,
  /\barbitration\b/i,
  /\bterminate\b|\bsuspend\b/i,
  /\bintellectual\s+property\b|\bcopyright\b/i,
  /\bindemnif(?:y|ication)\b/i,
  /\bat\s+(?:our|its|their)\s+(?:sole\s+)?discretion\b/i,
  /\bwithout\s+(?:prior\s+)?notice\b/i,
  /\bterms\b/i,
  /\bprivacy\b|\bpersonal\s+(?:data|information)\b/i,
  /\bshall\s+not\b|\bmust\s+not\b|\bmay\s+not\b/i,
];

export const MIN_LEGAL_CUES = 4;

export function legalCueCount(text: string): number {
  return CUES.reduce((n, cue) => (cue.test(text) ? n + 1 : n), 0);
}

export function looksLikeLegalText(text: string): boolean {
  return legalCueCount(text) >= MIN_LEGAL_CUES;
}
