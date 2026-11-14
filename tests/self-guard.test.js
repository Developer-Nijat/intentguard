import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { recordDecision } from '../src/core/decision-engine.js';
import { canonicalWindowsPath, toRelative } from '../src/core/project.js';
import { runHook } from '../src/hooks/index.js';
import { classifyOwnState, ownCliArgs, parseSimpleCommand, referencesDataDir, weakeningAction } from '../src/hooks/self-guard.js';
import { MONGO, cli, makeProject, meta, tempDir, write } from './helpers.js';

const classify = (command, shell = 'bash') => classifyOwnState({ kind: 'command', command, shell });
const asks = (command, shell) => typeof classify(command, shell)?.ask === 'string';
const exempt = (command, shell) => classify(command, shell)?.exempt === true;

/* ------------------------------------------------------------- tokenizer */

test('parseSimpleCommand tokenises a plain command with shell quote removal', () => {
  assert.deepEqual(parseSimpleCommand('intentguard why DEC-0001'), ['intentguard', 'why', 'DEC-0001']);
  assert.deepEqual(parseSimpleCommand(`intentguard add --title 'a; b && c | d' --reason "x > y"`), ['intentguard', 'add', '--title', 'a; b && c | d', '--reason', 'x > y']);
  assert.deepEqual(parseSimpleCommand('intentguard res""olve X'), ['intentguard', 'resolve', 'X']);
  assert.deepEqual(parseSimpleCommand(`intentguard 'res'"olve" X`), ['intentguard', 'resolve', 'X']);
  assert.deepEqual(parseSimpleCommand('intentguard r\\esolve X'), ['intentguard', 'resolve', 'X']);
  assert.deepEqual(parseSimpleCommand('intentguard add --note ""'), ['intentguard', 'add', '--note', '']);
  assert.deepEqual(parseSimpleCommand(`x "it's" 'say "hi"'`), ['x', "it's", 'say "hi"']);
  assert.deepEqual(parseSimpleCommand('x "a \\" b" "c\\\\d" "e\\nf"'), ['x', 'a " b', 'c\\d', 'e\\nf']);
  assert.deepEqual(parseSimpleCommand('x --pattern "^import$" \'$HOME\' "100$"'), ['x', '--pattern', '^import$', '$HOME', '100$']);
  assert.equal(parseSimpleCommand('   '), null);
});

test('parseSimpleCommand refuses everything that is not one fully-known simple command', () => {
  const refused = [
    'a && b', 'a; b', 'a || b', 'a | b', 'a & b', 'a\nb', 'a > f', 'a < f', 'a 2>&1',
    'a $(b)', 'a "$(b)"', 'a `b`', 'a "`b`"', 'a $HOME', 'a "$HOME"', 'a ${X}', "a $'x'", 'a $"x"',
    'a (b)', 'a {b,c}', 'a *.js', 'a res?lve', 'a [ab]',
    'a "unterminated', "a 'unterminated", 'a \\',
  ];
  for (const command of refused) assert.equal(parseSimpleCommand(command), null, JSON.stringify(command));
});

test('the reviewer\'s exploit: a quote inside the other kind of quotes cannot hide a second command', () => {
  const command = `intentguard why "it's" && npm install mongoose && echo "'"`;
  assert.equal(parseSimpleCommand(command), null);
  assert.equal(exempt(command), false);
});

test('PowerShell quoting rules: no backslash escape, doubled quotes, stop-parsing token', () => {
  // In PowerShell "a\" is a complete string, so what follows is a second statement.
  const command = 'intentguard why "a\\"; npm install mongoose; "b"';
  assert.equal(parseSimpleCommand(command, 'powershell'), null);
  assert.deepEqual(parseSimpleCommand("intentguard why 'it''s'", 'powershell'), ['intentguard', 'why', 'its']);
  assert.deepEqual(parseSimpleCommand('node C:\\plugins\\bin\\intentguard.js status', 'powershell'), ['node', 'C:\\plugins\\bin\\intentguard.js', 'status']);
  assert.equal(parseSimpleCommand('intentguard --% resolve X', 'powershell'), null);
  assert.equal(parseSimpleCommand('intentguard why `"x', 'powershell'), null);
  assert.equal(parseSimpleCommand('intentguard why $env:X', 'powershell'), null);
});

/* ------------------------------------------------------- CLI recognition */

test('ownCliArgs recognises the CLI by its resolved first word', () => {
  assert.deepEqual(ownCliArgs(['intentguard', 'why', 'x']), ['why', 'x']);
  assert.deepEqual(ownCliArgs(['node', '/plugins/intentguard/bin/intentguard.js', 'status']), ['status']);
  assert.deepEqual(ownCliArgs(['C:\\Program Files\\nodejs\\node.exe', 'C:\\p\\bin\\intentguard.js']), []);
  assert.deepEqual(ownCliArgs(['./bin/intentguard.cmd', 'list']), ['list']);
  assert.equal(ownCliArgs(['echo', 'intentguard', 'resolve']), null);
  assert.equal(ownCliArgs(['node', '--no-warnings', 'intentguard.js']), null);
  assert.equal(ownCliArgs(['intentguard-helper', 'x']), null);
  assert.equal(ownCliArgs(null), null);
});

test('weakeningAction is decided from parsed arguments, not from text', () => {
  const weak = (...args) => weakeningAction(args);
  assert.equal(weak('resolve', 'CONF-1', '--as', 'kept'), 'resolve');
  assert.equal(weak('RESOLVE', 'CONF-1'), 'resolve');
  assert.equal(weak('exception', 'add', 'DEC-1'), 'exception add');
  assert.equal(weak('constraint', 'remove', 'CON-1'), 'constraint remove');
  assert.equal(weak('review', '--keep', 'DEC-1'), 'review --keep');
  assert.equal(weak('review', '--keep=DEC-1'), 'review --keep');
  assert.equal(weak('init', '--enforcement', 'observe'), 'init --enforcement');
  assert.equal(weak('init', '--enforcement=observe'), 'init --enforcement');
  for (const safe of [['review'], ['init'], ['exception', 'revoke', 'EXC-1'], ['exception', 'list'], ['constraint', 'add', 'DEC-1'], ['why', 'resolve'], ['reject', '--title', 'purge'], ['add'], ['confirm', 'DEC-1'], []]) {
    assert.equal(weakeningAction(safe), null, safe.join(' '));
  }
});

test('quoting the subcommand does not hide a weakening action', () => {
  const evasions = [
    'intentguard "resolve" CONF-0001 --as false-positive',
    "intentguard 'deprecate' DEC-0001",
    'intentguard res""olve CONF-0001 --as kept',
    "intentguard re's'olve CONF-0001 --as kept",
    'intentguard r\\esolve CONF-0001 --as kept',
    'intentguard "exception" "add" DEC-0001 --reason x',
    'node "/p/bin/intentguard.js" \'purge\' --yes',
    'intentguard review "--keep" DEC-0001',
    // compound: not parseable as one command, found by the fallback scan
    'true && intentguard "resolve" CONF-0001 --as kept',
    'cd apps; intentguard de"pre"cate DEC-0001',
    'intentguard status && intentguard \'purge\' --yes',
    'bash -c "intentguard resolve CONF-0001 --as kept"',
  ];
  for (const command of evasions) assert.equal(asks(command), true, command);
  assert.equal(asks("intentguard 'deprecate' DEC-0001", 'powershell'), true);
});

test('plain, non-weakening CLI calls are exempt — including ones that quote weakening words as data', () => {
  for (const command of [
    'intentguard status',
    'node "C:/plugins/intentguard/bin/intentguard.js" why DEC-0001',
    'intentguard reject --title "intentguard purge was considered" --reason r',
    'intentguard why "resolve conflicts"',
    'intentguard constraint add DEC-0001 --rule x --command-pattern "npm (i|install) redux; rm -rf .intentguard"',
    'intentguard import .intentguard/decisions.json',
    'intentguard export',
  ]) {
    assert.equal(exempt(command), true, command);
  }
});

/* ------------------------------------------------------ data directory */

test('referencesDataDir sees names, quoting tricks and globs that could expand to the directory', () => {
  for (const command of [
    'rm -rf .intentguard',
    'rm -rf ./.intentguard/',
    'rm -rf ".intent"guard',
    "rm -rf .intent''guard",
    'rm -rf .intent\\guard',
    'del .INTENTGUARD\\config.json',
    'rm -rf .intent*',
    'rm -rf .i*',
    'rm -rf .*',
    'rm -rf ./.[a-z]*',
    'python -c "open(\'.intentguard/config.json\',\'w\')"',
  ]) {
    assert.equal(referencesDataDir(command), true, command);
  }
  for (const command of ['rm -rf dist', 'eslint src/**/*.js', 'rm *.log', 'ls *', 'rm -rf .git*', 'prettier --write "**/*.ts"', 'cat .gitignore']) {
    assert.equal(referencesDataDir(command), false, command);
  }
  assert.equal(referencesDataDir('Remove-Item * -Recurse', 'powershell'), true, 'PowerShell wildcards match dot-names');
  assert.equal(referencesDataDir('Remove-Item *.log', 'powershell'), false);
});

test('anything touching the data directory needs approval unless it is a plain read', () => {
  const needsApproval = [
    ['rm -rf .intentguard'],
    ['rm -rf .intent*'],
    ['mv .intentguard /tmp/x'],
    ["sed -i 's/enforce/observe/' .intentguard/config.json"],
    ['echo "{}" > .intentguard/config.json'],
    ['cat evil.json > .intentguard/config.json'],
    ['cat .intentguard/config.json | tee .intentguard/config.json'],
    ['python -c "open(\'.intentguard/config.json\',\'w\').write(\'{}\')"'],
    ['node -e "require(\'fs\').rmSync(\'.intentguard\',{recursive:true})"'],
    ['sqlite3 .intentguard/intentguard.db "DELETE FROM constraints"'],
    ['find .intentguard -delete'],
    ['git checkout -- .intentguard/config.json'],
    ['git rm -r .intentguard'],
    ['git clean -fdx'],
    ['git clean -xf'],
    ['git clean -fdX'],
    ['Remove-Item .intentguard -Recurse -Force', 'powershell'],
    ['Remove-Item * -Recurse -Force', 'powershell'],
    ['Set-Content .intentguard\\config.json "{}"', 'powershell'],
  ];
  for (const [command, shell] of needsApproval) assert.equal(asks(command, shell), true, command);

  const fine = [
    ['cat .intentguard/config.json'],
    ['ls -la .intentguard'],
    ['grep -r enforcement .intentguard'],
    ['git add .intentguard/decisions.json'],
    ['git diff .intentguard/decisions.json'],
    ['git clean -fd'],
    ['rm -rf dist'],
    ['npm test'],
    ['Get-Content .intentguard\\config.json', 'powershell'],
  ];
  for (const [command, shell] of fine) assert.equal(classify(command, shell), null, command);
});

test('export cannot be pointed at the configuration or the database', async (t) => {
  const { root } = makeProject(t);
  for (const target of ['.intentguard/config.json', '.intentguard/intentguard.db', path.join(root, '.intentguard', 'config.json')]) {
    const result = await cli(root, 'export', '--out', target);
    assert.equal(result.code, 2, target);
    assert.match(result.err, /refusing to write an export over IntentGuard's own files/);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.intentguard', 'config.json'), 'utf8')).enforcement, 'warn');
  assert.equal((await cli(root, 'export', '--out', '.intentguard/decisions.json')).code, 0);
  assert.equal((await cli(root, 'export', '--out', 'backup/decisions.json')).code, 0);
});

/* ------------------------------------------------- path normalisation */

test('canonicalWindowsPath removes spellings Windows treats as the same file', () => {
  assert.equal(canonicalWindowsPath('C:\\p\\.intentguard.\\config.json'), 'C:\\p\\.intentguard\\config.json');
  assert.equal(canonicalWindowsPath('C:\\p\\.intentguard \\config.json. .'), 'C:\\p\\.intentguard\\config.json');
  assert.equal(canonicalWindowsPath('C:\\p\\.intentguard\\config.json::$DATA'), 'C:\\p\\.intentguard\\config.json');
  assert.equal(canonicalWindowsPath('C:\\p\\.intentguard\\config.json:stream'), 'C:\\p\\.intentguard\\config.json');
  assert.equal(canonicalWindowsPath('C:\\p\\src\\a.js'), 'C:\\p\\src\\a.js');
});

test('a path that reaches the project through a link is resolved to where it really points', (t) => {
  const { root } = makeProject(t, { 'apps/web/keep.txt': '' });
  const outside = tempDir(t);
  const link = path.join(outside, 'link-to-web');
  try {
    fs.symlinkSync(path.join(root, 'apps', 'web'), link, 'junction');
  } catch {
    t.skip('cannot create a link on this system');
    return;
  }
  assert.equal(toRelative(root, path.join(link, 'db.js')), 'apps/web/db.js');
  const dataLink = path.join(outside, 'link-to-data');
  fs.symlinkSync(path.join(root, '.intentguard'), dataLink, 'junction');
  assert.equal(toRelative(root, path.join(dataLink, 'config.json')), '.intentguard/config.json');
});

test('hook: alternative spellings of a path cannot step around a scope or the data directory', async (t) => {
  const { root, ctx } = makeProject(t, { 'apps/web/keep.txt': '' });
  recordDecision(ctx, MONGO, meta);
  const outside = tempDir(t);
  const call = (file, session) => runHook('pre-tool-use', {
    session_id: session, cwd: root, tool_name: 'Write',
    tool_input: { file_path: file, content: "import { MongoClient } from 'mongodb';" },
  });

  let linked = true;
  try {
    fs.symlinkSync(path.join(root, 'apps', 'web'), path.join(outside, 'web'), 'junction');
    fs.symlinkSync(path.join(root, '.intentguard'), path.join(outside, 'data'), 'junction');
  } catch {
    linked = false;
  }
  if (linked) {
    const viaLink = await call(path.join(outside, 'web', 'db.js'), 'link');
    assert.match(viaLink.hookSpecificOutput.additionalContext, /POTENTIAL CONFLICT with DEC-0001/);
    assert.equal((await call(path.join(outside, 'data', 'config.json'), 'link2')).hookSpecificOutput.permissionDecision, 'ask');
  }

  if (process.platform === 'win32') {
    for (const [index, file] of ['.intentguard./config.json', '.intentguard/config.json.', '.intentguard/config.json::$DATA', '.INTENTGUARD/config.json'].entries()) {
      assert.equal((await call(path.join(root, file), `win-${index}`))?.hookSpecificOutput.permissionDecision, 'ask', file);
    }
    const trailing = await call(path.join(root, 'apps', 'web.', 'db.js.'), 'win-scope');
    assert.match(trailing.hookSpecificOutput.additionalContext, /POTENTIAL CONFLICT with DEC-0001/);
  }
});

test('hook: the full chain — exploit strings are evaluated, quoted weakening is asked about', async (t) => {
  const { root, ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const run = (command, session, tool = 'Bash') => runHook('pre-tool-use', { session_id: session, cwd: root, tool_name: tool, tool_input: { command } });

  const exploit = await run(`intentguard why "it's" && npm install mongoose && echo "'"`, 'x1');
  assert.match(exploit.hookSpecificOutput.additionalContext, /POTENTIAL CONFLICT with DEC-0001/);
  const ps = await run('intentguard why "a\\"; npm install mongoose; "b"', 'x2', 'PowerShell');
  assert.match(ps.hookSpecificOutput.additionalContext, /POTENTIAL CONFLICT with DEC-0001/);

  const quoted = await run('intentguard "resolve" CONF-0001 --as false-positive', 'x3');
  assert.equal(quoted.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(quoted.hookSpecificOutput.permissionDecisionReason, /"intentguard resolve" changes what IntentGuard enforces/);
  assert.equal((await run('git clean -fdx', 'x4')).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(await run('intentguard status', 'x5'), null);
  write(root, 'x.txt', '');
  assert.equal(await run('cat .intentguard/config.json', 'x6'), null);
});
