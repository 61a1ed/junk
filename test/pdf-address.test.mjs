import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePdfAddress, decodePdfAddress } from '../public/pdf-address.js';

const address = { documentId: 'a'.repeat(64), profileId: 'b'.repeat(64), pageNumber: 23 };
test('page coordinates round-trip without losing document, trace profile, or page', () => {
  assert.deepEqual(decodePdfAddress(encodePdfAddress(address)), address);
});
test('invalid or ambiguous SQL coordinates cannot become page requests', () => {
  const prefix = `pdf:v1:${address.documentId}:${address.profileId}:`;
  for (const value of [null, 1, {}, '', `${prefix}0`, `${prefix}-1`, `${prefix}01`,
    `${prefix}1.5`, `${prefix}1e2`, `${prefix}9007199254740992`, `${prefix}1:2`,
    `${prefix}1\n`, ` ${prefix}1`, `${prefix}1 `.trimStart(),
    `pdf:v2:${address.documentId}:${address.profileId}:1`,
    `pdf:v1:${address.documentId.toUpperCase()}:${address.profileId}:1`,
    `pdf:v1:unknown:${address.profileId}:1`]) {
    assert.throws(() => decodePdfAddress(value), /Expected pdf:v1/, String(value));
  }
});

test('region references resolve only positive safe integer IDs', () => {
  assert.deepEqual(decodePdfAddress('pdf:region:v1:12'), { regionId: 12 });
  for (const value of ['0', '-1', '01', '1.5', '1e2', '9007199254740992', '1\n', '1:2']) {
    assert.throws(() => decodePdfAddress(`pdf:region:v1:${value}`));
  }
});
