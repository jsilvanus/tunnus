import { describe, expect, it } from 'vitest';
import { listOperations, loadSpec } from '../src/admin/spec.js';
import { createSpecValidators } from '../src/admin/validate.js';

const spec = loadSpec();
const groupName = createSpecValidators(spec, listOperations(spec)).component('GroupName');

describe('GroupName pattern', () => {
  it.each([
    'developers',
    'parish/riihimaki',
    'canva:operate',
    'sissi:write@aikuistyo',
    'sissi:operate@screen:*',
    'pi-admins',
    'picontrol:admin',
    'Ääri.nimi_1',
  ])('accepts %s', (name) => {
    expect(groupName(name).ok).toBe(true);
  });

  it.each([
    '',
    ' spaced',
    'a b',
    '/leading',
    'trailing/',
    'a//b',
    ':leading',
    'a/@b',
    'x#y',
    'x!y',
    'x'.repeat(129),
  ])('rejects %j', (name) => {
    expect(groupName(name).ok).toBe(false);
  });
});
