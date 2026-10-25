/** Wording shared by the popup and the options page. Pure, so it is tested. */
import type { Sharing } from '../analysis/state.ts';

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1_000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function sharingLine(sharing: Sharing): { text: string; tone: 'good' | 'neutral' | 'warn' } {
  switch (sharing.status) {
    case 'shared':
      return { text: 'Shared publicly, so others can look this site up without running a model.', tone: 'good' };
    case 'offer':
      return { text: 'Not shared yet. Nothing leaves this computer unless you choose to share it.', tone: 'neutral' };
    case 'declined':
      return { text: 'Not shared. You chose to keep this result on this computer.', tone: 'neutral' };
    case 'page-only':
      return { text: 'Not shared: this is the page itself, not a terms document.', tone: 'neutral' };
    case 'already-public':
      return { text: 'This result comes from the public cache.', tone: 'neutral' };
    case 'not-signed-in':
      return { text: 'Not shared. Sign in as a contributor in the settings to share results.', tone: 'neutral' };
    case 'blocked':
      return { text: `Not shared or summarised: this page looks like it shows personal information (${sharing.reasons.join('; ')}).`, tone: 'warn' };
    case 'failed':
      return { text: `Not shared. ${sharing.message}`, tone: 'warn' };
  }
}

export function flaggedHeadline(count: number, passageCount: number): string {
  if (count === 0) return 'No potentially unfair clauses found';
  return `${count} potentially unfair clause${count === 1 ? '' : 's'} in ${passageCount} read`;
}

/** The first `max` characters of a clause, cut at a word, for the collapsed view. */
export function excerpt(text: string, max = 200): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), max * 0.6)).trimEnd() + '…';
}
