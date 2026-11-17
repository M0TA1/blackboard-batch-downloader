import test from 'node:test';
import assert from 'node:assert/strict';
import { safeFilename } from '../extension/filename.js';

test('safe basenames preserve Chinese extensions, reject path traversal and handle platform limits', () => {
  assert.equal(safeFilename({ name: '../../课程:一?.PDF', extension: 'pdf' }), '_.._课程_一_.PDF');
  assert.equal(safeFilename({ name: 'CON', extension: 'xlsx' }), '_CON.xlsx');
  assert.ok(new TextEncoder().encode(safeFilename({ name: '课'.repeat(200), extension: 'docx' })).length <= 220);
});
