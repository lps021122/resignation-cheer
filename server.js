// 杈炶亴鎵撴皵绛?路 鎼滅储 + 鍐呭鎶撳彇 + AI 鎺ㄦ紨浠ｇ悊
// Bing 鎼滅储 + 椤甸潰姝ｆ枃鎻愬彇 + DeepSeek AI 鐢熸垚
// 鍚姩鍓嶈缃幆澧冨彉閲忥細set DEEPSEEK_API_KEY=sk-xxx  (Windows CMD)
//                    鎴?$env:DEEPSEEK_API_KEY="sk-xxx" (PowerShell)
// 绔彛锛?456

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');

const PORT = 3456;
const STATIC_DIR = __dirname;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

// 鈹€鈹€ HTTP fetch helper 鈹€鈹€
function fetchHTML(pageUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(pageUrl);
    const proto = parsed.protocol === 'https:' ? https : http;
    const req = proto.get(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
      },
      timeout: 10000,
    }, (res) => {
      // Follow redirects (max 3)
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location;
        if (loc) return resolve(fetchHTML(new URL(loc, pageUrl).href));
      }
      const chunks = [];
      const stream = res.headers['content-encoding'] === 'gzip'
        ? res.pipe(zlib.createGunzip())
        : res;
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// 鈹€鈹€ DeepSeek API 鈹€鈹€
function deepseekChat(apiKey, model, messages, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, temperature: 0.8, max_tokens: maxTokens || 2048 });
    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          if (data.error) return reject(new Error(data.error.message || 'DeepSeek API error'));
          resolve(data.choices?.[0]?.message?.content || '(empty response)');
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// 鈹€鈹€ Content extraction 鈹€鈹€
function extractContent(html, sourceUrl) {
  const host = new URL(sourceUrl).hostname;

  // Platform-specific selectors (ordered by priority)
  const selectors = [];

  if (host.includes('zhihu.com')) {
    selectors.push(
      /<div class="RichText[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<span class="RichText[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    );
  }
  if (host.includes('douban.com')) {
    selectors.push(
      /<div id="link-report"[^>]*>([\s\S]*?)<\/div>/i,
      /<div class="article"[^>]*>([\s\S]*?)<\/div>\s*<div id="comments"/i,
      /<div class="note-content"[^>]*>([\s\S]*?)<\/div>/i,
      /<div class="topic-content"[^>]*>([\s\S]*?)<\/div>/i,
    );
  }
  if (host.includes('mp.weixin.qq.com') || host.includes('mp.weixinbridge.com')) {
    selectors.push(
      /<div id="js_content"[^>]*>([\s\S]*?)<\/div>/i,
      /<div class="rich_media_content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    );
  }
  if (host.includes('sspai.com')) {
    selectors.push(/<div class="article-body"[^>]*>([\s\S]*?)<\/div>/i);
  }
  if (host.includes('163.com') || host.includes('sohu.com') || host.includes('sina.com')) {
    selectors.push(
      /<div class="post_content"[^>]*>([\s\S]*?)<\/div>/i,
      /<div class="article-content"[^>]*>([\s\S]*?)<\/div>/i,
    );
  }

  // Try platform-specific selectors first
  for (const regex of selectors) {
    const match = html.match(regex);
    if (match) {
      const text = stripHtml(match[1]);
      if (text.length > 100) return text;
    }
  }

  // Fallback: find the largest text block between common content containers
  const fallbackPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/gi,
    /<div class="[^"]*(?:content|article|post|entry|body|main|text)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    /<section[^>]*>([\s\S]*?)<\/section>/gi,
  ];

  for (const pattern of fallbackPatterns) {
    let match;
    let best = '';
    while ((match = pattern.exec(html)) !== null) {
      const text = stripHtml(match[1]);
      if (text.length > best.length) best = text;
    }
    if (best.length > 200) return best;
  }

  return '';
}

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// 鈹€鈹€ Likes store (shared JSON file) 鈹€鈹€
const LIKES_FILE = path.join(__dirname, 'likes.json');

function loadLikes() {
  try { return JSON.parse(fs.readFileSync(LIKES_FILE, 'utf-8')); }
  catch { return {}; }
}
function saveLikes(likes) {
  fs.writeFileSync(LIKES_FILE, JSON.stringify(likes), 'utf-8');
}

// 鈹€鈹€ Bing HTML Search 鈹€鈹€
function searchBing(query, first) {
  return new Promise((resolve, reject) => {
    const params = { q: query, setlang: 'zh-cn' };
    if (first) params.first = String(first);
    const qs = new URLSearchParams(params);
    const req = https.get({
      hostname: 'cn.bing.com',
      path: '/search?' + qs.toString(),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
      },
      timeout: 8000,
    }, (res) => {
      const chunks = [];
      const stream = res.headers['content-encoding'] === 'gzip'
        ? res.pipe(zlib.createGunzip())
        : res;
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf-8');
        resolve(parseBingResults(html));
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseBingResults(html) {
  const results = [];
  const parts = html.split(/<li class="b_algo"[^>]*>/i);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const liEnd = block.indexOf('</li>');
    const content = liEnd > 0 ? block.substring(0, liEnd) : block;

    const h2Match = content.match(/<h2[^>]*>\s*<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
    if (!h2Match) continue;

    let url = h2Match[1];
    const uddgMatch = url.match(/uddg=([^&]+)/);
    if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);

    const title = h2Match[2].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d)).trim();

    const capMatch = content.match(/class="b_caption"[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
    let snippet = '';
    if (capMatch) {
      snippet = capMatch[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d)).replace(/\s+/g, ' ').trim();
    }

    if (title && url.startsWith('http') && !url.includes('bing.com') && !url.includes('go.microsoft.com')) {
      results.push({ title, snippet: snippet || '(鏃犳憳瑕?', url });
    }
  }
  return results;
}

// 鈹€鈹€ HTTP Server 鈹€鈹€
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // API: search
  if (pathname === '/api/search' && req.method === 'GET') {
    const q = (parsed.query.q || '').trim();
    if (!q) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing q' })); return; }
    try {
      const first = parseInt(parsed.query.first) || 0;
      // Fix ambiguous Chinese terms that Bing misinterprets
      let searchQ = q;
      if (q.includes('瑁歌緸')) {
        // "瑁歌緸" is hopeless on Bing 鈥?swap it out entirely
        searchQ = q.replace(/瑁歌緸/g, '杈炶亴') + ' 鎴戠殑鐪熷疄缁忓巻';
      } else if (!q.includes('杈炶亴') && !q.includes('绂昏亴') && !q.includes('璺虫Ы') && !q.includes('鎵惧伐浣?)) {
        searchQ = q + ' 鑱屽満缁忓巻';
      }
      const results = await searchBing(searchQ, first);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ query: q, count: results.length, first, results }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: get all likes
  if (pathname === '/api/likes' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadLikes()));
    return;
  }

  // API: increment a like
  if (pathname === '/api/like' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        const { id } = JSON.parse(body);
        if (!id) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing id' })); return; }
        const likes = loadLikes();
        likes[id] = (likes[id] || 0) + 1;
        saveLikes(likes);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, count: likes[id] }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: fetch page content
  if (pathname === '/api/fetch' && req.method === 'GET') {
    const pageUrl = (parsed.query.url || '').trim();
    if (!pageUrl) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing url' })); return; }
    try {
      console.log('Fetching:', pageUrl);
      const html = await fetchHTML(pageUrl);
      const content = extractContent(html, pageUrl);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        url: pageUrl,
        length: content.length,
        content: content || '(鏈兘鎻愬彇鍒版鏂囧唴瀹癸紝璇风偣鍑诲師鏂囬摼鎺ユ煡鐪?',
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: AI generation (DeepSeek proxy)
  if (pathname === '/api/generate' && req.method === 'POST') {
    if (!DEEPSEEK_API_KEY) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'Server has no DeepSeek API key configured. Set DEEPSEEK_API_KEY environment variable.' }));
      return;
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        const { model, messages, max_tokens } = JSON.parse(body);
        if (!messages) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing messages' })); return; }
        console.log('Generate request, messages count:', messages.length);
        const result = await deepseekChat(DEEPSEEK_API_KEY, model || 'deepseek-chat', messages, max_tokens || 2048);
        console.log('Generate success, length:', result.length);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ content: result }));
      } catch (e) {
        console.error('Generate error:', e.message, e.stack);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Static files
  let filePath = pathname === '/' ? '/resignation-cheer.html' : pathname;
  filePath = path.join(STATIC_DIR, path.basename(filePath));
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(process.env.PORT || PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${process.env.PORT || PORT}`);
});
