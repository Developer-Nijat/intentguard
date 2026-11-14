/**
 * Structural checks on the Claude Code plugin packaging: manifests, hooks,
 * commands, skills and the agent must stay consistent with the code.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { COMMANDS } from '../src/cli/commands.js';
import { HOOK_EVENTS } from '../src/hooks/index.js';
import * as handlers from '../src/hooks/handlers.js';
import { REPO } from './helpers.js';

const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), 'utf8');
const json = (...parts) => JSON.parse(read(...parts));

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(match, 'file must start with YAML frontmatter');
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return { fields, body: text.slice(match[0].length) };
}

test('plugin.json is valid and agrees with package.json', () => {
  const plugin = json('.claude-plugin', 'plugin.json');
  const pkg = json('package.json');
  assert.equal(plugin.name, 'intentguard');
  assert.match(plugin.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'kebab-case, no spaces');
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.license, 'MIT');
  assert.ok(plugin.description.length > 20);
});

test('marketplace.json lists this repository as the plugin', () => {
  const marketplace = json('.claude-plugin', 'marketplace.json');
  const plugin = json('.claude-plugin', 'plugin.json');
  assert.ok(marketplace.name);
  assert.ok(marketplace.owner?.name);
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, plugin.name, 'entry name must match plugin.json or install fails');
  assert.equal(marketplace.plugins[0].source, './');
  assert.equal(marketplace.plugins[0].version, plugin.version);
});

test('the package has no runtime or dev dependencies (plugins are cloned, not npm-installed)', () => {
  const pkg = json('package.json');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.type, 'module');
  assert.match(pkg.engines.node, />=22/);
});

test('every hook in hooks.json calls the bundled CLI with an event that has a handler', () => {
  const { hooks } = json('hooks', 'hooks.json');
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  const seen = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.equal(hook.type, 'command');
        const match = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/intentguard\.js" hook ([a-z-]+)$/.exec(hook.command);
        assert.ok(match, `${event}: unexpected command ${hook.command}`);
        assert.ok(HOOK_EVENTS[match[1]], `${event}: no handler mapping for "${match[1]}"`);
        assert.equal(typeof handlers[HOOK_EVENTS[match[1]]], 'function');
        assert.equal(match[1], event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(), 'event and argument agree');
        assert.ok(hook.timeout <= 30, 'hooks must not be allowed to stall a session');
        seen.push(match[1]);
      }
    }
  }
  assert.deepEqual(seen.sort(), Object.keys(HOOK_EVENTS).sort());
  assert.ok(fs.existsSync(path.join(REPO, 'bin', 'intentguard.js')));
});

test('PreToolUse covers every tool that can change the project', () => {
  const { hooks } = json('hooks', 'hooks.json');
  const matcher = hooks.PreToolUse[0].matcher.split('|');
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']) assert.ok(matcher.includes(tool), tool);
});

const EXPECTED_COMMANDS = ['check', 'conflicts', 'history', 'init', 'remember', 'review', 'why'];

test('the seven slash commands exist, are described, and call the bundled CLI', () => {
  const files = fs.readdirSync(path.join(REPO, 'commands')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort();
  assert.deepEqual(files, EXPECTED_COMMANDS);
  for (const name of files) {
    const { fields, body } = frontmatter(read('commands', `${name}.md`));
    assert.ok(fields.description?.length > 15, `${name}: description`);
    assert.ok(body.includes('node "${CLAUDE_PLUGIN_ROOT}/bin/intentguard.js"'), `${name}: must name the CLI entry point`);
  }
});

test('every `intentguard <subcommand>` mentioned in commands, skills and the agent exists in the CLI', () => {
  const documents = [
    ...fs.readdirSync(path.join(REPO, 'commands')).map((f) => read('commands', f)),
    ...fs.readdirSync(path.join(REPO, 'skills')).map((dir) => read('skills', dir, 'SKILL.md')),
    read('agents', 'decision-auditor.md'),
    read('README.md'),
  ];
  const known = new Set([...Object.keys(COMMANDS), 'help', 'version', 'hook']);
  const mentioned = new Set();
  for (const text of documents) {
    for (const match of text.matchAll(/(?:^|[`\s(])intentguard ([a-z][a-z-]*)\b/gm)) mentioned.add(match[1]);
  }
  assert.ok(mentioned.size >= 10, 'sanity: the docs do reference CLI commands');
  for (const name of mentioned) assert.ok(known.has(name), `documentation mentions unknown command "intentguard ${name}"`);
});

test('skills have a name matching their directory and a trigger-style description', () => {
  const dirs = fs.readdirSync(path.join(REPO, 'skills')).sort();
  assert.deepEqual(dirs, ['constraint-verification', 'decision-capture', 'decision-review']);
  for (const dir of dirs) {
    const { fields, body } = frontmatter(read('skills', dir, 'SKILL.md'));
    assert.equal(fields.name, dir);
    assert.match(fields.description, /^Use /, `${dir}: description should say when to use it`);
    assert.ok(fields.description.length <= 1024);
    assert.ok(body.length > 400);
  }
});

test('the auditor agent is read-only', () => {
  const { fields, body } = frontmatter(read('agents', 'decision-auditor.md'));
  assert.equal(fields.name, 'decision-auditor');
  assert.ok(fields.description.length > 40);
  const tools = fields.tools.split(',').map((tool) => tool.trim());
  for (const forbidden of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.ok(!tools.includes(forbidden), forbidden);
  assert.match(body, /--dry-run/, 'an audit must not create conflict records');
});

test('launchers exist for both POSIX shells and Windows', () => {
  assert.match(read('bin', 'intentguard'), /^#!\/bin\/sh/);
  assert.match(read('bin', 'intentguard.cmd'), /intentguard\.js/);
  assert.match(read('bin', 'intentguard.js'), /^#!\/usr\/bin\/env node/);
});
