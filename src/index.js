/**
 * IntentGuard public API — the same engine the CLI and the Claude Code hooks use.
 */
export { openContext } from './core/context.js';
export * from './core/decision-engine.js';
export { evaluateCommand, evaluateFile, loadRules, recordFindings, verdictAtLeast, worstVerdict } from './core/conflict-engine.js';
export { checkWorkspace } from './core/check.js';
export { reviewDecisions } from './core/drift.js';
export { hashContent, hashFile, resolveEvidence } from './core/evidence-resolver.js';
export { findRelevant, looksLikeDecision, tokenize } from './core/relevance.js';
export { compileScope, globToRegExpSource, matchesScope, normalizePath } from './core/scope-matcher.js';
export { exportData, importData, EXPORT_FORMAT } from './core/transfer.js';
export { findProjectRoot, initProjectFiles, loadConfig, DEFAULT_CONFIG } from './core/project.js';
export * from './core/validation.js';
export { runHook } from './hooks/index.js';
export { main as runCli } from './cli/index.js';
