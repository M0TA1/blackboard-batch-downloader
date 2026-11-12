import test from 'node:test';
import assert from 'node:assert/strict';
import * as selection from '../extension/selection.js';

const files = [
  { id: 'pdf', name: '第一讲 课程.PDF', extension: 'pdf' },
  { id: 'ppt', name: 'Lecture Notes.pptx', extension: 'pptx' },
  { id: 'doc', name: 'Lecture Reading.docx', extension: 'docx' },
  { id: 'xls', name: '成绩.xlsx', extension: 'xlsx' },
  { id: 'csv', name: '成绩导出.csv', extension: 'csv' },
];

const mixedFiles = [
  ...files,
  { id: 'wav', name: 'Lecture Audio.wav', extension: 'wav' },
  { id: 'txt', name: 'Lecture Transcript.txt', extension: 'txt' },
  { id: 'zip', name: '课程附件.zip', extension: 'zip' },
  { id: 'custom', name: 'uncommon.custom', extension: 'custom' },
];

test('other includes audio, text, archives and unlisted extensions without office files', () => {
  assert.deepEqual(selection.filterFiles(mixedFiles, '', 'other').map(file => file.id), ['wav', 'txt', 'zip', 'custom']);
  assert.deepEqual(selection.filterFiles(mixedFiles, '  LECTURE  ', 'other').map(file => file.id), ['wav', 'txt']);
  assert.deepEqual(selection.filterFiles(mixedFiles, 'uncommon', 'other').map(file => file.id), ['custom']);
  assert.deepEqual(selection.filterFiles(mixedFiles, '成绩', 'other'), []);
});

test('other select and deselect visible preserve hidden choices across file types and searches', () => {
  const selected = new Set(['pdf', 'zip']);
  const visible = selection.filterFiles(mixedFiles, 'Lecture', 'other');
  const withVisible = selection.setVisibleSelection(selected, visible, true);
  assert.deepEqual([...withVisible], ['pdf', 'zip', 'wav', 'txt']);
  const transcript = selection.filterFiles(mixedFiles, 'Transcript', 'other');
  assert.deepEqual([...selection.setVisibleSelection(withVisible, transcript, false)], ['pdf', 'zip', 'wav']);
  assert.deepEqual([...selected], ['pdf', 'zip']);
});

test('file categories retain original groups and classify every other extension as other', () => {
  const cases = [
    ['pdf', 'pdf'], ['ppt', 'presentation'], ['pptx', 'presentation'],
    ['doc', 'document'], ['docx', 'document'], ['xls', 'spreadsheet'],
    ['xlsx', 'spreadsheet'], ['csv', 'spreadsheet'],
    ['wav', 'other'], ['txt', 'other'], ['zip', 'other'], ['custom', 'other'],
    ['', 'other'], ['PDF', 'pdf'],
  ];
  for (const [extension, expected] of cases) {
    assert.equal(selection.fileCategory(extension), expected, extension);
  }
});

test('different route hashes cannot restore an older page scan', () => {
  assert.equal(selection.samePage('https://school.example/course/#week1', 'https://school.example/course/#week2'), false);
});

test('different query parameters cannot restore an older page scan', () => {
  assert.equal(selection.samePage('https://school.example/course?week=1', 'https://school.example/course?week=2'), false);
});

test('identical complete page URLs can restore a scan', () => {
  assert.equal(selection.samePage('https://school.example/course?term=1#week2', 'https://school.example/course?term=1#week2'), true);
});

test('search matches file names without case or surrounding whitespace', () => {
  assert.deepEqual(selection.filterFiles(files, '  LECTURE  ', 'all').map(file => file.id), ['ppt', 'doc']);
  assert.deepEqual(selection.filterFiles(files, '第一讲', 'all').map(file => file.id), ['pdf']);
});

test('type groups filter presentations, documents, spreadsheets and PDF', () => {
  assert.deepEqual(selection.filterFiles(files, '', 'presentation').map(file => file.id), ['ppt']);
  assert.deepEqual(selection.filterFiles(files, '', 'document').map(file => file.id), ['doc']);
  assert.deepEqual(selection.filterFiles(files, '', 'spreadsheet').map(file => file.id), ['xls', 'csv']);
  assert.deepEqual(selection.filterFiles(files, '', 'pdf').map(file => file.id), ['pdf']);
  assert.deepEqual(selection.filterFiles(files, 'Reading', 'presentation'), []);
});

test('filtering leaves hidden selections intact', () => {
  const selected = new Set(['pdf', 'doc']);
  selection.filterFiles(files, 'Lecture', 'presentation');
  assert.deepEqual([...selected], ['pdf', 'doc']);
});

test('select visible adds only filtered files while keeping hidden choices', () => {
  const selected = new Set(['pdf']);
  const visible = selection.filterFiles(files, 'Lecture', 'all');
  const result = selection.setVisibleSelection(selected, visible, true);
  assert.deepEqual([...result], ['pdf', 'ppt', 'doc']);
  assert.deepEqual([...selected], ['pdf']);
});

test('deselect visible preserves selected files hidden by search or type', () => {
  const selected = new Set(['pdf', 'ppt', 'doc', 'csv']);
  const visible = selection.filterFiles(files, 'Lecture', 'presentation');
  assert.deepEqual([...selection.setVisibleSelection(selected, visible, false)], ['pdf', 'doc', 'csv']);
});

test('restored selection accepts only ids in the current scan', () => {
  assert.deepEqual([...selection.validSelection(files, ['pdf', 'stale', 'csv', 'pdf'])], ['pdf', 'csv']);
  assert.deepEqual([...selection.validSelection(files, null)], []);
});

test('starting and in-progress downloads remain active until final events', () => {
  for (const status of ['queued', 'starting', 'in_progress']) {
    assert.equal(selection.isBatchActive({ jobs: [{ status }] }), true);
  }
  assert.equal(selection.isBatchActive({ jobs: [{ status: 'complete' }, { status: 'interrupted' }, { status: 'cancelled' }] }), false);
  assert.equal(selection.isBatchActive(null), false);
});
