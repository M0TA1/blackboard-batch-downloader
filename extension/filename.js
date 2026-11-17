import './file-types.js';

const { isDownloadExtension } = globalThis.BBFileTypes;

export function safeFilename(file) {
  const extension = isDownloadExtension(file.extension?.toLowerCase()) ? file.extension.toLowerCase() : '';
  let name = String(file.name || '文件').normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')
    .replace(/^\.+/, '').replace(/[.\s]+$/, '').trim() || '文件';
  if (extension && !name.toLowerCase().endsWith(`.${extension}`)) name += `.${extension}`;
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  const suffix = extension ? name.slice(-extension.length - 1) : '';
  let stem = suffix ? name.slice(0, -suffix.length) : name;
  const encoder = new TextEncoder();
  while (encoder.encode(stem + suffix).length > 220) stem = Array.from(stem).slice(0, -1).join('');
  return `${stem}${suffix}`;
}
