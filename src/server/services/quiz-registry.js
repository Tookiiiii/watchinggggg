import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { isHtmlFile, safeResolvePath } from '../utils/http.js';

const RESERVED_SLUGS = new Set(['api', 'monitor', 'collector', 'q']);

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHtmlMeta(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).slice(0, 120) : '';

  const descMatch =
    html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
    html.match(/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
  const description = descMatch ? decodeHtmlEntities(descMatch[1]).slice(0, 240) : '';

  return { title, description };
}

async function readOptionalJson(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function isValidSlug(slug) {
  if (!slug || slug.startsWith('.')) return false;
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) return false;
  if (RESERVED_SLUGS.has(slug.toLowerCase())) return false;
  return true;
}

export class QuizRegistry {
  constructor(quizzesDir, options = {}) {
    this.quizzesDir = resolve(quizzesDir);
    this.cacheTtlMs = options.cacheTtlMs ?? 500;
    this._cache = null;
    this._cacheAt = 0;
  }

  invalidate() {
    this._cache = null;
    this._cacheAt = 0;
  }

  async _scan() {
    let entries;
    try {
      entries = await readdir(this.quizzesDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const bySlug = new Map();

    // Pass 1: directories first so directory quizzes take priority over same-named single files.
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sorted) {
      if (entry.name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        const slug = entry.name;
        if (!isValidSlug(slug)) continue;

        const dirPath = join(this.quizzesDir, slug);
        const childEntries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
        const config = await readOptionalJson(join(dirPath, 'quiz.config.json'));

        const htmlFiles = childEntries
          .filter(item => item.isFile() && isHtmlFile(item.name))
          .map(item => item.name)
          .sort((a, b) => a.localeCompare(b));

        let entryRelative = '';
        if (typeof config.entry === 'string' && config.entry.trim()) {
          const candidate = safeResolvePath(dirPath, config.entry.trim());
          if (candidate) {
            const candidateInfo = await stat(candidate).catch(() => null);
            if (candidateInfo?.isFile()) {
              entryRelative = config.entry.trim().replace(/^\/+/, '');
            }
          }
        }
        if (!entryRelative) {
          entryRelative =
            htmlFiles.find(name => name.toLowerCase() === 'index.html') ||
            htmlFiles.find(name => name.toLowerCase() === 'index.htm') ||
            htmlFiles[0] ||
            '';
        }
        if (!entryRelative) continue;

        const entryPath = join(dirPath, entryRelative);
        const [entryStat, entryHtml] = await Promise.all([
          stat(entryPath).catch(() => null),
          readFile(entryPath, 'utf8').catch(() => '')
        ]);
        const meta = extractHtmlMeta(entryHtml.slice(0, 32768));

        const rootEntries = childEntries
          .filter(item => !item.name.startsWith('.') && item.name !== 'quiz.config.json')
          .map(item => item.name);

        bySlug.set(slug, {
          slug,
          type: 'directory',
          title: String(config.title || meta.title || slug).trim(),
          description: String(config.description ?? meta.description ?? '').trim(),
          hidden: Boolean(config.hidden),
          rootDir: dirPath,
          entryFile: entryRelative,
          entryPath,
          rootEntries,
          mountPath: `/q/${encodeURIComponent(slug)}/`,
          collector: config.collector && typeof config.collector === 'object' ? config.collector : {},
          updatedAt: entryStat ? entryStat.mtime.toISOString() : null
        });
      }
    }

    // Pass 2: single HTML files directly dropped into quizzes/.
    for (const entry of sorted) {
      if (entry.name.startsWith('.') || !entry.isFile()) continue;
      if (!isHtmlFile(entry.name)) continue;

      const ext = extname(entry.name);
      const slug = basename(entry.name, ext);
      if (!isValidSlug(slug) || bySlug.has(slug)) continue;

      const filePath = join(this.quizzesDir, entry.name);
      const config = await readOptionalJson(join(this.quizzesDir, `${slug}.config.json`));
      const [fileStat, html] = await Promise.all([
        stat(filePath).catch(() => null),
        readFile(filePath, 'utf8').catch(() => '')
      ]);
      const meta = extractHtmlMeta(html.slice(0, 32768));

      bySlug.set(slug, {
        slug,
        type: 'single-file',
        title: String(config.title || meta.title || slug).trim(),
        description: String(config.description ?? meta.description ?? '').trim(),
        hidden: Boolean(config.hidden),
        rootDir: this.quizzesDir,
        entryFile: entry.name,
        entryPath: filePath,
        rootEntries: [],
        mountPath: `/q/${encodeURIComponent(slug)}/`,
        collector: config.collector && typeof config.collector === 'object' ? config.collector : {},
        updatedAt: fileStat ? fileStat.mtime.toISOString() : null
      });
    }

    return Array.from(bySlug.values()).sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async list(options = {}) {
    const now = Date.now();
    if (!options.forceRefresh && this._cache && now - this._cacheAt < this.cacheTtlMs) {
      return this._cache;
    }
    const items = await this._scan();
    this._cache = items;
    this._cacheAt = now;
    return items;
  }

  async get(slug, options = {}) {
    if (!slug) return null;
    const normalized = String(slug).replace(/\.html?$/i, '');
    const items = await this.list(options);
    return items.find(item => item.slug === slug || item.slug === normalized) || null;
  }

  toPublicSummary(quiz) {
    return {
      slug: quiz.slug,
      title: quiz.title,
      description: quiz.description,
      type: quiz.type,
      hidden: quiz.hidden,
      mountPath: quiz.mountPath,
      updatedAt: quiz.updatedAt,
      collectorEnabled: quiz.collector?.enabled !== false
    };
  }
}
