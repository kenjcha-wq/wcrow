#!/usr/bin/env node
/**
 * 乌鸦与井 — 内容层构建脚本（零依赖）
 *
 * 两种模式：
 *   node scripts/build-content.mjs            读取 content/**\/*.md → 生成 content-index.json
 *   node scripts/build-content.mjs --migrate  从 index.html 的 STATIC_WORKS 迁移出 .md（首次/重建用）
 *
 * 说明：
 *   - Markdown 的 frontmatter 采用「JSON 兼容的 YAML 子集」写回，任何 YAML 解析器都能读；
 *     读取时同时兼容 Decap CMS 写出的朴素标量、块状列表。
 *   - 正文（frontmatter 之后的内容）原样作为 content 写入索引，不做任何字符串改写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = path.join(ROOT, 'content');
const INDEX_FILE = path.join(ROOT, 'content-index.json');

/** 目录 → 默认作品类型（index.html 中的 CATEGORIES key） */
const COLLECTIONS = {
  long: { dir: 'content/long', type: 'novel-long', label: '长篇' },
  short: { dir: 'content/short', type: 'novel-short', label: '短篇' },
  series: { dir: 'content/series', type: 'series', label: '系列日志' }
};

const FIELD_ORDER = ['title', 'slug', 'type', 'series', 'orderInSeries', 'date',
  'status', 'coverImage', 'tags', 'excerpt', 'relatedSlugs'];

/* ------------------------------------------------------------------ 工具 */

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if (v.startsWith('"')) {
    try { return JSON.parse(v); } catch { /* 落到朴素解析 */ }
    // 兜底：去掉首尾引号并还原转义
    return v.slice(1, v.endsWith('"') ? -1 : undefined).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') || v.startsWith('{')) {
    try { return JSON.parse(v); } catch { /* 类似 [a, b] 的朴素数组 */ }
    const inner = v.replace(/^\[/, '').replace(/\]$/, '').trim();
    if (!inner) return [];
    return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return v;
}

/** 解析 frontmatter（YAML 子集）：标量 / 行内数组 / 块状列表 / 连续缩进续行 */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const lines = m[1].split(/\r?\n/);
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) { i += 1; continue; }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) { i += 1; continue; }
    const key = kv[1];
    const rest = kv[2];
    if (rest.trim() !== '') {
      data[key] = parseScalar(rest);
      i += 1;
      continue;
    }
    // 值为空：可能是块状列表，也可能是多行文本
    const items = [];
    let j = i + 1;
    while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
      items.push(parseScalar(lines[j].replace(/^\s*-\s+/, '')));
      j += 1;
    }
    if (items.length) { data[key] = items; i = j; continue; }
    const parts = [];
    let k = i + 1;
    while (k < lines.length && /^\s{2,}\S/.test(lines[k]) && !/^\s*-\s+/.test(lines[k])) {
      parts.push(lines[k].trim());
      k += 1;
    }
    data[key] = parts.length ? parts.join(' ') : '';
    i = k;
  }
  return { data, body: text.slice(m[0].length) };
}

function yamlValue(value) {
  if (value === undefined || value === null) return '""';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return JSON.stringify(value.map(v => String(v)));
  return JSON.stringify(String(value));
}

function serializeFrontmatter(data) {
  const keys = [...FIELD_ORDER.filter(k => k in data), ...Object.keys(data).filter(k => !FIELD_ORDER.includes(k))];
  const lines = keys.map(k => `${k}: ${yamlValue(data[k])}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

function toDateString(value) {
  if (!value) return '';
  const str = String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return str;
  return d.toISOString().slice(0, 10);
}

function folderForType(type) {
  if (type === 'novel-long') return 'long';
  if (type === 'novel-short') return 'short';
  if (type === 'series') return 'series';
  return 'short'; // essay 等长尾类型暂归入 short 目录，类型以 frontmatter 为准
}

/* ------------------------------------------------------------- 读取内容 */

function walkMd(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMd(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function readWorks() {
  const works = [];
  const problems = [];
  for (const [key, cfg] of Object.entries(COLLECTIONS)) {
    const dir = path.join(ROOT, cfg.dir);
    for (const file of walkMd(dir)) {
      const raw = fs.readFileSync(file, 'utf8');
      const { data, body } = parseFrontmatter(raw);
      const rel = path.relative(ROOT, file);
      const slug = (data.slug || path.basename(file, '.md')).trim();
      if (!data.title) problems.push(`${rel}：缺少 title`);
      if (!slug) problems.push(`${rel}：缺少 slug`);
      works.push({
        id: data.id,
        slug,
        title: data.title || slug,
        type: data.type || cfg.type,
        series: data.series || '',
        orderInSeries: Number.isFinite(Number(data.orderInSeries)) && data.orderInSeries !== ''
          ? Number(data.orderInSeries) : undefined,
        date: toDateString(data.date),
        summary: data.excerpt || '',
        coverImage: data.coverImage || '',
        tags: Array.isArray(data.tags) ? data.tags : (data.tags ? [String(data.tags)] : []),
        relatedSlugs: Array.isArray(data.relatedSlugs) ? data.relatedSlugs
          : (data.relatedSlugs ? [String(data.relatedSlugs)] : []),
        status: data.status || 'published',
        content: body,
        _file: rel,
        _collection: key
      });
    }
  }
  works.sort((a, b) => (a.date === b.date ? a.slug.localeCompare(b.slug) : a.date.localeCompare(b.date)));
  works.forEach((w, i) => { w.id = w.id ?? i + 1; delete w._file; delete w._collection; });
  return { works, problems };
}

/* ----------------------------------------------------------- 迁移模式 */

function migrate() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const block = '[' + html.split('const STATIC_WORKS = [')[1].split('\n    ];')[0] + ']';
  const staticWorks = new Function(`return ${block}`)();

  let written = 0;
  const originals = new Map();
  for (const w of staticWorks) {
    originals.set(w.slug, w.content);
    const folder = folderForType(w.type);
    const dir = path.join(ROOT, COLLECTIONS[folder].dir);
    fs.mkdirSync(dir, { recursive: true });
    const data = {
      title: w.title,
      slug: w.slug,
      type: w.type,
      series: w.series || '',
      orderInSeries: w.orderInSeries,
      date: w.date,
      status: w.status || 'published',
      coverImage: w.coverImage || '',
      tags: w.tags || [],
      excerpt: w.summary || '',
      relatedSlugs: w.relatedSlugs || []
    };
    const file = path.join(dir, `${w.slug}.md`);
    fs.writeFileSync(file, serializeFrontmatter(data) + w.content, 'utf8');
    written += 1;
  }

  // 正文保真校验：读回后必须与 STATIC_WORKS 的 content 完全一致
  let bad = 0;
  for (const w of readWorks().works) {
    if (originals.has(w.slug) && originals.get(w.slug) !== w.content) {
      bad += 1;
      console.error(`正文不一致：${w.slug}（原 ${originals.get(w.slug).length} 字 / 现 ${w.content.length} 字）`);
    }
  }
  console.log(`[migrate] 写出 ${written} 篇 Markdown，正文保真校验：${bad === 0 ? '通过' : bad + ' 篇不一致'}`);
  return bad === 0;
}

/* ------------------------------------------------------------------ main */

const isMigrate = process.argv.includes('--migrate');
if (isMigrate && !migrate()) process.exit(1);

const { works, problems } = readWorks();
if (!works.length) {
  console.error('[build] content/ 下没有找到任何 .md，索引未生成');
  process.exit(1);
}
if (problems.length) {
  console.error('[build] frontmatter 存在问题：\n  - ' + problems.join('\n  - '));
  process.exit(1);
}

const dup = works.map(w => w.slug).filter((s, i, arr) => arr.indexOf(s) !== i);
if (dup.length) {
  console.error('[build] slug 重复：' + [...new Set(dup)].join(', '));
  process.exit(1);
}

const index = {
  generatedAt: new Date().toISOString(),
  source: 'content/',
  count: works.length,
  works
};
fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2) + '\n', 'utf8');

const byType = works.reduce((acc, w) => { acc[w.type] = (acc[w.type] || 0) + 1; return acc; }, {});
console.log(`[build] ${works.length} 篇作品 → content-index.json（${Object.entries(byType).map(([k, v]) => `${k}:${v}`).join(' / ')}）`);
console.log(`[build] 索引大小 ${(fs.statSync(INDEX_FILE).size / 1024).toFixed(1)} KB`);
