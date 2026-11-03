import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { decodeTextBytes, extractDocx, extractEpub, extractNovelFile, htmlToText, isCopyrightPage, isTocLikePage, markdownToText, splitChapters } from './import-file.js';

const bytesOf = (text, encoding = 'utf8') => new Uint8Array(Buffer.from(text, encoding));
const fakeFile = (name, bytes) => ({
  name,
  size: bytes.length,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

const EPUB_FILES = {
  'META-INF/container.xml': strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
  'OEBPS/content.opf': strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试小说</dc:title></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="tocpage" href="toc-page.xhtml" media-type="application/xhtml+xml"/>
    <item id="volume" href="volume.xhtml" media-type="application/xhtml+xml"/>
    <item id="copyright" href="copyright.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="tocpage"/><itemref idref="volume"/><itemref idref="ch1"/><itemref idref="ch2"/><itemref idref="copyright"/></spine>
</package>`),
  'OEBPS/toc-page.xhtml': strToU8(`<html><head><title>Contents</title></head><body>
    <h1>目录</h1>
    <a href="text/ch1.xhtml">第一章 山门</a><a href="text/ch1.xhtml">第二章 夜雨</a>
    <a href="text/ch1.xhtml">第三章</a><a href="text/ch1.xhtml">第四章</a><a href="text/ch1.xhtml">第五章</a>
  </body></html>`),
  'OEBPS/volume.xhtml': strToU8(`<html><head><title></title></head><body>
    <h1>第一卷</h1>
    <a href="text/ch1.xhtml">第一章 山门</a><a href="text/ch1.xhtml">第二章 夜雨</a>
    <a href="text/ch1.xhtml">第三章</a><a href="text/ch1.xhtml">第四章</a><a href="text/ch1.xhtml">第五章</a>
  </body></html>`),
  'OEBPS/copyright.xhtml': strToU8(`<html><body>
    <p>图书在版编目(CIP)数据</p><p>测试小说 / 某某著</p><p>ISBN 978-7-000-00000-0</p><p>定价：39.00 元</p>
  </body></html>`),
  'OEBPS/nav.xhtml': strToU8(`<html><body><nav epub:type="toc"><ol>
    <li><a href="text/ch1.xhtml">第一章 山门</a></li>
    <li><a href="text/ch2.xhtml#top">第二章 夜雨</a></li>
  </ol></nav></body></html>`),
  'OEBPS/text/ch1.xhtml': strToU8(`<html><body>
    <h1>第一章 山门</h1>
    <p>山门在雾里。</p>
    <p>「走吧。」唐僧说。</p>
    <script>alert('不应该出现')</script>
  </body></html>`),
  'OEBPS/text/ch2.xhtml': strToU8(`<html><body>
    <h1>第二章 夜雨</h1>
    <p>雨下了一夜 &amp; 没有停。</p>
  </body></html>`),
};

test('decodeTextBytes：UTF-8 / BOM / UTF-16 / GBK', () => {
  assert.equal(decodeTextBytes(bytesOf('你好')), '你好');
  assert.equal(decodeTextBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf('你好')])), '你好');
  assert.equal(decodeTextBytes(new Uint8Array([0xff, 0xfe, ...bytesOf('你好', 'utf16le')])), '你好');
  assert.equal(decodeTextBytes(new Uint8Array([0xfe, 0xff, 0x4f, 0x60, 0x59, 0x7d])), '你好');
  assert.equal(decodeTextBytes(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3])), '你好');
});

test('htmlToText：块级元素换行、实体解码、脚本/导航移除', () => {
  const text = htmlToText('<div><h1>标题</h1><p>第一段 &amp; 第二句</p><script>坏东西()</script><nav>目录</nav><p>尾段&nbsp;结束</p></div>');
  assert.equal(text, '标题\n第一段 & 第二句\n尾段 结束');
});

test('extractEpub：按 spine 顺序、目录标题补章节名、跳过 nav、解码实体', () => {
  const epub = zipSync(EPUB_FILES);
  const result = extractEpub(epub);
  assert.equal(result.title, '测试小说');
  assert.match(result.text, /第一章 山门\n山门在雾里。/);
  assert.match(result.text, /「走吧。」唐僧说。/);
  assert.match(result.text, /第二章 夜雨\n雨下了一夜 & 没有停。/);
  assert.ok(result.text.indexOf('第一章 山门') < result.text.indexOf('第二章 夜雨'));
  assert.equal(result.text.match(/第一章 山门/g).length, 1, '标题不应重复');
  assert.ok(!result.text.includes('不应该出现'));
  assert.ok(!result.text.includes('目录'));
  assert.deepEqual(result.chapters.map((chapter) => chapter.title), ['第一卷 · 第一章 山门', '第一卷 · 第二章 夜雨']);
  assert.match(result.chapters[0].text, /^第一章 山门\n山门在雾里。/);
});

test('splitChapters：按章节标题切分，保留开篇', () => {
  const chapters = splitChapters('前言一句。\n\n第一章 山门\n山门在雾里。\n\n第二章 夜雨\n雨下了一夜。');
  assert.deepEqual(chapters.map((chapter) => chapter.title), ['开篇', '第一章 山门', '第二章 夜雨']);
  assert.match(chapters[1].text, /^第一章 山门\n山门在雾里。/);
});

test('splitChapters：无标题长文按部分切分，超长单行也会硬切', () => {
  const text = Array.from({ length: 30 }, (_, index) => `第${index}段。`).join('\n');
  const chapters = splitChapters(text, { maxPartChars: 40 });
  assert.ok(chapters.length > 1);
  assert.ok(chapters.every((chapter) => chapter.charCount <= 40));
  assert.equal(chapters[0].title, '第 1 部分');
});

test('splitChapters：超过 40 字的长行不误判为章节标题', () => {
  const longLine = '第一章' + '啊'.repeat(40);
  const chapters = splitChapters(`${longLine}\n正文`);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, '全文');
});

test('extractDocx：每个段落一行，保留 tab/换行并解码实体', () => {
  const docx = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'word/document.xml': strToU8(`<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:t xml:space="preserve"> &amp; 结尾</w:t></w:r></w:p>
  <w:p><w:r><w:t>第二段</w:t><w:br/><w:t>换行后</w:t></w:r></w:p>
</w:body></w:document>`),
  });
  assert.equal(extractDocx(docx), '第一段 & 结尾\n第二段\n换行后');
});

test('markdownToText：去掉标题井号、链接、图片和强调标记', () => {
  assert.equal(
    markdownToText('# 第一章\n\n这是**正文**，见[链接](https://example.com)。\n![图](cover.png)\n> 引用'),
    '第一章\n\n这是正文，见链接。\n\n引用',
  );
});

test('extractNovelFile：按扩展名/编码选择解析器', async () => {
  const txt = await extractNovelFile(fakeFile('novel.txt', new Uint8Array([0xc4, 0xe3, 0xba, 0xc3])));
  assert.deepEqual({ format: txt.format, text: txt.text }, { format: 'text', text: '你好' });

  const epub = await extractNovelFile(fakeFile('book.epub', zipSync(EPUB_FILES)));
  assert.equal(epub.format, 'epub');
  assert.equal(epub.title, '测试小说');
  assert.equal(epub.chapters.length, 2);
  assert.match(epub.text, /第二章 夜雨/);

  const html = await extractNovelFile(fakeFile('book.html', bytesOf('<p>一段</p><p>两段</p>')));
  assert.deepEqual({ format: html.format, text: html.text }, { format: 'html', text: '一段\n两段' });

  const markdown = await extractNovelFile(fakeFile('book.md', bytesOf('## 标题\n\n正文')));
  assert.deepEqual({ format: markdown.format, text: markdown.text }, { format: 'markdown', text: '标题\n\n正文' });
});

test('extractNovelFile：不支持的压缩格式、电子书格式和超大文件给出明确错误', async () => {
  await assert.rejects(
    () => extractNovelFile(fakeFile('book.zip', zipSync({ 'readme.txt': strToU8('x') }))),
    /不支持这种压缩格式/,
  );
  await assert.rejects(
    () => extractNovelFile(fakeFile('book.pdf', bytesOf('%PDF-1.7'))),
    /暂不支持 PDF/,
  );
  await assert.rejects(
    () => extractNovelFile({ name: 'huge.txt', size: 101 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) }),
    /超过 100MB/,
  );
});

test('isTocLikePage：Contents/目录标记和“大量链接 + 短行”都识别为目录', () => {
  assert.equal(isTocLikePage('<html><head><title>Contents</title></head><body><h1>目录</h1><p>第一章</p></body></html>', '目录\n第一章'), true);
  const links = Array.from({ length: 5 }, (_, index) => `<a href="c${index}.xhtml">第${index + 1}章</a>`).join('');
  assert.equal(isTocLikePage(`<html><body><h1>第一卷</h1>${links}</body></html>`, '第一卷\n第一章\n第二章\n第三章\n第四章\n第五章'), true);
  assert.equal(isTocLikePage(`<html><body><h1>第一章</h1><p>${'正文'.repeat(100)}</p></body></html>`, `第一章\n${'正文'.repeat(100)}`), false);
});

test('isCopyrightPage：短版权页 / CIP 页跳过，正常长正文不误判', () => {
  assert.equal(isCopyrightPage('图书在版编目(CIP)数据\n测试小说 / 某某著\nISBN 978-7-000-00000-0\n定价：39.00 元'), true);
  assert.equal(isCopyrightPage(`第一章\n${'正文'.repeat(1_000)}`), false);
});

test('splitChapters：丢弃 TXT 开头目录和只有标题的空章节', () => {
  const text = '目录\n第一章 山门\n第二章 夜雨\n\n第一章 山门\n山门在雾里。\n第二章 夜雨\n雨下了一夜。';
  const chapters = splitChapters(text);
  assert.deepEqual(chapters.map((chapter) => chapter.title), ['第一章 山门', '第二章 夜雨']);
  assert.match(chapters[0].text, /山门在雾里/);
  assert.match(chapters[1].text, /雨下了一夜/);
});
