const TYPES = {
  pdf: new Set(['pdf']),
  presentation: new Set(['ppt', 'pptx']),
  document: new Set(['doc', 'docx']),
  spreadsheet: new Set(['xls', 'xlsx', 'csv']),
};

export function fileCategory(extension) {
  const normalized = String(extension || '').toLowerCase();
  return Object.keys(TYPES).find(type => TYPES[type].has(normalized)) || 'other';
}

export function samePage(first, second) {
  if (!first || !second) return false;
  try {
    new URL(first);
    new URL(second);
    return first === second;
  } catch {
    return false;
  }
}

export function filterFiles(files, query = '', type = 'all') {
  const search = query.trim().toLocaleLowerCase();
  return files.filter(file =>
    (!search || file.name.toLocaleLowerCase().includes(search)) &&
    (type === 'all' || fileCategory(file.extension) === type)
  );
}

export function setVisibleSelection(selected, visible, checked) {
  const next = new Set(selected);
  for (const file of visible) {
    if (checked) next.add(file.id);
    else next.delete(file.id);
  }
  return next;
}

export function validSelection(files, savedIds) {
  const available = new Set(files.map(file => file.id));
  return new Set((Array.isArray(savedIds) ? savedIds : []).filter(id => available.has(id)));
}

export function isBatchActive(batch) {
  return Boolean(batch?.jobs?.some(job => ['queued', 'starting', 'in_progress'].includes(job.status)));
}
