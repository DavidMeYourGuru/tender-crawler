import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, safeHttpUrl } from '../public/ui-security.js';

test('Dashboard-URL-Sicherheitsprimitive akzeptiert ausschließlich HTTP(S)', () => {
  assert.equal(safeHttpUrl('https://example.test/a?q=1'), 'https://example.test/a?q=1');
  assert.equal(safeHttpUrl('HTTP://EXAMPLE.TEST'), 'HTTP://EXAMPLE.TEST');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(safeHttpUrl('//example.test/path'), null);
});

test('Dashboard-Renderer escaped XSS-Zeichen vor innerHTML', () => {
  const escaped = escapeHtml('<img src=x onerror=alert(1)> & "quoted"');
  assert.equal(escaped, '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot;');
});
