/* Injected as a classic script. The IIFE's value is returned by executeScript. */
(() => {
  'use strict';

  const { extensionOf, mimeExtensions, officeExtensions } = globalThis.BBFileTypes;

  const text = value => typeof value === 'string' ? value.trim() : '';
  const decode = value => {
    try { return decodeURIComponent(value); } catch { return value; }
  };

  function httpUrl(value, baseUrl) {
    if (!text(value) || text(value).startsWith('#')) return null;
    try {
      const url = new URL(value, baseUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      url.hash = '';
      return url;
    } catch { return null; }
  }

  function identifyFile(candidate, baseUrl) {
    if (!candidate || typeof candidate !== 'object') return null;
    let url = httpUrl(candidate.url, baseUrl);
    if (!url) return null;
    let explicitOriginal = false;
    // Only this known viewer has a documented original-file src parameter.
    if (url.hostname === 'view.officeapps.live.com' && /^\/op\/(?:embed|view)\.aspx$/i.test(url.pathname)) {
      url = httpUrl(url.searchParams.get('src'));
      if (!url) return null;
      explicitOriginal = true;
    }
    const attachmentPath = /(?:^|\/)(?:bbcswebdav|xythoswfs|attachments?|download(?:file)?)(?:\/|\.|$)/i.test(url.pathname)
      && !/(?:^|\/)preview(?:\/|\.|$)/i.test(url.pathname);
    const nameIsEvidence = candidate.trustedMetadata === true || explicitOriginal || attachmentPath;
    const pathName = decode(url.pathname.split('/').pop() || '');
    let queryName = '';
    for (const [key, value] of url.searchParams) {
      if (/^(filename|file_name|downloadfilename)$/i.test(key) && extensionOf(value, true)) {
        queryName = value;
        break;
      }
    }
    const suppliedName = text(candidate.name);
    const namedExtension = extensionOf(suppliedName, true);
    const pathExtension = extensionOf(pathName, nameIsEvidence);
    const queryExtension = extensionOf(queryName, true);
    const mimeExtension = mimeExtensions[text(candidate.mime).toLowerCase().split(';')[0].trim()] || '';
    // A converted PDF must never masquerade as an original Office attachment.
    const officeName = [namedExtension, queryExtension].some(extension => officeExtensions.has(extension));
    if ((pathExtension === 'pdf' || mimeExtension === 'pdf') && officeName) return null;
    const extension = pathExtension || queryExtension || (nameIsEvidence ? namedExtension : '') || mimeExtension;
    if (!extension) return null;
    let name = queryName || (namedExtension ? suppliedName : '') || (pathExtension ? pathName : '') || suppliedName || pathName || '附件';
    if (!extensionOf(name, true)) name += `.${extension}`;
    return {
      id: `file:${url.href}`,
      url: url.href,
      name,
      extension,
      source: text(candidate.source) || '页面链接'
    };
  }

  function mergeFiles(files) {
    const seen = new Set();
    const merged = [];
    for (const file of files || []) {
      if (!file) continue;
      const url = httpUrl(file.url);
      if (!url || seen.has(url.href)) continue;
      seen.add(url.href);
      merged.push({ ...file, id: `file:${url.href}`, url: url.href });
    }
    return merged;
  }

  function downloadRestricted(element) {
    const restrictedLabel = /\bview[ -]only\b|\bdownloads?\s+(?:disabled|not allowed)\b|仅(?:供)?查看|禁止下载|不允许下载/i;
    if (restrictedLabel.test(text(element.textContent))) return true;
    for (let node = element; node?.getAttribute; node = node.parentElement) {
      const enabled = attribute => /^(true|1|yes)$/i.test(text(node.getAttribute(attribute)));
      const disabled = attribute => /^(false|0|no)$/i.test(text(node.getAttribute(attribute)));
      if (['data-download-disabled', 'data-view-only', 'aria-disabled'].some(enabled)) return true;
      if (['data-allow-download', 'data-download-enabled', 'data-can-download'].some(disabled)) return true;
      if (/(?:^|\s)(?:view-only|download-disabled|no-download)(?:\s|$)/i.test(node.getAttribute('class') || '')) return true;
      const label = `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`;
      if (restrictedLabel.test(label)) return true;
    }
    return false;
  }

  function scanPage(document) {
    if (!document?.querySelectorAll) throw new TypeError('无法读取当前页面。');
    const files = [];
    const warnings = new Set();
    const visited = new Set();
    const pageUrl = text(document.URL) || text(document.baseURI);

    function visit(doc, inheritedUrl, nested = false) {
      if (visited.has(doc)) return;
      visited.add(doc);
      const docUrl = httpUrl(doc.URL, inheritedUrl) || httpUrl(inheritedUrl);
      const baseUrl = text(doc.baseURI) || docUrl?.href || inheritedUrl;
      const source = nested ? `内嵌页面：${text(doc.title) || docUrl?.pathname || ''}` : '当前页面';
      const add = candidate => {
        const file = identifyFile({ ...candidate, source }, baseUrl);
        if (file) files.push(file);
      };
      for (const element of doc.querySelectorAll('a[href], area[href], object[data], embed[src], iframe, [data-download-url]')) {
        if (downloadRestricted(element)) continue;
        const tag = element.tagName.toLowerCase();
        const original = element.getAttribute('data-download-url');
        const rawUrl = original || element.getAttribute(tag === 'object' ? 'data' : ['a', 'area'].includes(tag) ? 'href' : 'src');
        const metadataName = ['download', 'data-filename', 'data-file-name', 'data-original-filename'].map(attribute => text(element.getAttribute(attribute))).find(Boolean);
        const name = metadataName || text(element.getAttribute('title')) || text(element.textContent);
        const mime = element.getAttribute('type') || element.getAttribute('data-mime-type') || element.getAttribute('data-content-type');
        const trustedMetadata = Boolean(original || metadataName || element.hasAttribute('download'));
        add({ url: rawUrl, name, mime, trustedMetadata });
        if (tag !== 'iframe') continue;
        const frameUrl = httpUrl(element.getAttribute('src'), baseUrl);
        if (frameUrl && docUrl && frameUrl.origin !== docUrl.origin) {
          warnings.add(`部分内嵌内容位于其他站点，无法读取：${frameUrl.origin}`);
          continue;
        }
        try {
          const child = element.contentDocument;
          if (child?.querySelectorAll) visit(child, frameUrl?.href || docUrl?.href || baseUrl, true);
          else warnings.add('部分内嵌内容尚未加载或无法访问，扫描结果可能不完整。');
        } catch {
          warnings.add('部分内嵌内容无法访问，扫描结果可能不完整。');
        }
      }
    }

    visit(document, pageUrl);
    return {
      files: mergeFiles(files),
      title: text(document.title),
      pageUrl,
      warnings: [...warnings],
      scannedAt: Date.now()
    };
  }

  globalThis.BBScanner = { scanPage, identifyFile, mergeFiles };
  return typeof document === 'undefined' ? undefined : scanPage(document);
})();
