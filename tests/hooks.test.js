import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { recordDecision, rejectAlternative, resolveConflict } from '../src/core/decision-engine.js';
import { isOwnCliOnly } from '../src/hooks/self-guard.js';
import { HOOK_EVENTS, runHook } from '../src/hooks/index.js';
import { BIN, GENERATED, MONGO, RABBIT, REPO, makeProject, meta, runBin, tempDir } from './helpers.js';

/** The real CLI entry point, as a shell-friendly path. */
const CLI = BIN.replace(/\\/g, '/');

const IMPORT = "import { MongoClient } from 'mongodb';";
const contextOf = (output) => output?.hookSpecificOutput?.additionalContext ?? '';

function writeCall(root, file, content, extra = {}) {
  return { session_id: 's1', cwd: root, tool_name: 'Write', tool_use_id: 'tool-1', tool_input: { file_path: path.join(root, file), content }, ...extra };
}

/* ------------------------------------------------------------ fast path */

test('hooks are a silent no-op in projects that never ran init', async (t) => {
  const dir = tempDir(t);
  for (const event of Object.keys(HOOK_EVENTS)) {
    assert.equal(await runHook(event, { session_id: 's', cwd: dir, prompt: 'never use redux', tool_name: 'Write', tool_input: {} }), null, event);
  }
});

test('an unknown hook event does nothing', async (t) => {
  const { root } = makeProject(t);
  assert.equal(await runHook('nope', { cwd: root }), null);
});

/* ----------------------------------------------------------- SessionStart */

test('SessionStart briefs Claude on active decisions, rejected ideas and pending work', async (t) => {
  const { root, ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  recordDecision(ctx, GENERATED, meta);
  recordDecision(ctx, { ...RABBIT, source: 'claude' }, { actor: 'claude' });
  rejectAlternative(ctx, { title: 'Redis for caching', reason: 'No Redis in our infrastructure' });

  const output = await runHook('session-start', { session_id: 's1', cwd: root, source: 'startup' });
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  const text = contextOf(output);
  assert.match(text, /2 active engineering decisions/);
  assert.match(text, /DEC-0001 \[architectural\] Frontend must never access MongoDB directly — scope: apps\/web\/\*\*/);
  assert.match(text, /MUST NOT: No MongoDB driver in the frontend/);
  assert.match(text, /Rejected ideas on record.*ALT-0002 Redis for caching/);
  assert.match(text, /Proposed decisions awaiting confirmation \(not enforced\): DEC-0003/);
  assert.ok(text.indexOf('DEC-0002') < text.indexOf('DEC-0001'), 'critical constraints are listed first');
  assert.doesNotMatch(text, /DEC-0003 \[/, 'proposed decisions are not presented as rules');
});

test('SessionStart on an empty store invites capture without inventing rules', async (t) => {
  const { root } = makeProject(t);
  const text = contextOf(await runHook('session-start', { session_id: 's1', cwd: root, source: 'startup' }));
  assert.match(text, /no engineering decisions are recorded yet/);
  assert.match(text, /Never record a decision without their explicit confirmation/);
});

test('SessionStart points out a shared decisions file that was never imported here', async (t) => {
  const { root, ctx } = makeProject(t, { '.intentguard/decisions.json': '{"format":"intentguard/v1","decisions":[]}' });
  const empty = contextOf(await runHook('session-start', { session_id: 's1', cwd: root }));
  assert.match(empty, /shared decisions file exists \(\.intentguard\/decisions\.json\)/);
  assert.match(empty, /if they agree run: intentguard import \.intentguard\/decisions\.json/);
  recordDecision(ctx, RABBIT, meta);
  assert.doesNotMatch(contextOf(await runHook('session-start', { session_id: 's1', cwd: root })), /shared decisions file/);
});

test('the session briefing is capped', async (t) => {
  const { root, ctx } = makeProject(t);
  for (let i = 0; i < 20; i++) recordDecision(ctx, { title: `Rule number ${i}`, decision: 'd', reason: 'r' }, meta);
  const text = contextOf(await runHook('session-start', { session_id: 's1', cwd: root }));
  assert.match(text, /…and 8 more/);
  assert.ok(text.length < 8200);
});

/* ------------------------------------------------------- UserPromptSubmit */

test('UserPromptSubmit surfaces the relevant decision with its reason and evidence — once per session', async (t) => {
  const { root, ctx } = makeProject(t, { 'docs/architecture.md': '# Architecture\n' });
  recordDecision(ctx, MONGO, meta);
  const input = { session_id: 's1', cwd: root, prompt: 'Add a mongodb query to the web dashboard' };

  const first = await runHook('user-prompt-submit', input);
  assert.equal(first.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const text = contextOf(first);
  assert.match(text, /DEC-0001 "Frontend must never access MongoDB directly"/);
  assert.match(text, /Why: All business operations must pass through the backend authorization layer\./);
  assert.match(text, /Evidence: docs\/architecture\.md \(section 3\)/);
  assert.match(text, /only deliberately/);

  assert.equal(await runHook('user-prompt-submit', input), null, 'not repeated in the same session');
  assert.ok(await runHook('user-prompt-submit', { ...input, session_id: 's2' }), 'a new session is told again');
});

test('UserPromptSubmit reminds Claude of a rejected idea when it comes up again', async (t) => {
  const { root, ctx } = makeProject(t);
  rejectAlternative(ctx, { title: 'Redis for caching', reason: 'No Redis in our infrastructure' });
  const text = contextOf(await runHook('user-prompt-submit', { session_id: 's1', cwd: root, prompt: 'Let us add Redis in front of the API' }));
  assert.match(text, /already considered and rejected/);
  assert.match(text, /ALT-0001 "Redis for caching" — rejected because: No Redis in our infrastructure/);
});

test('UserPromptSubmit stays silent for unrelated prompts and slash commands', async (t) => {
  const { root, ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  assert.equal(await runHook('user-prompt-submit', { session_id: 's1', cwd: root, prompt: 'Rename this variable' }), null);
  assert.equal(await runHook('user-prompt-submit', { session_id: 's1', cwd: root, prompt: '/intentguard:why mongodb' }), null);
  assert.equal(await runHook('user-prompt-submit', { session_id: 's1', cwd: root, prompt: '   ' }), null);
  assert.equal(await runHook('user-prompt-submit', { session_id: 's1', cwd: root }), null);
});

test('decision language triggers a capture hint, and can be switched off', async (t) => {
  const { root, ctx } = makeProject(t);
  const prompt = 'From now on all call recordings are stored in MinIO.';
  const text = contextOf(await runHook('user-prompt-submit', { session_id: 's1', cwd: root, prompt }));
  assert.match(text, /may state a durable engineering decision/);
  assert.match(text, /Never record a decision without the developer's explicit confirmation/);
  assert.equal(ctx.store.sessions.list('s1', 'candidate').length, 1);

  const quiet = makeProject(t, {}, { capture: { suggest: false } });
  assert.equal(await runHook('user-prompt-submit', { session_id: 's1', cwd: quiet.root, prompt }), null);
});

/* -------------------------------------------------------------- PreToolUse */

test('PreToolUse warns about a conflicting write with decision ID, rule, reason, evidence and location', async (t) => {
  const { root, ctx } = makeProject(t, { 'docs/architecture.md': '# Architecture\n' });
  recordDecision(ctx, MONGO, meta);
  const output = await runHook('pre-tool-use', writeCall(root, 'apps/web/db.js', `// db\n${IMPORT}\n`));
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined, 'warn mode never blocks');
  const text = contextOf(output);
  assert.match(text, /CONF-0001 · POTENTIAL CONFLICT with DEC-0001 "Frontend must never access MongoDB directly"/);
  assert.match(text, /Rule CON-0001 \(MUST NOT, high\): No MongoDB driver in the frontend/);
  assert.match(text, /Reason: All business operations must pass through the backend authorization layer\./);
  assert.match(text, /Evidence: docs\/architecture\.md \(section 3\)/);
  assert.match(text, /apps\/web\/db\.js:2 matches/);
  assert.match(text, /1\. Keep the decision/);
  assert.match(text, /3\. Allow an explicit exception/);
  assert.equal(ctx.store.conflicts.get('CONF-0001').detectedBy, 'hook');
});

test('the same conflict is not announced twice in one session', async (t) => {
  const { root, ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const call = writeCall(root, 'apps/web/db.js', IMPORT);
  assert.ok(await runHook('pre-tool-use', call));
  assert.equal(await runHook('pre-tool-use', { ...call, tool_use_id: 'tool-2' }), null);
  assert.equal(await runHook('pre-tool-use', { ...call, tool_name: 'Edit', tool_input: { file_path: call.tool_input.file_path, old_string: 'x', new_string: IMPORT } }), null);
  assert.ok(await runHook('pre-tool-use', { ...call, session_id: 's2' }), 'a later session is warned again while it is pending');
  assert.equal(ctx.store.conflicts.list().length, 1);
});

test('after compaction the reminders may be shown again', async (t) => {
  const { root, ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const call = writeCall(root, 'apps/web/db.js', IMPORT);
  assert.ok(await runHook('pre-tool-use', call));
  assert.equal(await runHook('pre-tool-use', call), null);
  await runHook('session-start', { session_id: 's1', cwd: root, source: 'compact' });
  assert.ok(await runHook('pre-tool-use', call));
});

test('a conflict dismissed as a false positive is never raised again', async (t) => {
  const { root, ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const call = writeCall(root, 'apps/web/types.js', IMPORT);
  await runHook('pre-tool-use', call);
  resolveConflict(ctx, 'CONF-0001', 'false_positive', { note: 'Type-only import, erased at build' });
  const later = await runHook('pre-tool-use', { ...call, session_id: 'another-session' });
  assert.doesNotMatch(contextOf(later), /POTENTIAL CONFLICT/);
});

test('observe mode records the conflict but says nothing about it', async (t) => {
  const { root, ctx } = makeProject(t, {}, { enforcement: 'observe' });
  recordDecision(ctx, MONGO, meta);
  const output = await runHook('pre-tool-use', writeCall(root, 'apps/web/db.js', IMPORT));
  assert.doesNotMatch(contextOf(output), /CONFLICT/);
  assert.equal(ctx.store.conflicts.countPending(), 1);
});

test('enforce mode asks the developer, and remembers the approval for the session', async (t) => {
  const { root, ctx } = makeProject(t, {}, { enforcement: 'enforce' });
  recordDecision(ctx, MONGO, meta);
  const call = writeCall(root, 'apps/web/db.js', IMPORT);

  const first = await runHook('pre-tool-use', call);
  assert.equal(first.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(first.hookSpecificOutput.permissionDecisionReason, /DEC-0001 "Frontend must never access MongoDB directly".*\[CONF-0001\]/);
  assert.match(contextOf(first), /CONF-0001/);

  // Denied (the tool never ran): the next attempt must ask again.
  const retry = await runHook('pre-tool-use', { ...call, tool_use_id: 'tool-2' });
  assert.equal(retry.hookSpecificOutput.permissionDecision, 'ask');

  // Approved: PostToolUse fires for that call, and the session stops asking.
  assert.equal(await runHook('post-tool-use', { ...call, tool_use_id: 'tool-2' }), null);
  assert.equal(await runHook('pre-tool-use', { ...call, tool_use_id: 'tool-3' }), null);

  // A different session has not approved anything.
  const other = await runHook('pre-tool-use', { ...call, session_id: 's2', tool_use_id: 'tool-9' });
  assert.equal(other.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(ctx.store.conflicts.get('CONF-0001').status, 'pending', 'approval for a session is not a resolution');
});

test('a constraint can demand enforcement even when the project default is warn', async (t) => {
  const { root, ctx } = makeProject(t);
  recordDecision(ctx, { ...GENERATED, constraints: [{ ...GENERATED.constraints[0], enforcement: 'enforce' }] }, meta);
  const output = await runHook('pre-tool-use', writeCall(root, 'src/generated/client.ts', '// tweak'));
  assert.equal(output.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(contextOf(output), /CONFIRMED VIOLATION with DEC-0001/);
  assert.match(contextOf(output), /src\/generated\/client\.ts is a protected path/);
});

test('editing a governed file triggers a one-time reminder of the decision and its reason', async (t) => {
  const { root, ctx } = makeProject(t);
  recordDecision(ctx, RABBIT, meta);
  const call = writeCall(root, 'services/order/notify.js', "await fetch('http://notification/send');");
  const text = contextOf(await runHook('pre-tool-use', call));
  assert.match(text, /services\/order\/notify\.js is governed by recorded decisions/);
  assert.match(text, /DEC-0001 "Use RabbitMQ for async communication"/);
  assert.match(text, /MUST NOT: No direct synchronous HTTP calls between services \(CON-0001\)/);
  assert.match(text, /Why: Services must remain loosely coupled/);
  assert.equal(await runHook('pre-tool-use', { ...call, tool_input: { ...call.tool_input, file_path: path.join(root, 'services/billing/x.js') } }), null);
  assert.equal(ctx.store.conflicts.list().length, 0, 'a reminder is not a conflict');
});

test('Edit, MultiEdit and NotebookEdit inputs are understood', async (t) => {
  const { root, ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const base = { cwd: root, tool_use_id: 't' };
  const edit = await runHook('pre-tool-use', { ...base, session_id: 'a', tool_name: 'Edit', tool_input: { file_path: 'apps/web/a.js', old_string: 'x', new_string: IMPORT } });
  assert.match(contextOf(edit), /apps\/web\/a\.js matches/);
  const multi = await runHook('pre-tool-use', {
    ...base,
    session_id: 'b',
    tool_name: 'MultiEdit',
    tool_input: { file_path: 'apps/web/b.js', edits: [{ old_string: 'x', new_string: 'const ok = 1;' }, { old_string: 'y', new_string: IMPORT }] },
  });
  assert.match(contextOf(multi), /apps\/web\/b\.js matches/);
  const notebook = await runHook('pre-tool-use', { ...base, session_id: 'c', tool_name: 'NotebookEdit', tool_input: { notebook_path: 'apps/web/n.ipynb', new_source: IMPORT } });
  assert.match(contextOf(notebook), /apps\/web\/n\.ipynb matches/);
});

test('shell commands are checked in both Bash and PowerShell', async (t) => {
  const { root, ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  for (const [session, tool] of [['a', 'Bash'], ['b', 'PowerShell']]) {
    const output = await runHook('pre-tool-use', { session_id: session, cwd: root, tool_name: tool, tool_input: { command: 'npm install mongoose' } });
    assert.match(contextOf(output), /command matches .* → npm install mongoose/, tool);
  }
  assert.equal(await runHook('pre-tool-use', { session_id: 'c', cwd: root, tool_name: 'Bash', tool_input: { command: 'npm test' } }), null);
});

test('recording a rule with the IntentGuard CLI is not itself flagged', async (t) => {
  const { root, ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const run = (command, session) => runHook('pre-tool-use', { session_id: session, cwd: root, tool_name: 'Bash', tool_input: { command } });
  const own = [
    'intentguard constraint add DEC-0001 --rule "x" --command-pattern "npm install mongoose"',
    `node "${CLI}" reject --title "npm install mongodb in web" --reason r`,
    `node '${CLI}' why npm install mongoose`,
  ];
  for (const [index, command] of own.entries()) assert.equal(await run(command, `own-${index}`), null, command);
  // a file that merely shares the CLI's name, somewhere else, is just another script
  assert.ok(await run('node "/somewhere/else/intentguard.js" why npm install mongoose', 'impostor'));
  // a regex alternation inside quotes is an argument, not a pipe
  assert.equal(await run('intentguard reject --title "npm (i|install) mongoose; in web" --reason r', 'own-quoted'), null);
  // …but merely mentioning the tool does not launder a real command
  assert.ok(await run('npm install mongoose # intentguard said no', 'evade-1'));
  assert.ok(await run('echo intentguard && npm install mongoose', 'evade-2'));
});

test('the CLI exemption does not extend to anything chained after or substituted into the command', async (t) => {
  const { root, ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const attempts = [
    'intentguard status && npm install mongoose',
    'intentguard status; npm install mongoose',
    'intentguard status || npm install mongoose',
    'intentguard list | npm install mongoose',
    'intentguard status\nnpm install mongoose',
    'intentguard why "$(npm install mongoose)"',
    'intentguard why `npm install mongoose`',
    'node "C:/plugins/intentguard/bin/intentguard.js" status & npm install mongoose',
    'intentguard why "unterminated && npm install mongoose',
  ];
  for (const [index, command] of attempts.entries()) {
    const output = await runHook('pre-tool-use', { session_id: `chain-${index}`, cwd: root, tool_name: 'Bash', tool_input: { command } });
    assert.match(contextOf(output), /POTENTIAL CONFLICT with DEC-0001/, command);
  }
});

test('isOwnCliOnly accepts only a single simple invocation', () => {
  for (const command of [
    'intentguard status',
    'node bin/intentguard.js why DEC-0001',
    "intentguard add --title 'a; b && c | d' --decision d --reason r",
    'intentguard constraint add DEC-1 --rule x --pattern "from [\'\\"]redux[\'\\"]"',
  ]) {
    assert.equal(isOwnCliOnly(command, 'bash', REPO), true, command);
  }
  assert.equal(isOwnCliOnly('node bin/intentguard.js why DEC-0001', 'bash', path.join(REPO, 'tests')), false, 'resolved against the working directory');
  for (const command of ['npm test', 'intentguard status > out.txt', 'intentguard status && ls', 'echo intentguard status', "intentguard why 'a' \"$(id)\""]) {
    assert.equal(isOwnCliOnly(command), false, command);
  }
});

test('edits to IntentGuard\'s own data need the developer\'s approval in every mode', async (t) => {
  const { root } = makeProject(t, {}, { enforcement: 'observe' }); // even with no decisions and in observe mode
  for (const file of ['.intentguard/config.json', '.intentguard/decisions.json', '.intentguard/intentguard.db']) {
    const output = await runHook('pre-tool-use', writeCall(root, file, '{"enforcement":"observe"}'));
    assert.equal(output.hookSpecificOutput.permissionDecision, 'ask', file);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /edits IntentGuard's own data/);
  }
  const edit = await runHook('pre-tool-use', {
    session_id: 's', cwd: root, tool_name: 'Edit',
    tool_input: { file_path: '.intentguard/config.json', old_string: '"warn"', new_string: '"observe"' },
  });
  assert.equal(edit.hookSpecificOutput.permissionDecision, 'ask');
});

test('CLI commands that weaken protection need the developer\'s approval; the rest do not', async (t) => {
  const { root, ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const run = (command, tool = 'Bash') => runHook('pre-tool-use', { session_id: 's', cwd: root, tool_name: tool, tool_input: { command } });
  const weakening = [
    'intentguard resolve CONF-0001 --as false-positive --note "trust me"',
    'intentguard exception add DEC-0001 --reason "convenient"',
    'intentguard deprecate DEC-0001',
    'intentguard purge --yes',
    'intentguard constraint remove CON-0001',
    'intentguard update DEC-0001 --scope "nothing/**"',
    'intentguard supersede DEC-0001 --input new.json --confirmed',
    'intentguard init --enforcement observe',
    'node "C:/plugins/intentguard/bin/intentguard.js" resolve CONF-0001 --as kept',
    'cd apps && intentguard deprecate DEC-0001',
  ];
  for (const command of weakening) {
    const output = await run(command);
    assert.equal(output?.hookSpecificOutput.permissionDecision, 'ask', command);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /That choice is yours/, command);
  }
  assert.equal((await run('intentguard deprecate DEC-0001', 'PowerShell')).hookSpecificOutput.permissionDecision, 'ask');
  for (const command of [
    'intentguard why DEC-0001',
    'intentguard list',
    'intentguard check --dry-run',
    'intentguard conflicts',
    'intentguard review',
    'intentguard init',
    'intentguard exception revoke EXC-0001',
    'intentguard add --title t --decision d --reason r',
  ]) {
    assert.equal(await run(command), null, command);
  }
});

test('shell commands that modify or delete IntentGuard\'s data need approval; reading it does not', async (t) => {
  const { root } = makeProject(t);
  const run = (command, tool = 'Bash') => runHook('pre-tool-use', { session_id: 's', cwd: root, tool_name: tool, tool_input: { command } });
  for (const [command, tool] of [
    ['rm -rf .intentguard', 'Bash'],
    ['echo \'{"enforcement":"observe"}\' > .intentguard/config.json', 'Bash'],
    ["sed -i 's/warn/observe/' .intentguard/config.json", 'Bash'],
    ['sqlite3 .intentguard/intentguard.db "DELETE FROM constraints"', 'Bash'],
    ['Remove-Item .intentguard -Recurse -Force', 'PowerShell'],
    ['Set-Content .intentguard\\config.json "{}"', 'PowerShell'],
  ]) {
    const output = await run(command, tool);
    assert.equal(output?.hookSpecificOutput.permissionDecision, 'ask', command);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /may modify or delete IntentGuard's own data/, command);
  }
  for (const command of ['cat .intentguard/config.json', 'git add .intentguard/decisions.json', 'ls .intentguard', 'rm -rf dist', 'intentguard import .intentguard/decisions.json']) {
    assert.equal(await run(command), null, command);
  }
});

test('PreToolUse ignores unrelated tools and files outside the project', async (t) => {
  const { root, ctx } = makeProject(t);
  recordDecision(ctx, { title: 'Everything is protected', decision: 'd', reason: 'r', constraints: [{ rule: 'no edits', protect: true }] }, meta);
  assert.equal(await runHook('pre-tool-use', { session_id: 's', cwd: root, tool_name: 'Read', tool_input: { file_path: 'a.js' } }), null);
  assert.equal(await runHook('pre-tool-use', writeCall(root, '../outside/a.js', 'x')), null);
  assert.equal(await runHook('pre-tool-use', { session_id: 's', cwd: root, tool_name: 'Write', tool_input: {} }), null);
  assert.ok(await runHook('pre-tool-use', writeCall(root, 'a.js', 'x')));
});

test('paths are resolved against the hook cwd, including subdirectories', async (t) => {
  const { root, ctx } = makeProject(t, { 'apps/web/keep.txt': '' });
  recordDecision(ctx, MONGO, meta);
  const output = await runHook('pre-tool-use', { session_id: 's', cwd: path.join(root, 'apps', 'web'), tool_name: 'Write', tool_input: { file_path: 'db.js', content: IMPORT } });
  assert.match(contextOf(output), /apps\/web\/db\.js:1 matches/);
});

/* ------------------------------------------------------------- PostToolUse */

test('PostToolUse records which files the session touched', async (t) => {
  const { root, ctx } = makeProject(t);
  assert.equal(await runHook('post-tool-use', writeCall(root, 'src/a.js', 'x')), null);
  assert.deepEqual(ctx.store.sessions.list('s1', 'touched').map((row) => row.key), ['src/a.js']);
});

/* -------------------------------------------------------------------- Stop */

test('Stop nudges once when a stated decision went unrecorded and unmentioned', async (t) => {
  const { root } = makeProject(t);
  await runHook('user-prompt-submit', { session_id: 's1', cwd: root, prompt: 'We must never call the database from the frontend.' });
  const stop = { session_id: 's1', cwd: root, last_assistant_message: 'Done — I moved the query into the API route.' };
  const output = await runHook('stop', stop);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /"We must never call the database from the frontend\."/);
  assert.match(output.reason, /do not record anything without their confirmation/);
  assert.equal(await runHook('stop', stop), null, 'never twice for the same statement');
});

test('Stop stays out of the way when there is nothing to offer', async (t) => {
  const { root, ctx } = makeProject(t);
  const stop = (extra = {}) => runHook('stop', { session_id: 's1', cwd: root, last_assistant_message: 'Done.', ...extra });
  assert.equal(await stop(), null, 'no candidate');

  await runHook('user-prompt-submit', { session_id: 's1', cwd: root, prompt: 'From now on we use pnpm.' });
  assert.equal(await stop({ last_assistant_message: 'Done. Want me to record this decision in IntentGuard?' }), null, 'Claude already offered');

  await runHook('user-prompt-submit', { session_id: 's1', cwd: root, prompt: 'Going forward, API responses are frozen.' });
  recordDecision(ctx, RABBIT, meta);
  assert.equal(await stop(), null, 'a decision was recorded meanwhile');

  await runHook('user-prompt-submit', { session_id: 's1', cwd: root, prompt: 'From now on logs go to stdout only.' });
  assert.equal(await stop({ stop_hook_active: true }), null, 'never re-block a forced continuation');
});

test('Stop respects capture.suggest = false', async (t) => {
  const { root, ctx } = makeProject(t, {}, { capture: { suggest: false } });
  ctx.store.sessions.mark('s1', 'candidate', 'abc', 'From now on X');
  assert.equal(await runHook('stop', { session_id: 's1', cwd: root, last_assistant_message: 'Done.' }), null);
});

/* ---------------------------------------------------------------- process */

test('the hook executable prints clean JSON, nothing on stderr, and exits 0', (t) => {
  const { root, ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const result = runBin(root, ['hook', 'pre-tool-use'], JSON.stringify(writeCall(root, 'apps/web/db.js', IMPORT)));
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '', 'no ExperimentalWarning or other noise');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('the hook executable survives garbage input and broken state without failing the session', (t) => {
  const { root } = makeProject(t);
  for (const input of ['', 'not json', '[]', '{"cwd": 42}']) {
    const result = runBin(root, ['hook', 'pre-tool-use'], input);
    assert.equal(result.code, 0, JSON.stringify(input));
    assert.equal(result.stdout, '');
  }
  const none = runBin(root, ['hook'], '{}');
  assert.equal(none.code, 0);
});

test('a hook that hits an internal error is swallowed and logged', async (t) => {
  const { root, ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  ctx.store.q.run('DROP TABLE session_events');
  assert.equal(await runHook('pre-tool-use', writeCall(root, 'apps/web/db.js', IMPORT)), null);
  const fs = await import('node:fs');
  assert.match(fs.readFileSync(path.join(root, '.intentguard', 'logs', 'errors.log'), 'utf8'), /hook:pre-tool-use/);
});
