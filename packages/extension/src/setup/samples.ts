/** What the quick test asks the freshly downloaded model, and the answers a working model gives. */
import type { TosCategory } from '@ppg/shared';

export const CLAUSE_SAMPLES: { text: string; expect: TosCategory }[] = [
  { text: 'We may suspend or terminate your account at any time, with or without notice.', expect: 'unilateral_termination' },
  { text: 'Any dispute will be resolved by binding arbitration, and you waive the right to bring a class action.', expect: 'arbitration' },
  { text: 'You can control most communications from the services.', expect: 'other' },
];

export const PAGE_SAMPLES: { url: string; text: string; expectPersonal: boolean; label: string }[] = [
  {
    label: 'a shop order page',
    url: 'https://shop.example.net/account/orders',
    text: 'My Account. Welcome back, Jane. Order #48213 shipped to 12 Nathan Road. A confirmation was sent to jane.doe@gmail.com. Card ending 4242.',
    expectPersonal: true,
  },
  {
    label: 'a public terms page',
    url: 'https://example.com/terms',
    text: 'Terms of Service. We may change these terms at any time. Disputes are governed by the laws of California. Contact legal@example.com.',
    expectPersonal: false,
  },
];
