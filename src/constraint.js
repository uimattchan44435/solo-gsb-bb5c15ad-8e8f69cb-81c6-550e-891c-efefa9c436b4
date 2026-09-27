/**
 * Conditional constraint preview for a clean merge record.
 *
 * The client submits a set of rules, each carrying a unique id:
 *
 *   when the value at JSON Pointer `when.path` is DEEPLY EQUAL to the JSON
 *   value `when.equals`, the pointer `require.path` must exist.
 *
 * Every rule is evaluated against FOUR documents:
 *
 *   - base:    the saved base document;
 *   - A:       base + patchA alone, produced by the SAME base-coordinate
 *              merge pipeline as POST /api/v1/merges (array indices address
 *              base elements, removals relocate survivors, same-gap
 *              insertions keep their A-before-B order);
 *   - B:       base + patchB alone, same model;
 *   - merged:  the saved clean merge result.
 *
 * A rule violated in `merged` is classified by origin:
 *
 *   - "pre-existing":     the base document already violates the rule;
 *   - "introduced-by-A":  A alone violates it (and base does not);
 *   - "introduced-by-B":  B alone violates it (and base does not);
 *   - "combination-only": neither base nor A nor B alone violates it — the
 *                         violation only appears in the combined merge.
 *
 * When BOTH sides violate the rule individually, "introduced-by-A" and
 * "introduced-by-B" are reported together. A violation already present in
 * the base is reported as "pre-existing" only, however the single sides
 * behave.
 *
 * The preview is a pure function of the stored record and the submitted
 * rules: the record is never modified and repeated identical requests
 * produce byte-for-byte identical responses.
 */

import { mergePatches, parsePointer, deepEqual } from './merge.js';

export const CONSTRAINT_CODES = Object.freeze({
  INVALID_RULES: 'INVALID_RULES',
});

export const ORIGINS = Object.freeze({
  PRE_EXISTING: 'pre-existing',
  INTRODUCED_BY_A: 'introduced-by-A',
  INTRODUCED_BY_B: 'introduced-by-B',
  COMBINATION_ONLY: 'combination-only',
});

export class ConstraintError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ConstraintError';
    this.code = details.code || CONSTRAINT_CODES.INVALID_RULES;
    this.details = details;
  }
}

/* ------------------------------ rule checking ----------------------------- */

/**
 * Rules must carry unique ids and syntactically valid JSON Pointers. All
 * problems are collected and reported together, in request order.
 */
function checkRules(rules) {
  const indicesById = new Map();
  rules.forEach((rule, index) => {
    const indices = indicesById.get(rule.id);
    if (indices) indices.push(index);
    else indicesById.set(rule.id, [index]);
  });
  const duplicates = [...indicesById.entries()]
    .filter(([, indices]) => indices.length > 1)
    .map(([id, indices]) => ({ id, indices }));

  const invalid = [];
  rules.forEach((rule, index) => {
    for (const [field, pointer] of [
      ['when.path', rule.when.path],
      ['require.path', rule.require.path],
    ]) {
      try {
        parsePointer(pointer);
      } catch (err) {
        invalid.push({ index, id: rule.id, field, message: err.message });
      }
    }
  });

  if (duplicates.length || invalid.length) {
    throw new ConstraintError('invalid constraint rules', {
      code: CONSTRAINT_CODES.INVALID_RULES,
      duplicates,
      invalid,
    });
  }
}

/* ------------------------------ evaluation -------------------------------- */

/**
 * Total JSON Pointer lookup: never throws. Array tokens must be decimal
 * indices in range ("-" never exists); anything else reports not-exists.
 */
function lookup(doc, segments) {
  let node = doc;
  for (const seg of segments) {
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(seg)) return { exists: false };
      const idx = Number(seg);
      if (!Number.isSafeInteger(idx) || idx >= node.length) return { exists: false };
      node = node[idx];
    } else if (node !== null && typeof node === 'object') {
      if (!Object.prototype.hasOwnProperty.call(node, seg)) return { exists: false };
      node = node[seg];
    } else {
      return { exists: false };
    }
  }
  return { exists: true, value: node };
}

/**
 * Evaluate one compiled rule against one document. The requirement is only
 * checked when the antecedent matches; otherwise requireExists is null.
 */
function evaluate(doc, rule) {
  const when = lookup(doc, rule.whenSegments);
  const whenMatched = when.exists && deepEqual(when.value, rule.whenEquals);
  if (!whenMatched) {
    return { pass: true, whenExists: when.exists, whenMatched: false, requireExists: null };
  }
  const requirement = lookup(doc, rule.requireSegments);
  return {
    pass: requirement.exists,
    whenExists: true,
    whenMatched: true,
    requireExists: requirement.exists,
  };
}

/* --------------------------------- entry ---------------------------------- */

const STATE_NAMES = ['base', 'A', 'B', 'merged'];

/**
 * Evaluate the submitted rules against the base / A-alone / B-alone / merged
 * documents of a CLEAN stored record. Returns { rules, summary } with one
 * entry per submitted rule, in request order.
 *
 * Throws ConstraintError (INVALID_RULES) when rule ids are duplicated or
 * pointers are malformed.
 */
export function previewConstraints(record, rules) {
  checkRules(rules);

  // Single-side documents reuse the exact base-coordinate merge pipeline.
  // A stored clean record always replays cleanly on either side alone: the
  // same normalization already succeeded when the record was created, and
  // cross-patch conflicts need both sides.
  const documents = {
    base: record.base,
    A: mergePatches(record.base, record.patchA, []).merged,
    B: mergePatches(record.base, [], record.patchB).merged,
    merged: record.merged,
  };

  const results = rules.map((rule) => {
    const compiled = {
      whenSegments: parsePointer(rule.when.path),
      whenEquals: rule.when.equals,
      requireSegments: parsePointer(rule.require.path),
    };
    const states = {};
    for (const name of STATE_NAMES) states[name] = evaluate(documents[name], compiled);

    let mergedViolation = null;
    if (!states.merged.pass) {
      const origins = [];
      if (!states.base.pass) {
        origins.push(ORIGINS.PRE_EXISTING);
      } else {
        if (!states.A.pass) origins.push(ORIGINS.INTRODUCED_BY_A);
        if (!states.B.pass) origins.push(ORIGINS.INTRODUCED_BY_B);
        if (states.A.pass && states.B.pass) origins.push(ORIGINS.COMBINATION_ONLY);
      }
      mergedViolation = { origins };
    }

    return {
      id: rule.id,
      when: { path: rule.when.path, equals: rule.when.equals },
      require: { path: rule.require.path },
      states,
      mergedViolation,
    };
  });

  const summary = {
    total: results.length,
    violations: { base: 0, A: 0, B: 0, merged: 0 },
    mergedViolations: {
      [ORIGINS.PRE_EXISTING]: 0,
      [ORIGINS.INTRODUCED_BY_A]: 0,
      [ORIGINS.INTRODUCED_BY_B]: 0,
      [ORIGINS.COMBINATION_ONLY]: 0,
    },
  };
  for (const result of results) {
    for (const name of STATE_NAMES) {
      if (!result.states[name].pass) summary.violations[name] += 1;
    }
    if (result.mergedViolation) {
      // A both-sides violation contributes to two origin buckets, so the
      // mergedViolations counts can sum to more than violations.merged.
      for (const origin of result.mergedViolation.origins) {
        summary.mergedViolations[origin] += 1;
      }
    }
  }

  return { rules: results, summary };
}
