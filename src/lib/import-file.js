// 小说文件解析（纯前端）：把 TXT / EPUB / DOCX / Markdown / HTML 统一提取成纯文本，
// 再走现有的 /api/projects/:id/analyze。服务端只收文本，格式解析不落库、不上传原文件。
//
// 编码：TXT 常见 UTF-8、GBK/GB18030（中文网文下载站）和带 BOM 的 UTF-16。
// 先按 BOM 判断，再严格试 UTF-8，失败后试 GB18030；都不行才按 UTF-8 替换解码。
// EPUB/DOCX 是 ZIP：只解出 OPF/NCX/XHTML 或 word/document.xml，不碰图片/字体。
import { unzipSync } from 'fflate';

export const NOVEL_FILE_ACCEPT = [
  '.txt', '.md', '.markdown', '.html', '.htm', '.epub', '.docx',
  'text/plain', 'text/markdown', 'text/html',
  'application/epub+zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
].join(',');

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const FORMAT_LABEL = { text: 'TXT', epub: 'EPUB', docx: 'DOCX', markdown: 'Markdown', html: 'HTML' };
const UNSUPPORTED_FORMATS = { pdf: 'PDF', mobi: 'MOBI', azw: 'AZW', azw3: 'AZW3', doc: 'DOC', rtf: 'RTF', djvu: 'DjVu' };
export const formatLabel = (format) => FORMAT_LABEL[format] || '文本';

const ZIP_MAGIC = (bytes) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
  && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06) || (bytes[2] === 0x07 && bytes[3] === 0x08));

const safeDecode = (value) => { try { return decodeURIComponent(value); } catch { return value; } };

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', times: '×', divide: '÷',
  deg: '°', plusmn: '±', laquo: '«', raquo: '»', sect: '§', para: '¶', dagger: '†',
};

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function guessUtf16(bytes) {
  const sample = bytes.subarray(0, Math.min(bytes.length, 400));
  if (sample.length < 8) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] !== 0) continue;
    if (index % 2 === 0) evenZeros += 1; else oddZeros += 1;
  }
  if (oddZeros > sample.length * 0.2 && evenZeros < sample.length * 0.05) return 'utf-16le';
  if (evenZeros > sample.length * 0.2 && oddZeros < sample.length * 0.05) return 'utf-16be';
  return null;
}

// BOM → UTF-16 无 BOM 的零字节特征 → 严格 UTF-8 → 严格 GB18030 → UTF-8 替换解码。
export function decodeTextBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const utf16 = guessUtf16(bytes);
  if (utf16) return new TextDecoder(utf16).decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* not UTF-8 */ }
  try { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); } catch { /* not GB18030 */ }
  return new TextDecoder('utf-8').decode(bytes);
}

export function parseAttributes(tag) {
  const attributes = {};
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(String(tag || '')))) attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? '');
  return attributes;
}

// XHTML / HTML → 纯文本：块级元素换行，去掉脚本、样式、导航和标签，解码实体。
export function htmlToText(html) {
  let text = String(html ?? '').replace(/\r\n?/g, '\n');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style|head|title|nav|svg|math|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  text = text.replace(/<(script|style|svg|math|iframe|object|embed)\b[^>]*\/?>/gi, '');
  text = text.replace(/<br\b[^>]*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section|article|figure|figcaption|pre|table|ul|ol|dd|dt|header|footer|main|aside)\s*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  return text
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function resolveHref(baseDir, href) {
  const clean = String(href || '').split('#')[0].split('?')[0].trim();
  if (!clean) return '';
  const decoded = safeDecode(clean);
  const path = decoded.startsWith('/') ? decoded.slice(1) : `${baseDir}${decoded}`;
  const parts = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop(); else parts.push(segment);
  }
  return parts.join('/');
}

function zipGet(files, path) {
  if (!path) return null;
  for (const candidate of [path, safeDecode(path)]) if (files[candidate]) return files[candidate];
  const target = safeDecode(path).replace(/^\/+/, '').toLowerCase();
  const key = Object.keys(files).find((name) => safeDecode(name).replace(/^\/+/, '').toLowerCase() === target);
  return key ? files[key] : null;
}

function unzipTextFiles(bytes, filter) {
  try {
    return unzipSync(bytes, { filter });
  } catch (error) {
    throw new Error(`压缩包无法读取：${error.message || '不是有效的 EPUB / DOCX'}`);
  }
}

function firstHeadingText(html) {
  const match = String(html || '').match(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/i);
  return match ? htmlToText(match[2]).replace(/\s+/g, ' ').trim() : '';
}

const TOC_TITLE = /^(?:contents|table of contents|目录|目錄|目次|总目录|總目錄)$/i;

// 版权页 / CIP 数据：epub 每个分卷末尾常带一页，正文很短、全是出版信息。
// 只在短文本里判断，避免把正文里提到“版权/ISBN”的章节误删。
const COPYRIGHT_STRONG = /^(?:图书在版编目|CIP数据|版权信息|版权所有|Copyright\b|All rights reserved|ISBN\b)/i;
const COPYRIGHT_MARKERS = /(?:图书在版编目|CIP数据|版权|ISBN|出版发行|责任编辑|印[次刷]|开本|定价|出版社|Copyright|All rights reserved)/gi;

export function isCopyrightPage(text) {
  const value = String(text || '').trim();
  if (!value || value.length > 2_000) return false;
  if (COPYRIGHT_STRONG.test(value)) return true;
  const lines = value.split('\n').filter(Boolean);
  return lines.length <= 30 && (value.match(COPYRIGHT_MARKERS) || []).length >= 3;
}

// EPUB 的目录页不一定带 properties="nav"（很多转换工具只把它放在 spine 里）。
// 判据：<title>/标题直接叫 Contents/目录，或者一页里链接特别多、正文几乎都是
// 短标题行而不是成段散文。正常章节通常 0–2 个链接，不会命中。
export function isTocLikePage(html, text) {
  const titleMatch = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const documentTitle = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : '';
  if (TOC_TITLE.test(documentTitle) || TOC_TITLE.test(firstHeadingText(html))) return true;
  const anchors = (String(html || '').match(/<a\b[^>]*\bhref\s*=/gi) || []).length;
  if (!anchors) return false;
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  const longLines = lines.filter((line) => line.length > 30).length;
  // 链接多、行数不多、几乎没有长句 → 目录页。
  if (anchors >= 5 && lines.length <= anchors * 3 && longLines <= Math.max(2, Math.floor(lines.length * 0.1))) return true;
  return /^(?:contents|table of contents|目录|目錄|目次|总目录|總目錄)$/i.test(lines[0]) && lines.length >= 3;
}

function readToc(files, manifest, opfDir) {
  const toc = new Map();
  const navItem = [...manifest.values()].find((item) => /\bnav\b/.test(item.properties));
  if (navItem) {
    const navBytes = zipGet(files, resolveHref(opfDir, navItem.href));
    if (navBytes) {
      const navHtml = decodeTextBytes(navBytes);
      for (const match of navHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        const attributes = parseAttributes(match[1]);
        if (!attributes.href) continue;
        const title = htmlToText(match[2]).replace(/\s+/g, ' ').trim();
        if (title) toc.set(resolveHref(opfDir, attributes.href), title);
      }
    }
  }
  const ncxItem = [...manifest.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml');
  if (ncxItem) {
    const ncxBytes = zipGet(files, resolveHref(opfDir, ncxItem.href));
    if (ncxBytes) {
      const ncx = decodeTextBytes(ncxBytes);
      const pattern = /<navPoint\b[^>]*>[\s\S]*?<text[^>]*>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
      for (const match of ncx.matchAll(pattern)) {
        const title = htmlToText(match[1]).replace(/\s+/g, ' ').trim();
        if (title) toc.set(resolveHref(opfDir, match[2] ?? match[3]), title);
      }
    }
  }
  return toc;
}

// EPUB：container.xml → OPF manifest/spine → 按 spine 顺序拼接 XHTML 正文。
// 返回 { text, title }，title 来自 OPF 的 dc:title（可能为空）。
export function extractEpub(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const files = unzipTextFiles(input, (file) => !file.name.endsWith('/') && (file.name.startsWith('META-INF/') || /\.(opf|xhtml|html|htm|ncx|xml)$/i.test(file.name)));
  const containerBytes = zipGet(files, 'META-INF/container.xml');
  if (!containerBytes) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml');
  const container = decodeTextBytes(containerBytes);
  const rootPath = container.match(/<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!rootPath) throw new Error('不是有效的 EPUB：container.xml 里没有 rootfile');
  const opfPath = safeDecode(rootPath);
  const opfBytes = zipGet(files, opfPath);
  if (!opfBytes) throw new Error('EPUB 的 OPF 文件缺失');
  const opf = decodeTextBytes(opfBytes);
  const opfDir = opfPath.includes('/') ? `${opfPath.slice(0, opfPath.lastIndexOf('/') + 1)}` : '';

  const manifest = new Map();
  for (const match of opf.matchAll(/<item\b[^>]*\/?>/gi)) {
    const attributes = parseAttributes(match[0]);
    if (attributes.id && attributes.href) {
      manifest.set(attributes.id, {
        href: attributes.href,
        mediaType: String(attributes['media-type'] || '').toLowerCase(),
        properties: String(attributes.properties || '').toLowerCase(),
      });
    }
  }
  const spineBlock = opf.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i)?.[1] || '';
  const itemrefs = [...spineBlock.matchAll(/<itemref\b[^>]*\/?>/gi)].map((match) => parseAttributes(match[0])).filter((attributes) => attributes.idref);
  if (!itemrefs.length) throw new Error('EPUB 的 spine 是空的，读不到章节');

  const toc = readToc(files, manifest, opfDir);
  const chapters = [];
  const seen = new Set();
  let currentVolume = '';
  for (const itemref of itemrefs) {
    const item = manifest.get(itemref.idref);
    if (!item || !/xhtml|html/.test(item.mediaType) || /\bnav\b/.test(item.properties)) continue;
    const path = resolveHref(opfDir, item.href);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    // 常见的封面/版权/目录文件名直接跳过；text00000.html 这类通用命名靠内容判断。
    const filename = path.split('/').pop().toLowerCase();
    if (/^(?:cover|titlepage|title-page|copyright|colophon|dedication|acknowledg|about|contents|toc|nav)[._-]/i.test(filename)) continue;
    const chapterBytes = zipGet(files, path);
    if (!chapterBytes) continue;
    const html = decodeTextBytes(chapterBytes);
    const body = htmlToText(html);
    if (!body) continue;
    const tocPage = isTocLikePage(html, body);
    if (tocPage || isCopyrightPage(body)) {
      // 分卷目录页的标题就是卷名（如“剑来1：少年起微末”），记下来给后面的章节加前缀，
      // 避免整本书里每一卷都出现一次“第一章”。
      if (tocPage) {
        const volume = firstHeadingText(html).replace(/\s+/g, ' ').trim();
        if (volume && !TOC_TITLE.test(volume)) currentVolume = volume.slice(0, 80);
      }
      continue;
    }
    const heading = toc.get(path) || firstHeadingText(html);
    const title = heading || `第 ${chapters.length + 1} 章`;
    const displayTitle = currentVolume && !title.startsWith(currentVolume) ? `${currentVolume} · ${title}` : title;
    const text = heading && !body.startsWith(heading) ? `${heading}\n${body}` : body;
    chapters.push({ title: displayTitle, text, charCount: text.length });
  }
  if (!chapters.length) throw new Error('EPUB 里没有读到正文（可能只有图片或排版文件）');
  const bookTitle = opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1];
  return { text: chapters.map((chapter) => chapter.text).join('\n\n'), title: bookTitle ? htmlToText(bookTitle).trim() : '', chapters };
}

// DOCX：word/document.xml 里的每个 w:p 一行；w:tab / w:br 保留成空格 / 换行。
export function extractDocx(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const files = unzipTextFiles(input, (file) => file.name === 'word/document.xml');
  const documentBytes = files['word/document.xml'];
  if (!documentBytes) throw new Error('不是有效的 DOCX：缺少 word/document.xml');
  const xml = decodeTextBytes(documentBytes);
  const body = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/i)?.[1] ?? xml;
  const paragraphs = body.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gi) || [];
  const lines = paragraphs.map((paragraph) => {
    const withoutFields = paragraph.replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/gi, '');
    return decodeEntities(withoutFields
      .replace(/<w:(tab|ptab)\b[^>]*\/?>/gi, ' ')
      .replace(/<w:(br|cr)\b[^>]*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''))
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .trim();
  }).filter(Boolean);
  if (!lines.length) throw new Error('DOCX 里没有读到正文');
  return lines.join('\n');
}

export function markdownToText(markdown) {
  let text = String(markdown ?? '').replace(/\r\n?/g, '\n');
  text = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/^#{1,6}\s*/gm, '');
  text = text.replace(/^>\s?/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/<\/?[A-Za-z][^>]*>/g, '');
  text = text.replace(/[*_~`]/g, '');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// 章节标题：中文常见“第 X 章/节/卷/回/幕/集/部/篇/话”和序章、楔子、番外；
// 英文 Chapter N / Chapter IV。只认短行（≤40 字），避免把以“第一章”开头的
// 正文段落误判成标题。
const CHAPTER_HEADING = /^(?:(?:正文|VIP章节|VIP)?\s*第[0-9零一二三四五六七八九十百千万亿两]+[章节卷回幕集部篇话]|(?:序章|楔子|引子|序言|前言|尾声|终章|后记)(?:[\s:：、.．—-]|$)|番外(?:篇)?(?:[\s:：、.．—-]|$|\d|[一二三四五六七八九十])|chapter\s+(?:\d+|[ivxlcdm]+|[一二三四五六七八九十百千]+))/i;

export function isChapterHeading(line) {
  const value = String(line || '').trim();
  return value.length > 0 && value.length <= 40 && CHAPTER_HEADING.test(value);
}

function splitIntoParts(text, maxChars) {
  const parts = [];
  let current = '';
  for (const paragraph of String(text).split('\n')) {
    if (paragraph.length > maxChars) {
      if (current.trim()) { parts.push(current); current = ''; }
      for (let index = 0; index < paragraph.length; index += maxChars) parts.push(paragraph.slice(index, index + maxChars));
      continue;
    }
    const candidate = current ? `${current}\n${paragraph}` : paragraph;
    if (candidate.length > maxChars && current) { parts.push(current); current = paragraph; }
    else current = candidate;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part, index) => ({ title: `第 ${index + 1} 部分`, text: part.trim(), charCount: part.trim().length })).filter(keepChapter);
}

const TEXT_TOC_MARKER = /^(?:目录|目錄|contents|table of contents|总目录|總目錄|目次)$/i;

// 目录块/空章节：TXT 自带目录时，目录标题行会生成只有标题、没有正文的章节；
// 以“目录/Contents”开头且后面全是短行的章节也整章丢掉。
function isTextTocChapter(chapter) {
  const lines = String(chapter?.text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length || !TEXT_TOC_MARKER.test(lines[0])) return false;
  return lines.slice(1).every((line) => line.length <= 40);
}

function isHeadingOnlyChapter(chapter) {
  const lines = String(chapter?.text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length <= 1 && lines[0] === String(chapter?.title || '').trim();
}

function keepChapter(chapter) {
  return !isCopyrightPage(chapter.text) && !isTextTocChapter(chapter) && !isHeadingOnlyChapter(chapter);
}

// 把整本小说按章节标题切开，返回 [{ title, text, charCount }]。
// 没有标题时：短文件整本一章；长文件按段落 / 固定长度切成“第 N 部分”，
// 保证整本书也能逐段导入，不会因为单章 200 万字符上限被整体拒收。
export function splitChapters(text, { maxPartChars = 20_000 } = {}) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!normalized.trim()) return [];
  const lines = normalized.split('\n');
  const chapters = [];
  let current = null;
  let headingFound = false;
  const push = () => {
    if (!current) return;
    const body = current.lines.join('\n').trim();
    if (body) chapters.push({ title: current.title, text: body, charCount: body.length });
    current = null;
  };
  for (const line of lines) {
    if (isChapterHeading(line)) {
      push();
      headingFound = true;
      current = { title: line.trim(), lines: [line] };
    } else {
      if (!current) current = { title: '', lines: [] };
      current.lines.push(line);
    }
  }
  push();
  if (!headingFound && chapters.length === 1 && chapters[0].charCount <= maxPartChars) {
    chapters[0].title = '全文';
    return chapters.filter(keepChapter);
  }
  if (!headingFound) return splitIntoParts(chapters.map((chapter) => chapter.text).join('\n'), maxPartChars);
  for (const chapter of chapters) if (!chapter.title) chapter.title = '开篇';
  return chapters.filter(keepChapter);
}

const normalizedText = (text) => String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');

// 统一入口：按扩展名 + ZIP magic 判断格式，返回 { format, text, title? }。
export async function extractNovelFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('没有拿到文件');
  if (Number(file.size) > MAX_FILE_BYTES) throw new Error(`文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB，请先拆分`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = String(file.name || '');
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (UNSUPPORTED_FORMATS[extension]) throw new Error(`暂不支持 ${UNSUPPORTED_FORMATS[extension]}，请先转换成 TXT / EPUB / DOCX 再导入`);

  if (ZIP_MAGIC(bytes)) {
    let probe;
    try {
      probe = unzipSync(bytes, { filter: (entry) => entry.name === 'META-INF/container.xml' || entry.name === 'word/document.xml' });
    } catch (error) {
      throw new Error(`压缩包无法读取：${error.message || '文件可能已损坏'}`);
    }
    if (extension === 'docx' || probe['word/document.xml']) {
      const text = extractDocx(bytes);
      return { format: 'docx', text, chapters: splitChapters(text) };
    }
    if (extension === 'epub' || probe['META-INF/container.xml']) {
      const { text, title, chapters } = extractEpub(bytes);
      return { format: 'epub', text, title, chapters };
    }
    throw new Error('不支持这种压缩格式：目前支持 .epub 和 .docx');
  }

  const decoded = decodeTextBytes(bytes);
  const asText = (format, text) => ({ format, text, chapters: splitChapters(text) });
  if (extension === 'html' || extension === 'htm') return asText('html', htmlToText(decoded));
  if (extension === 'md' || extension === 'markdown') return asText('markdown', markdownToText(decoded));
  if (!extension || ['txt', 'text'].includes(extension)) return asText('text', normalizedText(decoded));
  if (decoded.includes('\u0000')) throw new Error('无法识别这个文件格式：支持 TXT / EPUB / DOCX / Markdown / HTML');
  return asText('text', normalizedText(decoded));
}
