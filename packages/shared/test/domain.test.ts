import { describe, expect, test } from 'bun:test';
import { isPublicHostname } from '../src/domain.ts';
describe('isPublicHostname', () => {
  test('accepts real sites', () => {
    for (const h of ['example.com', 'www.hsbc.com.hk', 'docs.github.com', 'a.b.example.co.uk']) expect(isPublicHostname(h)).toBe(true);
  });
  test('rejects private and non-public names', () => {
    for (const h of ['localhost', 'wiki', 'nas.local', 'build.internal', '192.168.1.5', '10.0.0.1', '127.0.0.1', '[::1]', 'foo.test', 'x.example'])
      expect(isPublicHostname(h)).toBe(false);
  });
});
