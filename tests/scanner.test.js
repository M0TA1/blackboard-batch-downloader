import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const scannerPath = new URL('../extension/scanner.js', import.meta.url);
const source = fs.existsSync(scannerPath) ? fs.readFileSync(scannerPath, 'utf8') : '';
const context = vm.createContext({ URL, Date });
const policyPath = new URL('../extension/file-types.js', import.meta.url);
const policySource = fs.existsSync(policyPath) ? fs.readFileSync(policyPath, 'utf8') : '';
vm.runInContext(policySource, context);
vm.runInContext(source, context);
const api = context.BBScanner ?? {};
const identify = (...args) => api.identifyFile?.(...args);
const base = 'https://school.example/course/content/';

test('exposes the scanner API without a browser document', () => {
  assert.equal(typeof api.scanPage, 'function');
  assert.equal(typeof api.identifyFile, 'function');
  assert.equal(typeof api.mergeFiles, 'function');
});

test('identifies supported file types and preserves authenticated queries', () => {
  for (const extension of ['pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'csv']) {
    const file = identify({ url: `../files/lesson.${extension}?token=a%2Fb&x=1#page=2` }, base);
    assert.equal(file?.extension, extension);
    assert.equal(file?.url, `https://school.example/course/files/lesson.${extension}?token=a%2Fb&x=1`);
    assert.equal(file?.name, `lesson.${extension}`);
    assert.equal(typeof file?.id, 'string');
    assert.deepEqual(Object.keys(file).sort(), ['extension', 'id', 'name', 'source', 'url']);
  }
});

test('decodes Chinese paths and filename query metadata', () => {
  assert.equal(identify({ url: '/files/%E8%AF%BE%E4%BB%B6.PPTX' }, base)?.name, '课件.PPTX');
  const file = identify({ url: '/download?filename=%E8%AF%BE%E7%A8%8B.docx&signature=abc' }, base);
  assert.equal(file?.name, '课程.docx');
  assert.equal(file?.extension, 'docx');
  assert.equal(file?.url, 'https://school.example/download?filename=%E8%AF%BE%E7%A8%8B.docx&signature=abc');
});

test('uses explicit names or MIME metadata for opaque attachment URLs', () => {
  assert.equal(identify({ url: '/bbcswebdav/xid-123_1', name: 'Lecture slides.pptx' }, base)?.extension, 'pptx');
  assert.equal(identify({ url: '/attachment/123', name: '数据', mime: 'text/csv; charset=utf-8' }, base)?.name, '数据.csv');
});

test('rejects navigation and dangerous URLs even if their labels resemble files', () => {
  for (const url of ['javascript:alert(1)', 'data:application/pdf,abc', 'blob:https://school.example/a', 'file:///x.pdf', 'ftp://site/x.pdf']) {
    assert.equal(identify({ url, name: 'lecture.pdf' }, base), null);
  }
  for (const url of ['/course/123', '/bbcswebdav/xid-123_1', '/folder?name=lecture.pdf', '/course?title=slides.pptx', '']) {
    assert.equal(identify({ url, name: '附件' }, base), null);
  }
  assert.equal(identify({ url: '/next.html', name: 'Week 1' }, base), null);
});

test('requires attachment evidence before using a display name as file metadata', () => {
  for (const url of ['/next.html', '/webapps/blackboard/content/listContent.jsp?course_id=1', '/preview/123']) {
    assert.equal(identify({ url, name: 'Lecture.pptx' }, base), null);
  }
  for (const url of ['/bbcswebdav/xid-123_1', '/xythoswfs/123', '/attachment/123', '/download/123']) {
    assert.equal(identify({ url, name: 'Lecture.pptx' }, base)?.extension, 'pptx');
  }
  assert.equal(identify({ url: '/opaque/123', name: 'Lecture.pptx', trustedMetadata: true }, base)?.extension, 'pptx');
});

test('does not disguise PDF previews as original Office documents', () => {
  assert.equal(identify({ url: '/converted/slides.pdf', name: 'slides.pptx' }, base), null);
  assert.equal(identify({ url: '/preview/123', name: 'slides.pptx', mime: 'application/pdf' }, base), null);
  assert.equal(identify({ url: '/converted.pdf?filename=slides.pptx' }, base), null);
});

test('uses the supplied original URL rather than downloading an Office viewer page', () => {
  const file = identify({
    url: 'https://view.officeapps.live.com/op/embed.aspx?src=https%3A%2F%2Fschool.example%2Foriginal.pptx%3Fsig%3Da%252Fb',
    name: 'original.pptx'
  }, base);
  assert.equal(file?.url, 'https://school.example/original.pptx?sig=a%2Fb');
  assert.equal(identify({ url: 'https://view.officeapps.live.com/op/embed.aspx?src=javascript%3Aalert(1)', name: 'lesson.docx' }, base), null);
});

test('deduplicates fragments while retaining distinct signed query URLs', () => {
  const files = [
    identify({ url: '/x.pdf?sig=one#page=1' }, base),
    identify({ url: '/x.pdf?sig=one#page=2' }, base),
    identify({ url: '/x.pdf?sig=two' }, base)
  ];
  const merged = api.mergeFiles?.(files);
  assert.equal(merged?.length, 2);
  assert.equal(merged?.[0].url, 'https://school.example/x.pdf?sig=one');
  assert.equal(merged?.[1].url, 'https://school.example/x.pdf?sig=two');
  assert.equal(files[0]?.id, files[1]?.id);
  assert.notEqual(files[0]?.id, files[2]?.id);
});

async function page(html, url = base) {
  const { parseHTML } = await import('linkedom');
  const { document } = parseHTML(`<html><head><title>课程资料</title></head><body>${html}</body></html>`);
  Object.defineProperty(document, 'URL', { value: url });
  Object.defineProperty(document, 'baseURI', { value: url });
  return document;
}

test('scans links, download metadata, embedded documents and original iframe sources', async () => {
  const document = await page(`
    <a href="/one.pdf#page=2">First lecture</a>
    <a href="/one.pdf#page=3">duplicate</a>
    <a href="/bbcswebdav/xid-123_1" download="讲义.pptx">讲义</a>
    <a href="/opaque?id=2" data-filename="练习.docx">下载附件</a>
    <object data="/sheet.xlsx" type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></object>
    <embed src="/table.csv" type="text/csv">
    <iframe src="https://view.officeapps.live.com/op/embed.aspx?src=https%3A%2F%2Fschool.example%2Fslides.pptx%3Ftoken%3Dabc"></iframe>
    <a href="/course/next">Next folder</a>
  `);
  const scan = api.scanPage?.(document);
  assert.equal(scan?.title, '课程资料');
  assert.equal(scan?.pageUrl, base);
  assert.equal(typeof scan?.scannedAt, 'number');
  assert.deepEqual(Array.from(scan?.files ?? [], file => file.extension), ['pdf', 'pptx', 'docx', 'xlsx', 'csv', 'pptx']);
  assert.equal(scan.files[5].url, 'https://school.example/slides.pptx?token=abc');
});

test('display text and iframe titles cannot turn navigation or preview pages into files', async () => {
  const document = await page(`
    <a href="/next.html">Lecture.pptx</a>
    <a href="/webapps/blackboard/content/listContent.jsp?course_id=1" title="Lecture.pptx">课程</a>
    <iframe src="/preview/123" title="Lecture.pptx"></iframe>
    <a href="/opaque/download-one" download>Lecture.pptx</a>
    <a href="/opaque/download-two" data-filename="Notes.docx">附件</a>
    <a href="/next.html" data-download-url="/opaque/download-three">Sheet.xlsx</a>
    <object data="/opaque/123" type="application/pdf" title="Lecture"></object>
  `);
  const scan = api.scanPage(document);
  assert.deepEqual(Array.from(scan.files, file => file.url), [
    'https://school.example/opaque/download-one',
    'https://school.example/opaque/download-two',
    'https://school.example/opaque/download-three',
    'https://school.example/opaque/123'
  ]);
});

test('omits elements explicitly marked view-only or download-disabled', async () => {
  const document = await page(`
    <a href="/blocked.pdf" data-download-disabled="true">Blocked</a>
    <section data-view-only="true"><a href="/restricted.docx">Restricted</a></section>
    <a href="/only.pdf" aria-label="View only">Only view</a>
    <a href="/only-text.pdf">仅查看</a>
    <a href="/only-en.pdf">Lecture (View only)</a>
    <a href="/enabled.pdf" data-download-disabled="false">Allowed</a>
  `);
  const scan = api.scanPage?.(document);
  assert.deepEqual(Array.from(scan?.files ?? [], file => file.name), ['enabled.pdf']);
});

test('recurses through accessible same-origin frames and reports inaccessible frames', async () => {
  const document = await page('<iframe src="/embedded/"></iframe><iframe src="https://other.example/preview"></iframe>');
  const nested = await page('<a href="notes.doc">Notes</a><iframe src="/loop"></iframe>', 'https://school.example/embedded/');
  Object.defineProperty(document.querySelector('iframe'), 'contentDocument', { value: nested });
  Object.defineProperty(nested.querySelector('iframe'), 'contentDocument', { value: document });
  const scan = api.scanPage?.(document);
  assert.equal(scan?.files.length, 1);
  assert.equal(scan?.files[0].url, 'https://school.example/embedded/notes.doc');
  assert.ok(scan?.warnings.length >= 1);
});

test('a frame access error preserves results from the main document', async () => {
  const document = await page('<a href="/good.pdf">Good</a><iframe src="/restricted"></iframe>');
  Object.defineProperty(document.querySelector('iframe'), 'contentDocument', {
    get() { throw new Error('SecurityError'); }
  });
  const scan = api.scanPage?.(document);
  assert.equal(scan?.files[0].name, 'good.pdf');
  assert.equal(scan?.warnings.length, 1);
});

test('empty pages return an empty file list', async () => {
  const scan = api.scanPage?.(await page('<p>No attachments here</p>'));
  assert.deepEqual(Array.from(scan?.files ?? ['missing']), []);
  assert.deepEqual(Array.from(scan?.warnings ?? ['missing']), []);
});

test('classic injection returns the Scan as its last expression and supports reinjection', async () => {
  const document = await page('<a href="/lesson.pdf">Lesson</a>');
  const browser = vm.createContext({ document, URL, Date });
  vm.runInContext(policySource, browser);
  assert.equal(vm.runInContext(source, browser)?.files[0]?.name, 'lesson.pdf');
  assert.equal(vm.runInContext(source, browser)?.files.length, 1);
});

test('recognizes WAV, text and common coursework attachment formats', () => {
  for (const extension of ['wav', 'txt', 'zip', '7z', 'mp3', 'png', 'json', 'ipynb', 'py', 'mat']) {
    const file = identify({ url: `/files/reference.${extension}?token=keep` }, base);
    assert.equal(file?.extension, extension);
    assert.equal(file?.name, `reference.${extension}`);
    assert.ok(file?.url.endsWith('?token=keep'));
  }
  assert.equal(identify({ url: '/attachment/123', name: 'reference', mime: 'audio/x-wav' }, base)?.name, 'reference.wav');
  assert.equal(identify({ url: '/attachment/124', mime: 'text/plain; charset=utf-8' }, base)?.extension, 'txt');
});

test('uncommon extensions need explicit attachment evidence and cannot identify navigation', () => {
  assert.equal(identify({ url: '/bbcswebdav/xid-123_1', name: '实验.coursemodel' }, base)?.extension, 'coursemodel');
  assert.equal(identify({ url: '/opaque/123', name: '实验.coursemodel', trustedMetadata: true }, base)?.extension, 'coursemodel');
  assert.equal(identify({ url: '/download?filename=实验.coursemodel' }, base)?.extension, 'coursemodel');
  assert.equal(identify({ url: '/plain/实验.coursemodel' }, base), null);
  for (const url of ['/next.html', '/content.jsp', '/preview.aspx', '/course.action']) {
    assert.equal(identify({ url, name: 'reference.wav' }, base), null);
  }
});

test('scans assignment WAV and TXT links alongside PDF and keeps each original name', async () => {
  const document = await page(`
    <ul><li><a href="/bbcswebdav/xid-1" >reference.wav</a> (327.451 KB)</li>
    <li><a href="/files/assignment1.pdf">assignment1.pdf</a> (101.432 KB)</li>
    <li><a href="/bbcswebdav/xid-2">input.txt</a> (9.395 KB)</li>
    <li><a href="/files/output.txt">output.txt</a> (7.651 KB)</li></ul>
  `);
  assert.deepEqual(Array.from(api.scanPage(document).files, file => file.name), ['reference.wav', 'assignment1.pdf', 'input.txt', 'output.txt']);
});

test('generic text MIME cannot replace an explicit attachment extension', () => {
  for (const name of ['analysis.py', 'experiment.r', 'input.dat']) {
    const file = identify({ url: '/bbcswebdav/xid-123', name, mime: 'text/plain' }, base);
    assert.equal(file?.extension, name.split('.').pop());
    assert.equal(file?.name, name);
  }
  assert.equal(identify({ url: '/opaque/1', name: 'input.dat', mime: 'text/plain', trustedMetadata: true }, base)?.extension, 'dat');
});
