import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateFiles, compactDiff, publishReview, retrieveContext, reviewPrompt } from './ai-review.mjs';

test('retrieval includes related documentation and code, but ignores generated files', () => {
  const files = ['README.md', 'docs/architecture.md', 'src/report.ts', 'src/news.ts', 'package-lock.json', 'main.js'];
  const body = new Map([
    ['README.md', 'The report is saved to Statistics only.'],
    ['docs/architecture.md', 'The report guard checks output paths.'],
    ['src/report.ts', 'export function saveReport() { return reportGuard(); }'],
    ['src/news.ts', 'export function collectNews() { return []; }'],
  ]);
  const context = retrieveContext(files, ['src/report.ts'], '+ saveReport report guard Statistics',
    (path) => body.get(path), 5_000);
  assert.match(context, /README\.md|docs\/architecture\.md/);
  assert.match(context, /src\/report\.ts/);
  assert.doesNotMatch(context, /package-lock\.json|main\.js/);
  assert.deepEqual(candidateFiles(files).includes('package-lock.json'), false);
});

test('review prompt bounds large diffs and still lists every changed file', () => {
  const diff = `diff --git a/one.ts b/one.ts\n${'+ change\n'.repeat(10_000)}`;
  const prompt = reviewPrompt(['one.ts', 'two.ts'], diff, '### README.md:1\nArchitecture');
  assert.match(prompt, /one\.ts\ntwo\.ts/);
  assert.match(prompt, /README\.md:1/);
  assert.match(compactDiff(diff, 2_000), /diff опущена/);
  assert.ok(prompt.length < 32_000);
});

test('a rerun updates the bot comment and rejects a stale PR head', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), method: options.method });
    const value = String(url).includes('/pulls/7') ? { head: { sha: 'current' } }
      : String(url).includes('/issues/7/comments') ? [{ id: 42, user: { login: 'github-actions[bot]' },
        body: '<!-- askmymind-ai-review -->' }]
        : { html_url: 'https://github.com/example/repo/pull/7#issuecomment-42' };
    return new Response(JSON.stringify(value), { status: 200 });
  };
  try {
    const url = await publishReview('example/repo', 7, 'current', 'fake-token', 'Проверено');
    assert.match(url, /issuecomment-42/);
    assert.equal(requests.at(-1)?.method, 'PATCH');
    const before = requests.length;
    await assert.rejects(publishReview('example/repo', 7, 'old', 'fake-token', 'Старое'), /PR обновился/);
    assert.equal(requests.length, before + 1);
  } finally { globalThis.fetch = originalFetch; }
});
