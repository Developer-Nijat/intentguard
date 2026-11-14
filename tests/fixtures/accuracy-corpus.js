/**
 * Labelled corpus for measuring false positives and false negatives.
 *
 * `violates` / `relevant` is the ground truth a careful engineer would give.
 * `known` marks cases the mechanical layer is *expected* to get wrong, with the
 * reason — they are counted and reported, not hidden. If a change fixes one,
 * the accuracy test fails until the label is removed, so the numbers stay honest.
 */

export const DECISIONS = {
  mongo: {
    title: 'Frontend must never access MongoDB directly',
    decision: 'All data access from apps/web goes through the backend API.',
    reason: 'Business operations must pass through the backend authorization layer.',
    scope: ['apps/web/**'],
    keywords: ['mongodb', 'mongoose', 'frontend database'],
    constraints: [
      {
        rule: 'No MongoDB driver in the frontend',
        severity: 'high',
        patterns: ["from ['\"]mongo(db|ose)['\"]", "require\\(['\"]mongo(db|ose)['\"]\\)"],
        commandPatterns: ['\\b(npm|pnpm|yarn) (i|install|add) .*\\bmongo(db|ose)\\b'],
      },
    ],
  },
  redux: {
    title: 'Do not introduce Redux',
    decision: 'Client state is managed with Zustand; Redux is not used.',
    reason: 'Two state libraries doubled the onboarding cost in the previous project.',
    type: 'convention',
    keywords: ['redux', 'state management'],
    constraints: [
      {
        rule: 'No Redux packages',
        patterns: ["from ['\"](redux|react-redux|@reduxjs/toolkit)['\"]", '"(redux|react-redux|@reduxjs/toolkit)"\\s*:'],
        commandPatterns: ['\\b(npm|pnpm|yarn) (i|install|add) .*(\\bredux\\b|@reduxjs/toolkit)'],
      },
    ],
  },
  generated: {
    title: 'Generated API client is never edited by hand',
    decision: 'Files under src/generated are produced by codegen.',
    reason: 'They are overwritten on every build.',
    type: 'process',
    scope: ['src/generated/**'],
    keywords: ['generated', 'codegen'],
    constraints: [{ rule: 'Do not modify generated files', protect: true, severity: 'critical' }],
  },
  contracts: {
    title: 'Public API contracts are frozen',
    decision: 'Published response formats under contracts/ do not change; new versions are added alongside.',
    reason: 'Mobile clients in the field cannot be force-updated.',
    scope: ['contracts/**'],
    keywords: ['api contract', 'response format', 'breaking change'],
    constraints: [{ rule: 'Do not change published contracts', protect: true, severity: 'critical' }],
  },
  asyncOnly: {
    title: 'Services communicate asynchronously through RabbitMQ',
    decision: 'No service calls another service synchronously.',
    reason: 'Loose coupling and failure isolation.',
    scope: ['services/**', '!services/gateway/**'],
    keywords: ['rabbitmq', 'http', 'rest', 'synchronous', 'axios'],
    constraints: [
      {
        rule: 'No synchronous HTTP client between services',
        severity: 'high',
        patterns: ["from ['\"](axios|node-fetch|got)['\"]"],
      },
    ],
  },
  logger: {
    title: 'Pino is the only logging library',
    decision: 'All application logging goes through the shared pino logger.',
    reason: 'Log shipping parses a single JSON format.',
    type: 'convention',
    scope: ['src/**', 'services/**'],
    keywords: ['logging', 'logger', 'winston', 'pino'],
    constraints: [{ rule: 'Do not add another logging library', patterns: ["from ['\"](winston|bunyan|log4js)['\"]"] }],
  },
};

/** An exception that exists in the corpus project. */
export const EXCEPTIONS = [{ decision: 'mongo', reason: 'Admin pages are server-rendered', scope: ['apps/web/admin/**'] }];

const file = (path, text) => ({ path, text });

export const DETECTOR_CASES = [
  /* ---- real violations ------------------------------------------------- */
  { name: 'ESM import of the MongoDB driver in the frontend', change: file('apps/web/db.js', "import { MongoClient } from 'mongodb';"), violates: true },
  { name: 'CommonJS require of mongoose in the frontend', change: file('apps/web/models/user.js', 'const mongoose = require("mongoose");'), violates: true },
  { name: 'Redux import', change: file('src/store.js', "import { createStore } from 'redux';"), violates: true },
  { name: 'Redux Toolkit import', change: file('src/app/store.ts', 'import { configureStore } from "@reduxjs/toolkit";'), violates: true },
  { name: 'Redux re-export', change: file('src/state/index.js', "export * from 'redux';"), violates: true },
  { name: 'react-redux added to package.json', change: file('package.json', '    "react-redux": "^9.1.0",'), violates: true },
  { name: 'installing Redux Toolkit', change: { command: 'pnpm add @reduxjs/toolkit' }, violates: true },
  { name: 'installing mongoose', change: { command: 'cd apps/web && npm i mongoose' }, violates: true },
  { name: 'editing a generated file', change: file('src/generated/api.ts', 'export const x = 1;'), violates: true },
  { name: 'changing a published contract', change: file('contracts/orders.v1.json', '{ "total": "string" }'), violates: true },
  { name: 'axios between services', change: file('services/order/notify.js', "import axios from 'axios';"), violates: true },
  { name: 'a second logging library', change: file('src/logger.js', "import winston from 'winston';"), violates: true },
  {
    name: 'dynamic import of the MongoDB driver',
    change: file('apps/web/lib/data.js', "const { MongoClient } = await import('mongodb');"),
    violates: true,
    known: 'false-negative: the recorded patterns cover static import/require only',
  },
  {
    name: 'synchronous call with the built-in fetch',
    change: file('services/billing/client.js', "const res = await fetch('http://invoice-service/api/invoices');"),
    violates: true,
    known: 'false-negative: no library import to match — this is what the semantic review (governing-decision reminder) is for',
  },

  /* ---- not violations --------------------------------------------------- */
  { name: 'MongoDB driver in the backend (out of scope)', change: file('services/api/db.js', "import { MongoClient } from 'mongodb';"), violates: false },
  { name: 'prose mentioning mongodb', change: file('apps/web/README.md', 'We never import from mongodb in the frontend.'), violates: false },
  { name: 'a different package with a similar name', change: file('apps/web/test/db.test.js', "import { MongoMemoryServer } from 'mongodb-memory-server';"), violates: false },
  { name: 'frontend code covered by an explicit exception', change: file('apps/web/admin/users.js', "import { MongoClient } from 'mongodb';"), violates: false },
  { name: 'notes about why Redux was rejected', change: file('docs/redux-notes.md', 'Why we rejected redux: two state libraries is one too many.'), violates: false },
  { name: 'useReducer is not Redux', change: file('src/hooks/useCart.js', "import { useReducer } from 'react';"), violates: false },
  { name: 'the approved state library', change: file('src/store.js', "import { create } from 'zustand';"), violates: false },
  { name: 'uninstalling Redux', change: { command: 'npm uninstall redux' }, violates: false },
  { name: 'a commit message mentioning Redux', change: { command: 'git commit -m "remove redux leftovers"' }, violates: false },
  { name: 'installing an unrelated package', change: { command: 'npm install @types/node' }, violates: false },
  { name: 'a sibling directory of the generated code', change: file('src/generated-docs/readme.md', 'notes'), violates: false },
  { name: 'docs about contracts', change: file('docs/contracts.md', 'How we version contracts'), violates: false },
  { name: 'axios in the gateway (excluded from scope)', change: file('services/gateway/proxy.js', "import axios from 'axios';"), violates: false },
  { name: 'winston in tooling (out of scope)', change: file('tools/scripts/log.js', "import winston from 'winston';"), violates: false },
  { name: 'the approved logger', change: file('src/logger.js', "import pino from 'pino';"), violates: false },
  {
    name: 'a comment quoting the forbidden import',
    change: file('apps/web/api.js', "// TODO remove the old `import { MongoClient } from 'mongodb'` line from the legacy page"),
    violates: false,
    known: 'false-positive: a regex cannot tell a comment from code; resolve once as false-positive and it stays quiet',
  },
];

/** Prompt → decisions a careful engineer would want in front of Claude. */
export const PROMPT_CASES = [
  { prompt: 'Add a mongodb query to the web dashboard page', relevant: ['mongo'] },
  { prompt: 'Can the frontend read users straight from mongoose models?', relevant: ['mongo'] },
  { prompt: 'Set up redux for the cart state', relevant: ['redux'] },
  { prompt: 'We need better state management in the checkout flow', relevant: ['redux'] },
  { prompt: 'Fix the typo in src/generated/client.ts', relevant: ['generated'] },
  { prompt: 'Regenerate the API client with codegen', relevant: ['generated'] },
  { prompt: 'Rename the total field in the orders response format', relevant: ['contracts'] },
  { prompt: 'Is this a breaking change for the mobile app?', relevant: ['contracts'] },
  { prompt: 'Implement direct HTTP communication between OrderService and NotificationService', relevant: ['asyncOnly'] },
  { prompt: 'Have billing call the invoice service over REST', relevant: ['asyncOnly'] },
  { prompt: 'Publish an order.created event to RabbitMQ', relevant: ['asyncOnly'] },
  { prompt: 'Add winston so we get nicer logging output', relevant: ['logger'] },
  { prompt: 'Add request logging to the orders endpoint', relevant: ['logger'] },
  {
    prompt: 'Let the checkout service ask inventory for stock levels and wait for the answer',
    relevant: ['asyncOnly'],
    known: 'false-negative: describes a synchronous call without any of the recorded words',
  },
  { prompt: 'Rename the helper in utils/date.js', relevant: [] },
  { prompt: 'Why is the CI build slow today?', relevant: [] },
  { prompt: 'Add a dark mode toggle to the settings screen', relevant: [] },
  { prompt: 'Write unit tests for the price calculator', relevant: [] },
  { prompt: 'Bump the version and update the changelog', relevant: [] },
  { prompt: 'Explain what this regular expression does', relevant: [] },
  {
    prompt: 'Document how HTTP caching headers work on our CDN',
    relevant: [],
    known: 'false-positive: "http" is a recorded keyword of the service-communication decision',
  },
];
