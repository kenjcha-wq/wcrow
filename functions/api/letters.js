/**
 * 乌鸦与井 — 私信接口服务 (Cloudflare Pages Functions + Cloudflare D1)
 * 路径：functions/api/letters.js
 *
 * 数据库表结构要求 (D1)：
 * CREATE TABLE IF NOT EXISTS letters (
 *   id TEXT PRIMARY KEY,
 *   sender_name TEXT,
 *   sender_email TEXT,
 *   content TEXT NOT NULL,
 *   work_slug TEXT,
 *   created_at INTEGER NOT NULL,
 *   is_read INTEGER DEFAULT 0
 * );
 */

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method;

  // 设置统一 CORS 与 JSON 响应头
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json; charset=utf-8'
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // 检查 D1 数据库绑定是否存在
  const db = env.DB;
  if (!db) {
    return new Response(JSON.stringify({
      error: 'DATABASE_UNAVAILABLE',
      message: '后端数据库尚未绑定 (D1 DB is not configured)。请在 Cloudflare Pages 设置中绑定名为 DB 的 D1 数据库。'
    }), { status: 503, headers: corsHeaders });
  }

  try {
    // 自动初始化表结构（幂等操作）
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS letters (
        id TEXT PRIMARY KEY,
        sender_name TEXT,
        sender_email TEXT,
        content TEXT NOT NULL,
        work_slug TEXT,
        created_at INTEGER NOT NULL,
        is_read INTEGER DEFAULT 0
      )
    `).run();

    // 1. 公开接口：寄信 (POST /api/letters)
    if (method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: 'INVALID_JSON', message: '信件内容解析失败' }), { status: 400, headers: corsHeaders });
      }

      // 反垃圾蜜罐检测：真实读者不会填写隐藏的 hp_check 字段
      if (body.hp_check && body.hp_check.trim() !== '') {
        return new Response(JSON.stringify({ success: true, message: '信件已寄出' }), { status: 200, headers: corsHeaders });
      }

      const content = (body.content || '').trim();
      if (!content) {
        return new Response(JSON.stringify({ error: 'EMPTY_CONTENT', message: '信件正文不能为空' }), { status: 400, headers: corsHeaders });
      }

      if (content.length > 5000) {
        return new Response(JSON.stringify({ error: 'TOO_LONG', message: '信件正文请保持在 5000 字以内' }), { status: 400, headers: corsHeaders });
      }

      const senderName = (body.sender_name || '').trim().slice(0, 50);
      const senderEmail = (body.sender_email || '').trim().slice(0, 100);
      const workSlug = (body.work_slug || '').trim().slice(0, 100);

      // 简单邮箱格式校验（若填写）
      if (senderEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
        return new Response(JSON.stringify({ error: 'INVALID_EMAIL', message: '邮箱格式有误' }), { status: 400, headers: corsHeaders });
      }

      const letterId = 'let_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
      const now = Date.now();

      await db.prepare(`
        INSERT INTO letters (id, sender_name, sender_email, content, work_slug, created_at, is_read)
        VALUES (?, ?, ?, ?, ?, ?, 0)
      `).bind(letterId, senderName, senderEmail, content, workSlug, now).run();

      return new Response(JSON.stringify({
        success: true,
        message: '信件已静静送达井底。',
        id: letterId
      }), { status: 201, headers: corsHeaders });
    }

    // --- 以下为作者管理端接口：必须校验身份 Authorization: Bearer {ADMIN_SECRET} ---
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const adminSecret = env.ADMIN_SECRET;

    if (!adminSecret) {
      return new Response(JSON.stringify({
        error: 'AUTH_NOT_CONFIGURED',
        message: '环境变量 ADMIN_SECRET 尚未设置，无法登录管理端'
      }), { status: 500, headers: corsHeaders });
    }

    if (!token || token !== adminSecret) {
      return new Response(JSON.stringify({
        error: 'UNAUTHORIZED',
        message: '鉴权未通过：密码错误或未提供有效凭证'
      }), { status: 401, headers: corsHeaders });
    }

    // 2. 作者查询信件列表 (GET /api/letters)
    if (method === 'GET') {
      const { results } = await db.prepare(`
        SELECT id, sender_name, sender_email, content, work_slug, created_at, is_read
        FROM letters
        ORDER BY created_at DESC
        LIMIT 100
      `).all();

      return new Response(JSON.stringify({
        success: true,
        letters: results || []
      }), { status: 200, headers: corsHeaders });
    }

    // 3. 作者标记已读/未读 (PUT /api/letters)
    if (method === 'PUT') {
      const { id, is_read } = await request.json();
      if (!id) {
        return new Response(JSON.stringify({ error: 'MISSING_ID', message: '缺少信件编号' }), { status: 400, headers: corsHeaders });
      }

      await db.prepare(`
        UPDATE letters SET is_read = ? WHERE id = ?
      `).bind(is_read ? 1 : 0, id).run();

      return new Response(JSON.stringify({ success: true, message: '状态已更新' }), { status: 200, headers: corsHeaders });
    }

    // 4. 作者删除信件 (DELETE /api/letters)
    if (method === 'DELETE') {
      const { id } = await request.json();
      if (!id) {
        return new Response(JSON.stringify({ error: 'MISSING_ID', message: '缺少信件编号' }), { status: 400, headers: corsHeaders });
      }

      await db.prepare(`
        DELETE FROM letters WHERE id = ?
      `).bind(id).run();

      return new Response(JSON.stringify({ success: true, message: '信件已彻底删除' }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), { status: 405, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({
      error: 'SERVER_ERROR',
      message: err.message || '后端处理异常'
    }), { status: 500, headers: corsHeaders });
  }
}
