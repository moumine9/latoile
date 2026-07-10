import test from 'node:test';
import assert from 'node:assert/strict';
import { isDisplayName, normalizePersonToken, personKey } from '../src/sink/person-identity.js';

test('normalizePersonToken lowercases, strips accents and punctuation', () => {
  assert.equal(normalizePersonToken('Verville-Paris'), 'vervilleparis');
  assert.equal(normalizePersonToken('Élodie'), 'elodie');
  assert.equal(normalizePersonToken('kverville_paris'), 'kvervilleparis');
});

test('isDisplayName distinguishes display names from usernames', () => {
  assert.equal(isDisplayName('Karianne Verville-Paris'), true);
  assert.equal(isDisplayName('kvervilleparis'), false);
});

test('personKey maps display names and usernames to the same key', () => {
  assert.equal(personKey('Karianne Verville-Paris'), 'kvervilleparis');
  assert.equal(personKey('kvervilleparis'), 'kvervilleparis');
  assert.equal(personKey('  Élodie  Côté '), 'ecote');
  // Multi-token last names concatenate.
  assert.equal(personKey('Jean Le Blanc'), 'jleblanc');
  // Single tokens pass through normalized.
  assert.equal(personKey('Alice'), 'alice');
});

test('personKey takes one initial per hyphenated first-name part', () => {
  assert.equal(personKey('Jean-Sébastien Roy'), 'jsroy');
  assert.equal(personKey('jsroy'), 'jsroy');
  assert.equal(personKey('Marie-Ève Gagnon-Tremblay'), 'megagnontremblay');
});
