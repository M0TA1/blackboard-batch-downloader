/* Shared by classic page injection and extension modules. No remote code or dependencies. */
(() => {
  const common = new Set(('pdf ppt pptx doc docx xls xlsx csv txt md markdown rtf ' +
    'wav mp3 m4a aac flac ogg aif aiff mp4 webm mov avi mkv ' +
    'zip rar 7z tar gz bz2 xz png jpg jpeg gif webp bmp tif tiff svg ' +
    'json xml yaml yml log ipynb py r m mat c cpp h hpp java js ts sql tex bib ' +
    'sav sps sas dta rds rdata epub odt ods odp stl obj').split(' '));
  const navigation = new Set('html htm xhtml php phtml asp aspx jsp jspx cgi do action ashx axd'.split(' '));
  const officeExtensions = new Set('ppt pptx doc docx xls xlsx pptm pot potx potm pps ppsx ppsm docm dot dotx dotm xlsm xlsb xlt xltx xltm'.split(' '));
  function isDownloadExtension(extension) {
    return typeof extension === 'string' && /^[a-z0-9]{1,16}$/.test(extension)
      && /[a-z]/.test(extension) && !navigation.has(extension);
  }
  function extensionOf(value, allowUncommon = false) {
    const extension = typeof value === 'string' ? value.trim().match(/\.([a-z0-9]{1,16})$/i)?.[1].toLowerCase() : '';
    return extension && isDownloadExtension(extension) && (allowUncommon || common.has(extension)) ? extension : '';
  }
  const mimeExtensions = {
    'application/pdf': 'pdf',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/csv': 'csv', 'application/csv': 'csv', 'text/plain': 'txt', 'text/markdown': 'md',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
    'audio/mpeg': 'mp3', 'audio/flac': 'flac', 'audio/ogg': 'ogg',
    'video/mp4': 'mp4', 'video/webm': 'webm',
    'application/zip': 'zip', 'application/x-zip-compressed': 'zip',
    'application/x-7z-compressed': '7z', 'application/vnd.rar': 'rar', 'application/x-rar-compressed': 'rar',
    'application/gzip': 'gz', 'application/x-tar': 'tar',
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'application/json': 'json', 'application/xml': 'xml', 'text/xml': 'xml',
  };
  globalThis.BBFileTypes = Object.freeze({ extensionOf, isDownloadExtension, officeExtensions, mimeExtensions });
})();
