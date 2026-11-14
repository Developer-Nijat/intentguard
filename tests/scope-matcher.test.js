import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileScope, matchesScope, normalizePath, validateGlob } from '../src/core/scope-matcher.js';

const cs = { nocase: false };
const yes = (file, globs) => assert.equal(matchesScope(file, globs, cs), true, `${file} should match ${JSON.stringify(globs)}`);
const no = (file, globs) => assert.equal(matchesScope(file, globs, cs), false, `${file} should NOT match ${JSON.stringify(globs)}`);

test('directory globstar matches everything below, and only there', () => {
  yes('services/order/index.js', ['services/**']);
  yes('services/a/b/c/d.ts', ['services/**']);
  no('service/order.js', ['services/**']);
  no('apps/services/order.js', ['services/**']);
  no('services.md', ['services/**']);
});

test('a pattern without a slash matches the basename at any depth', () => {
  yes('schema.sql', ['*.sql']);
  yes('db/migrations/001_init.sql', ['*.sql']);
  no('db/migrations/001_init.sql.bak', ['*.sql']);
  yes('packages/api/package.json', ['package.json']);
  no('packages/api/package.json5', ['package.json']);
});

test('a trailing slash means the whole directory', () => {
  yes('src/generated/api/client.ts', ['src/generated/']);
  no('src/generated.ts', ['src/generated/']);
});

test('globstar in the middle matches zero or more directories', () => {
  yes('apps/web/page.tsx', ['apps/web/**/*.tsx']);
  yes('apps/web/a/b/page.tsx', ['apps/web/**/*.tsx']);
  no('apps/web/a/b/page.ts', ['apps/web/**/*.tsx']);
  yes('a.test.js', ['**/*.test.js']);
  yes('x/y/a.test.js', ['**/*.test.js']);
});

test('single star does not cross directory boundaries', () => {
  yes('apps/web/db/client.ts', ['apps/*/db/**']);
  no('apps/web/sub/db/client.ts', ['apps/*/db/**']);
});

test('brace alternation, ? and character classes', () => {
  yes('apps/web/db/x.ts', ['{apps,packages}/*/db/**']);
  yes('packages/core/db/x.ts', ['{apps,packages}/*/db/**']);
  no('tools/core/db/x.ts', ['{apps,packages}/*/db/**']);
  yes('src/a1.js', ['src/a?.js']);
  no('src/a12.js', ['src/a?.js']);
  yes('src/file-b.js', ['src/file-[abc].js']);
  no('src/file-d.js', ['src/file-[abc].js']);
  yes('src/file-d.js', ['src/file-[!abc].js']);
});

test('negated patterns exclude', () => {
  const scope = ['services/**', '!**/*.test.js', '!services/legacy/**'];
  yes('services/order/handler.js', scope);
  no('services/order/handler.test.js', scope);
  no('services/legacy/old.js', scope);
});

test('an empty scope means the whole project', () => {
  yes('anything/at/all.txt', []);
  yes('README.md', undefined);
  assert.equal(compileScope([], cs).isGlobal, true);
  // only exclusions: everything except those
  yes('src/a.js', ['!docs/**']);
  no('docs/a.md', ['!docs/**']);
});

test('paths are normalised before matching', () => {
  assert.equal(normalizePath('.\\apps\\web\\db.js'), 'apps/web/db.js');
  assert.equal(normalizePath('./a//b/'), 'a/b');
  yes('apps\\web\\db.js', ['apps/web/**']);
  yes('./apps/web/db.js', ['./apps/web/**']);
});

test('regex metacharacters in globs are literal', () => {
  yes('src/a+b(1).js', ['src/a+b(1).js']);
  no('src/aab1.js', ['src/a+b(1).js']);
  yes('file.name.ts', ['file.name.ts']);
  no('fileXname.ts', ['file.name.ts']);
});

test('unbalanced braces are treated literally instead of throwing', () => {
  assert.doesNotThrow(() => matchesScope('a/{b.js', ['a/{b.js'], cs));
  yes('a/{b.js', ['a/{b.js']);
});

test('case sensitivity is configurable', () => {
  assert.equal(matchesScope('Apps/Web/DB.js', ['apps/web/**'], { nocase: true }), true);
  assert.equal(matchesScope('Apps/Web/DB.js', ['apps/web/**'], { nocase: false }), false);
});

test('validateGlob rejects patterns that escape the project', () => {
  assert.equal(validateGlob('services/**'), null);
  assert.equal(validateGlob('!**/*.test.js'), null);
  assert.match(validateGlob('C:\\Users\\me\\**'), /relative/);
  assert.match(validateGlob('../other/**'), /\.\./);
  assert.match(validateGlob(''), /non-empty/);
  assert.match(validateGlob('x'.repeat(301)), /too long/);
});
