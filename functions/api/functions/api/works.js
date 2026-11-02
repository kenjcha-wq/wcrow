/**
 * 乌鸦与井 — 作品数据管理接口服务 (Cloudflare Pages Functions + Cloudflare D1)
 * 路径：functions/api/works.js
 *
 * 供智能体 (Agent) 或作者脚本进行自动化运营管理
 * 表结构要求 (D1)：
 * CREATE TABLE IF NOT EXISTS works (
 *   slug TEXT PRIMARY KEY,
 *   title TEXT NOT NULL,
 *   type TEXT NOT NULL,
 *   series TEXT,
 *   order_in_series INTEGER,
 *   date TEXT NOT NULL,
 *   summary TEXT,
 *   cover_image TEXT,
 *   tags TEXT,               -- JSON 数组字符串: '["井", "猫"]'
 *   related_slugs TEXT,      -- JSON 数组字符串: '["slug1", "slug2"]'
 *   status TEXT DEFAULT 'published',
 *   content TEXT NOT NULL,
 *   updated_at INTEGER NOT NULL
 * );
 */

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json; charset=utf-8'
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const db = env.DB;
  if (!db) {
    return new Response(JSON.stringify({
      error: 'DATABASE_UNAVAILABLE',
      message: 'Cloudflare D1 数据库尚未绑定到变量 DB。'
    }), { status: 503, headers: corsHeaders });
  }

  try {
    // 自动初始化作品表（幂等操作）
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS works (
        slug TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        series TEXT,
        order_in_series INTEGER,
        date TEXT NOT NULL,
        summary TEXT,
        cover_image TEXT,
        tags TEXT,
        related_slugs TEXT,
        status TEXT DEFAULT 'published',
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run();

    // 1. 公开接口：获取所有作品 (GET /api/works)
    if (method === 'GET') {
      const url = new URL(request.url);
      const includeDrafts = url.searchParams.get('drafts') === 'true';

      // 检查是否带有管理密钥（若带有效凭证且传了 drafts=true 则可查看草稿）
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      const isAdmin = env.ADMIN_SECRET && token === env.ADMIN_SECRET;

      let query = `SELECT * FROM works`;
      if (!isAdmin || !includeDrafts) {
        query += ` WHERE status = 'published'`;
      }
      query += ` ORDER BY date DESC`;

      const { results } = await db.prepare(query).all();

      const formatted = (results || []).map(row => ({
        id: row.slug,
        slug: row.slug,
        title: row.title,
        type: row.type,
        series: row.series || null,
        orderInSeries: row.order_in_series,
        date: row.date,
        summary: row.summary || '',
        coverImage: row.cover_image || '',
        tags: row.tags ? JSON.parse(row.tags) : [],
        relatedSlugs: row.related_slugs ? JSON.parse(row.related_slugs) : [],
        status: row.status,
        content: row.content,
        updatedAt: row.updated_at
      }));

      return new Response(JSON.stringify({
        success: true,
        count: formatted.length,
        works: formatted
      }), { status: 200, headers: corsHeaders });
    }

    // --- 以下接口供智能体/作者修改作品：必须通过 Bearer Token 鉴权 ---
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const adminSecret = env.ADMIN_SECRET;

    if (!adminSecret || token !== adminSecret) {
      return new Response(JSON.stringify({
        error: 'UNAUTHORIZED',
        message: '鉴权未通过：请在请求头提供有效的 Authorization: Bearer <ADMIN_SECRET>'
      }), { status: 401, headers: corsHeaders });
    }

    // 2. 智能体新增作品 (POST /api/works)
    if (method === 'POST') {
      const body = await request.json();
      const {
        slug, title, type, series, orderInSeries,
        date, summary, coverImage, tags, relatedSlugs,
        status, content
      } = body;

      if (!slug || !title || !content) {
        return new Response(JSON.stringify({
          error: 'MISSING_FIELDS',
          message: '缺少必填字段：slug, title, content 为必填项'
        }), { status: 400, headers: corsHeaders });
      }

      const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      const tagsJson = JSON.stringify(Array.isArray(tags) ? tags : []);
      const relatedJson = JSON.stringify(Array.isArray(relatedSlugs) ? relatedSlugs : []);
      const now = Date.now();

      await db.prepare(`
        INSERT INTO works (
          slug, title, type, series, order_in_series,
          date, summary, cover_image, tags, related_slugs,
          status, content, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
          title = excluded.title,
          type = excluded.type,
          series = excluded.series,
          order_in_series = excluded.order_in_series,
          date = excluded.date,
          summary = excluded.summary,
          cover_image = excluded.cover_image,
          tags = excluded.tags,
          related_slugs = excluded.related_slugs,
          status = excluded.status,
          content = excluded.content,
          updated_at = excluded.updated_at
      `).bind(
        cleanSlug,
        title.trim(),
        type || 'novel-short',
        series || null,
        orderInSeries || null,
        date || new Date().toISOString().split('T')[0],
        summary || '',
        coverImage || '',
        tagsJson,
        relatedJson,
        status || 'published',
        content,
        now
      ).run();

      return new Response(JSON.stringify({
        success: true,
        message: `作品《${title}》已成功收录入库`,
        slug: cleanSlug
      }), { status: 201, headers: corsHeaders });
    }

    // 3. 智能体更新作品 (PUT /api/works)
    if (method === 'PUT') {
      const body = await request.json();
      const { slug, ...fields } = body;
      if (!slug) {
        return new Response(JSON.stringify({ error: 'MISSING_SLUG', message: '必须指定作品 slug' }), { status: 400, headers: corsHeaders });
      }

      const existing = await db.prepare(`SELECT * FROM works WHERE slug = ?`).bind(slug).first();
      if (!existing) {
        return new Response(JSON.stringify({ error: 'NOT_FOUND', message: '未找到指定 slug 的作品' }), { status: 404, headers: corsHeaders });
      }

      const updatedTitle = fields.title !== undefined ? fields.title.trim() : existing.title;
      const updatedType = fields.type !== undefined ? fields.type : existing.type;
      const updatedSeries = fields.series !== undefined ? fields.series : existing.series;
      const updatedOrder = fields.orderInSeries !== undefined ? fields.orderInSeries : existing.order_in_series;
      const updatedDate = fields.date !== undefined ? fields.date : existing.date;
      const updatedSummary = fields.summary !== undefined ? fields.summary : existing.summary;
      const updatedCover = fields.coverImage !== undefined ? fields.coverImage : existing.cover_image;
      const updatedTags = fields.tags !== undefined ? JSON.stringify(fields.tags) : existing.tags;
      const updatedRelated = fields.relatedSlugs !== undefined ? JSON.stringify(fields.relatedSlugs) : existing.related_slugs;
      const updatedStatus = fields.status !== undefined ? fields.status : existing.status;
      const updatedContent = fields.content !== undefined ? fields.content : existing.content;

      await db.prepare(`
        UPDATE works SET
          title = ?, type = ?, series = ?, order_in_series = ?,
          date = ?, summary = ?, cover_image = ?, tags = ?,
          related_slugs = ?, status = ?, content = ?, updated_at = ?
        WHERE slug = ?
      `).bind(
        updatedTitle, updatedType, updatedSeries, updatedOrder,
        updatedDate, updatedSummary, updatedCover, updatedTags,
        updatedRelated, updatedStatus, updatedContent, Date.now(),
        slug
      ).run();

      return new Response(JSON.stringify({
        success: true,
        message: `作品《${updatedTitle}》已更新`
      }), { status: 200, headers: corsHeaders });
    }

    // 4. 智能体删除作品 (DELETE /api/works)
    if (method === 'DELETE') {
      const { slug } = await request.json();
      if (!slug) {
        return new Response(JSON.stringify({ error: 'MISSING_SLUG', message: '必须提供 slug' }), { status: 400, headers: corsHeaders });
      }

      await db.prepare(`DELETE FROM works WHERE slug = ?`).bind(slug).run();

      return new Response(JSON.stringify({
        success: true,
        message: `作品 [${slug}] 已从数据库彻底移除`
      }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), { status: 405, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({
      error: 'SERVER_ERROR',
      message: err.message || '后端作品接口处理异常'
    }), { status: 500, headers: corsHeaders });
  }
}
