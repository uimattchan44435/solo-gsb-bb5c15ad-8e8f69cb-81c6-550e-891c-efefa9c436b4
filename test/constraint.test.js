import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { EXAMPLE_REQUEST, EXAMPLE_CONFLICT_REQUEST } from '../src/example.js';

let app;

before(async () => {
  app = buildApp({ logger: false, storeMax: 100 });
  await app.ready();
});

after(async () => {
  await app.close();
});

async function createRecord(payload) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/merges', payload });
  return res.json();
}

function preview(id, rules) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/merges/${id}/constraint-preview`,
    payload: { rules },
  });
}

const rule = (id, whenPath, equals, requirePath) => ({
  id,
  when: { path: whenPath, equals },
  require: { path: requirePath },
});

/**
 * Payload exercising every origin classification:
 *  A-alone: { mode: 'modern', features: { cache, tracing }, servers: [a, b] }
 *  B-alone: { mode: 'legacy', features: { cache, retries, tracing }, servers: [b] }
 *  merged:  { mode: 'modern', features: { cache, tracing, retries }, servers: [b] }
 */
const CLASSIFICATION_REQUEST = {
  base: {
    mode: 'legacy',
    db: { host: 'db1', port: 5432 },
    features: { cache: true },
    servers: [{ host: 'a' }, { host: 'b' }],
  },
  patchA: [
    { op: 'replace', path: '/mode', value: 'modern' },
    { op: 'add', path: '/features/tracing', value: true },
  ],
  patchB: [
    { op: 'remove', path: '/servers/0' },
    { op: 'add', path: '/features/retries', value: 3 },
    { op: 'add', path: '/features/tracing', value: true },
  ],
};

const CLASSIFICATION_RULES = [
  rule('db-host-requires-ssl', '/db/host', 'db1', '/db/ssl'),
  rule('modern-mode-requires-backup', '/mode', 'modern', '/features/backup'),
  rule('retries-requires-alerting', '/features/retries', 3, '/features/alerting'),
  rule('tracing-requires-region', '/features/tracing', true, '/region'),
  rule('modern-mode-requires-two-servers', '/mode', 'modern', '/servers/1'),
  rule('cache-implies-db-host', '/features/cache', true, '/db/host'),
];

/* --------------------------- four-state evaluation ------------------------ */

test('constraint preview evaluates every rule on base / A / B / merged and classifies origins', async () => {
  const record = await createRecord(CLASSIFICATION_REQUEST);
  assert.equal(record.status, 'clean');

  const res = await preview(record.id, CLASSIFICATION_RULES);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, record.id);
  assert.equal(body.createdAt, record.createdAt);
  assert.equal(body.status, 'clean');
  assert.equal(body.rules.length, CLASSIFICATION_RULES.length);

  const byId = Object.fromEntries(body.rules.map((r) => [r.id, r]));
  // violated in every state: pre-existing
  assert.deepEqual(
    Object.values(byId['db-host-requires-ssl'].states).map((s) => s.pass),
    [false, false, false, false],
  );
  assert.deepEqual(byId['db-host-requires-ssl'].mergedViolation, { origins: ['pre-existing'] });
  // A alone violates, B heals it in the merge: introduced-by-A
  assert.deepEqual(
    Object.values(byId['modern-mode-requires-backup'].states).map((s) => s.pass),
    [true, false, true, false],
  );
  assert.deepEqual(byId['modern-mode-requires-backup'].mergedViolation, {
    origins: ['introduced-by-A'],
  });
  // introduced-by-B
  assert.deepEqual(
    Object.values(byId['retries-requires-alerting'].states).map((s) => s.pass),
    [true, true, false, false],
  );
  assert.deepEqual(byId['retries-requires-alerting'].mergedViolation, {
    origins: ['introduced-by-B'],
  });
  // both sides violate individually: A and B are both marked
  assert.deepEqual(
    Object.values(byId['tracing-requires-region'].states).map((s) => s.pass),
    [true, false, false, false],
  );
  assert.deepEqual(byId['tracing-requires-region'].mergedViolation, {
    origins: ['introduced-by-A', 'introduced-by-B'],
  });
  // only the combination violates: A flips mode, B shrinks servers
  assert.deepEqual(
    Object.values(byId['modern-mode-requires-two-servers'].states).map((s) => s.pass),
    [true, true, true, false],
  );
  assert.deepEqual(byId['modern-mode-requires-two-servers'].mergedViolation, {
    origins: ['combination-only'],
  });
  // holds everywhere
  assert.deepEqual(
    Object.values(byId['cache-implies-db-host'].states).map((s) => s.pass),
    [true, true, true, true],
  );
  assert.equal(byId['cache-implies-db-host'].mergedViolation, null);

  assert.deepEqual(body.summary, {
    total: 6,
    violations: { base: 1, A: 3, B: 3, merged: 5 },
    mergedViolations: {
      'pre-existing': 1,
      'introduced-by-A': 2,
      'introduced-by-B': 2,
      'combination-only': 1,
    },
  });
});

test('the canned example: A-only violation healed by B, both-side violation marked A and B', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  assert.equal(record.status, 'clean');

  const res = await preview(record.id, [
    rule('tracing-requires-retries', '/features/tracing', true, '/features/retries'),
    rule('tracing-requires-region', '/features/tracing', true, '/region'),
    rule('replicas-requires-three-servers', '/replicas', 3, '/servers/2'),
  ]);
  assert.equal(res.statusCode, 200);
  const byId = Object.fromEntries(res.json().rules.map((r) => [r.id, r]));

  // base has tracing=false; A flips it without adding retries; B adds both.
  assert.deepEqual(
    Object.values(byId['tracing-requires-retries'].states).map((s) => s.pass),
    [true, false, true, true],
  );
  assert.equal(byId['tracing-requires-retries'].mergedViolation, null);
  // both sides flip tracing, neither adds /region: merged violation from both.
  assert.deepEqual(byId['tracing-requires-region'].mergedViolation, {
    origins: ['introduced-by-A', 'introduced-by-B'],
  });
  // replicas=3 with three servers in A and merged: holds everywhere.
  assert.deepEqual(
    Object.values(byId['replicas-requires-three-servers'].states).map((s) => s.pass),
    [true, true, true, true],
  );
});

test('per-state details report whenExists / whenMatched / requireExists', async () => {
  const record = await createRecord({
    base: { a: 1 },
    patchA: [{ op: 'add', path: '/b', value: 2 }],
    patchB: [],
  });
  const res = await preview(record.id, [
    rule('missing-antecedent', '/nope', 1, '/also-nope'),
    rule('unequal-antecedent', '/a', 2, '/also-nope'),
    rule('matched-antecedent', '/b', 2, '/c'),
  ]);
  assert.equal(res.statusCode, 200);
  const byId = Object.fromEntries(res.json().rules.map((r) => [r.id, r]));

  // antecedent pointer absent in every state
  for (const state of Object.values(byId['missing-antecedent'].states)) {
    assert.deepEqual(state, { pass: true, whenExists: false, whenMatched: false, requireExists: null });
  }
  // antecedent exists but value differs
  assert.deepEqual(byId['unequal-antecedent'].states.base, {
    pass: true,
    whenExists: true,
    whenMatched: false,
    requireExists: null,
  });
  // antecedent matches only in A and merged (where /b was added)
  assert.deepEqual(byId['matched-antecedent'].states.base, {
    pass: true,
    whenExists: false,
    whenMatched: false,
    requireExists: null,
  });
  assert.deepEqual(byId['matched-antecedent'].states.A, {
    pass: false,
    whenExists: true,
    whenMatched: true,
    requireExists: false,
  });
  assert.deepEqual(byId['matched-antecedent'].states.merged, {
    pass: false,
    whenExists: true,
    whenMatched: true,
    requireExists: false,
  });
});

/* ------------------------- base-coordinate semantics ---------------------- */

test('single-side states follow base-coordinate patch semantics (index relocation)', async () => {
  const record = await createRecord({
    base: { list: ['a', 'b', 'c'] },
    patchA: [
      { op: 'remove', path: '/list/0' },
      { op: 'replace', path: '/list/2', value: 'C' },
    ],
    patchB: [],
  });
  assert.equal(record.status, 'clean');
  // Base coordinates: replace targets base element 2, which relocates to
  // final index 1 after the removal — strict sequential RFC 6902 replay
  // would fail with an out-of-bounds index instead.
  assert.deepEqual(record.merged, { list: ['b', 'C'] });

  const res = await preview(record.id, [rule('relocated-C', '/list/1', 'C', '/missing')]);
  assert.equal(res.statusCode, 200);
  const [result] = res.json().rules;
  // /list/1 is "C" in A-alone and merged: the antecedent matched the
  // relocated element, so the missing requirement fails there.
  assert.equal(result.states.base.pass, true); // /list/1 is "b" in base
  assert.equal(result.states.A.whenMatched, true);
  assert.equal(result.states.A.pass, false);
  assert.equal(result.states.merged.pass, false);
  assert.deepEqual(result.mergedViolation, { origins: ['introduced-by-A'] });
});

/* ------------------------------ rule semantics ---------------------------- */

test('when.equals uses deep equality (key order and nesting insensitive)', async () => {
  const record = await createRecord({
    base: { cfg: { x: 1, y: [1, { z: 2 }] }, other: null },
    patchA: [],
    patchB: [],
  });
  const res = await preview(record.id, [
    rule('deep-object', '/cfg', { y: [1, { z: 2 }], x: 1 }, '/missing'),
    rule('null-equals-null', '/other', null, '/cfg'),
  ]);
  assert.equal(res.statusCode, 200);
  const byId = Object.fromEntries(res.json().rules.map((r) => [r.id, r]));
  // deeply equal despite different key order -> matched, requirement missing
  assert.equal(byId['deep-object'].states.base.whenMatched, true);
  assert.equal(byId['deep-object'].states.base.pass, false);
  assert.deepEqual(byId['deep-object'].mergedViolation, { origins: ['pre-existing'] });
  // null deep-equals null; /cfg exists -> pass
  assert.equal(byId['null-equals-null'].states.base.whenMatched, true);
  assert.equal(byId['null-equals-null'].states.base.pass, true);
});

test('escaped pointers, array indices and the root pointer work', async () => {
  const record = await createRecord({
    base: { 'a/b': { 'c~d': 1 }, list: ['x'] },
    patchA: [],
    patchB: [],
  });
  const res = await preview(record.id, [
    rule('escaped', '/a~1b/c~0d', 1, '/a~1b'),
    rule('out-of-bounds-require', '/list/0', 'x', '/list/1'),
    rule('dash-never-exists', '/list/0', 'x', '/list/-'),
    rule('root-antecedent', '', { 'a/b': { 'c~d': 1 }, list: ['x'] }, ''),
  ]);
  assert.equal(res.statusCode, 200);
  const byId = Object.fromEntries(res.json().rules.map((r) => [r.id, r]));
  assert.equal(byId['escaped'].states.base.pass, true);
  assert.equal(byId['escaped'].states.base.whenMatched, true);
  // /list/1 is out of bounds -> requirement fails everywhere
  assert.equal(byId['out-of-bounds-require'].states.base.pass, false);
  assert.equal(byId['out-of-bounds-require'].states.base.requireExists, false);
  // "-" is not an existing element
  assert.equal(byId['dash-never-exists'].states.base.requireExists, false);
  // the root always exists, so a matched root antecedent passes
  assert.equal(byId['root-antecedent'].states.base.whenMatched, true);
  assert.equal(byId['root-antecedent'].states.base.pass, true);
});

test('empty rules array yields an empty result set', async () => {
  const record = await createRecord({ base: { a: 1 }, patchA: [], patchB: [] });
  const res = await preview(record.id, []);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.rules, []);
  assert.deepEqual(body.summary, {
    total: 0,
    violations: { base: 0, A: 0, B: 0, merged: 0 },
    mergedViolations: {
      'pre-existing': 0,
      'introduced-by-A': 0,
      'introduced-by-B': 0,
      'combination-only': 0,
    },
  });
});

/* ------------------------------ error cases ------------------------------- */

test('duplicate rule ids return 422 listing every occurrence', async () => {
  const record = await createRecord({ base: { a: 1 }, patchA: [], patchB: [] });
  const res = await preview(record.id, [
    rule('dup', '/a', 1, '/a'),
    rule('ok', '/a', 1, '/a'),
    rule('dup', '/a', 2, '/a'),
  ]);
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.code, 'INVALID_RULES');
  assert.deepEqual(body.duplicates, [{ id: 'dup', indices: [0, 2] }]);
  assert.deepEqual(body.invalid, []);
});

test('malformed pointers return 422 with rule index, id and field', async () => {
  const record = await createRecord({ base: { a: 1 }, patchA: [], patchB: [] });
  const res = await preview(record.id, [
    rule('bad-when', 'a', 1, '/a'),
    rule('bad-require', '/a', 1, 'b'),
  ]);
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.code, 'INVALID_RULES');
  assert.deepEqual(body.duplicates, []);
  assert.deepEqual(
    body.invalid.map((p) => [p.index, p.id, p.field]),
    [
      [0, 'bad-when', 'when.path'],
      [1, 'bad-require', 'require.path'],
    ],
  );
  assert.match(body.invalid[0].message, /invalid JSON Pointer/);
});

test('malformed bodies return 400', async () => {
  const record = await createRecord({ base: { a: 1 }, patchA: [], patchB: [] });
  const cases = [
    {}, // missing rules
    { rules: 'nope' }, // rules must be an array
    { rules: [{}] }, // missing id / when / require
    { rules: [{ id: 'x', when: { path: '/a' }, require: { path: '/a' } }] }, // missing equals
    { rules: [{ id: 'x', when: { equals: 1 }, require: { path: '/a' } }] }, // missing when.path
    { rules: [{ id: 'x', when: { path: '/a', equals: 1 } }] }, // missing require
    { rules: [{ id: '', when: { path: '/a', equals: 1 }, require: { path: '/a' } }] }, // empty id
  ];
  for (const payload of cases) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/merges/${record.id}/constraint-preview`,
      payload,
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  // Like the other endpoints, unknown fields are ignored (ajv strips them).
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${record.id}/constraint-preview`,
    payload: {
      rules: [{ id: 'x', when: { path: '/a', equals: 1 }, require: { path: '/a' }, extra: 1 }],
    },
  });
  assert.equal(res.statusCode, 200);
});

test('constraint preview for an unknown id returns 404', async () => {
  const res = await preview('no-such-record', [rule('r', '/a', 1, '/a')]);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'Not Found');
});

test('constraint preview on a conflict record returns 409 and does not modify it', async () => {
  const record = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  assert.equal(record.status, 'conflict');

  const res = await preview(record.id, [rule('r', '/mode', 'ha', '/x')]);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'Conflict');
  assert.match(res.json().message, /conflict/);

  const fetched = await app.inject({ method: 'GET', url: `/api/v1/merges/${record.id}` });
  assert.equal(fetched.json().status, 'conflict');
  assert.equal(fetched.json().merged, null);
});

/* --------------------------- purity & determinism ------------------------- */

test('preview does not modify the record and repeats byte-for-byte', async () => {
  const record = await createRecord(CLASSIFICATION_REQUEST);
  const before = (await app.inject({ method: 'GET', url: `/api/v1/merges/${record.id}` })).body;

  const first = await preview(record.id, CLASSIFICATION_RULES);
  const second = await preview(record.id, CLASSIFICATION_RULES);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body, second.body);

  const afterPreview = (await app.inject({
    method: 'GET',
    url: `/api/v1/merges/${record.id}`,
  })).body;
  assert.equal(afterPreview, before);
});
