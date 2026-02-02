// Cloudflare Worker: VLESS 订阅转换器 
// (功能：Sing-box/Clash 双远程模板 + UUID安全ID + 手机扫码二维码)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- 路由 1: 首页 UI (GET /) ---
    if (path === '/' && request.method === 'GET') {
      const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>VLESS 转 订阅 (扫码版)</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #333; }
          h1 { font-size: 1.5rem; margin-bottom: 1rem; }
          textarea { width: 100%; height: 200px; padding: 10px; border: 1px solid #ccc; border-radius: 4px; font-family: monospace; font-size: 12px; resize: vertical; margin-bottom: 1rem; box-sizing: border-box; }
          .options { margin-bottom: 1rem; }
          .options label { margin-right: 15px; cursor: pointer; }
          button { background-color: #0070f3; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 16px; transition: background 0.2s; }
          button:hover { background-color: #0051a2; }
          button:disabled { background-color: #ccc; cursor: not-allowed; }
          
          .result-container { margin-top: 20px; padding: 20px; background: #f5f5f5; border-radius: 6px; border: 1px solid #e1e1e1; display: none; text-align: center; }
          .result-link { word-break: break-all; color: #0070f3; text-decoration: none; font-family: monospace; font-size: 13px; display: block; margin-bottom: 15px; text-align: left;}
          
          /* 二维码容器样式 */
          #qrcode { display: inline-block; padding: 10px; background: white; border-radius: 4px; border: 1px solid #ddd; margin-top: 10px; }
          #qrcode img { display: block; }
          .hint { font-size: 12px; color: #666; margin-top: 5px; }
        </style>
      </head>
      <body>
        <h1>VLESS 转 订阅 (扫码版)</h1>
        <p style="font-size: 14px; color: #666;">输入 VLESS 链接 (每行一个):</p>
        <textarea id="input" placeholder="vless://..."></textarea>
        
        <div class="options">
          <label><input type="radio" name="target" value="singbox" checked> Sing-box</label>
          <label><input type="radio" name="target" value="clash"> Clash</label>
        </div>
        
        <button id="btn" onclick="submit()">生成订阅链接 & 二维码</button>
        
        <div id="result" class="result-container">
          <div style="font-weight:bold;margin-bottom:5px;text-align:left;">订阅链接：</div>
          <a id="linkUrl" class="result-link" href="#" target="_blank"></a>
          
          <div id="qrcode"></div>
          <div class="hint">📱 手机可以直接扫码添加</div>
        </div>

        <script>
          async function submit() {
            const btn = document.getElementById('btn');
            const input = document.getElementById('input');
            const resultDiv = document.getElementById('result');
            const linkUrl = document.getElementById('linkUrl');
            const qrcodeDiv = document.getElementById('qrcode');
            
            const text = input.value.trim();
            const target = document.querySelector('input[name="target"]:checked').value;
            
            if(!text) return alert('请先输入 VLESS 链接');
            
            // 重置 UI
            resultDiv.style.display = 'none';
            qrcodeDiv.innerHTML = ''; // 清空旧的二维码
            btn.innerText = '生成中...'; 
            btn.disabled = true;
            
            try {
              // 1. 发送请求保存配置
              const res = await fetch('/api/save', { 
                method: 'POST', 
                headers: {'Content-Type':'application/json'}, 
                body: JSON.stringify({ content: text }) 
              });
              
              if (!res.ok) throw new Error('保存失败');
              
              const data = await res.json();
              
              // 2. 生成完整的订阅 URL
              const fullUrl = window.location.origin + '/sub/' + data.id + '?target=' + target;
              
              // 3. 显示链接
              resultDiv.style.display = 'block'; 
              linkUrl.href = fullUrl; 
              linkUrl.innerText = fullUrl;
              
              // 4. 生成二维码 (核心修改)
              new QRCode(qrcodeDiv, {
                text: fullUrl,
                width: 180,
                height: 180,
                colorDark : "#000000",
                colorLight : "#ffffff",
                correctLevel : QRCode.CorrectLevel.M
              });

              // 自动复制
              navigator.clipboard.writeText(fullUrl).catch(()=>{});
              
            } catch (err) { 
              alert('发生错误: ' + err.message); 
            } finally { 
              btn.innerText = '生成订阅链接 & 二维码'; 
              btn.disabled = false; 
            }
          }
        </script>
      </body>
      </html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    // --- 路由 2: 保存接口 (POST /api/save) ---
    if (path === '/api/save' && request.method === 'POST') {
      try {
        const body = await request.json();
        const content = body.content;
        
        // 使用 UUID 生成极其安全的 ID
        const id = crypto.randomUUID();

        // 存入 KV (30天过期)
        await env.SUB_STORE.put(id, content, { expirationTtl: 60 * 60 * 24 * 30 }); 
        
        return new Response(JSON.stringify({ id }), { 
          headers: { 
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, no-cache, must-revalidate'
          } 
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // --- 路由 3: 订阅接口 (GET/POST /sub/:id) ---
    // 【关键修复】正则增加了 "-", 允许匹配 UUID 格式
    const subMatch = path.match(/^\/sub\/([a-zA-Z0-9-]+)$/);
    
    if (subMatch) {
      if (request.method === 'GET' || request.method === 'POST') {
        const id = subMatch[1];
        const target = url.searchParams.get('target') || 'singbox';

        const rawText = await env.SUB_STORE.get(id);
        if (!rawText) return new Response('Expired or not found', { status: 404 });

        const links = rawText.split('\n').filter(l => l.trim().startsWith('vless://'));

        if (target === 'singbox') {
          const config = await generateSingbox(links);
          return new Response(JSON.stringify(config, null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
          });
        } else if (target === 'clash') {
          const config = await generateClash(links);
          return new Response(config, {
            headers: { 'Content-Type': 'text/yaml; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
          });
        } else {
          return new Response('Unknown target', { status: 400 });
        }
      }
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } })
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};

// =========================================================
// 核心逻辑函数 (VLESS 解析 + 远程模板)
// =========================================================

function parseVless(urlStr) {
  try {
    const url = new URL(urlStr.trim());
    const params = new URLSearchParams(url.search);
    return {
      name: decodeURIComponent(url.hash.slice(1)) || 'Node',
      server: url.hostname,
      port: parseInt(url.port),
      uuid: url.username,
      type: 'vless',
      network: params.get('type') || 'tcp',
      tls: params.get('security') === 'tls' || params.get('security') === 'reality',
      servername: params.get('sni'),
      flow: params.get('flow'),
      reality: params.get('security') === 'reality',
      pbk: params.get('pbk'),
      sid: params.get('sid'),
      fp: params.get('fp')
    };
  } catch (e) { return null; }
}

// --- Sing-box 逻辑 ---
function createSingboxNode(v) {
  const node = {
    type: "vless",
    tag: v.name,
    server: v.server,
    server_port: v.port,
    uuid: v.uuid,
    flow: v.flow || "",
    tls: { enabled: v.tls, server_name: v.servername, utls: { enabled: true, fingerprint: v.fp || "chrome" } },
    packet_encoding: "xudp"
  };
  if (v.reality) node.tls.reality = { enabled: true, public_key: v.pbk, short_id: v.sid };
  if (v.network === 'ws') node.transport = { type: "ws", path: "/", headers: {} };
  return node;
}

async function generateSingbox(links) {
  // 移除了中间的版本号，永远指向最新版
  const TEMPLATE_URL = 'https://gist.githubusercontent.com/crb912/c952899eccbc176fd3b47fe410408006/raw/net_config_singbox';
  const newNodes = links.map(link => { const v = parseVless(link); return v ? createSingboxNode(v) : null; }).filter(Boolean);
  if (newNodes.length === 0) return { error: "无法解析 VLESS 链接" };

  let template;
  try {
    const resp = await fetch(TEMPLATE_URL);
    if (!resp.ok) throw new Error(`Template fetch failed`);
    template = await resp.json();
  } catch (e) { return { error: "Singbox模板获取失败", details: e.message }; }

  if (!Array.isArray(template.outbounds)) template.outbounds = [];
  template.outbounds.push(...newNodes);

  template.outbounds.forEach(outbound => {
    if (['selector', 'urltest', 'fallback'].includes(outbound.type) && Array.isArray(outbound.outbounds)) {
      const index = outbound.outbounds.indexOf('my_vps');
      if (index !== -1) {
        outbound.outbounds.splice(index, 1);
        outbound.outbounds.push(...newNodes.map(n => n.tag));
      }
    }
  });
  template.outbounds = template.outbounds.filter(node => node.tag !== 'my_vps');
  return template;
}

// --- Clash 逻辑 ---
async function generateClash(links) {
  // 移除了中间的版本号，永远指向最新版
  const TEMPLATE_URL = 'https://gist.githubusercontent.com/crb912/10ad5c3292add2fc6f6d91c504008f89/raw/net_config_clash.yaml';

  let yamlText;
  try {
    const resp = await fetch(TEMPLATE_URL);
    if (!resp.ok) throw new Error(`Template fetch failed`);
    yamlText = await resp.text();
  } catch (e) { return `# Error fetching Clash template: ${e.message}`; }

  const newProxyNames = [];
  let proxiesBlock = "proxies:\n";

  links.forEach(link => {
    const v = parseVless(link);
    if (!v) return;
    newProxyNames.push(v.name);
    
    let p = `  - name: ${v.name}\n`;
    p += `    server: ${v.server}\n    port: ${v.port}\n    type: vless\n    uuid: ${v.uuid}\n    tls: true\n`;
    if (v.flow) p += `    flow: ${v.flow}\n`;
    if (v.reality) {
      p += `    reality-opts:\n      public-key: ${v.pbk}\n`;
      if(v.sid) p += `      short-id: ${v.sid}\n`;
    }
    if (v.servername) p += `    servername: ${v.servername}\n`;
    if (v.fp) p += `    client-fingerprint: ${v.fp}\n`;
    if (!v.network) v.network = 'tcp';
    p += `    network: ${v.network}\n    udp: true\n`;
    proxiesBlock += p;
  });

  if (newProxyNames.length === 0) return yamlText;

  if (yamlText.includes('proxy-groups:')) {
    yamlText = yamlText.replace('proxy-groups:', `${proxiesBlock}\nproxy-groups:`);
  } else {
    yamlText += `\n${proxiesBlock}`;
  }

  const groupRegex = /(proxies:\s*\[)(.*?)(\])/g;
  yamlText = yamlText.replace(groupRegex, (match, prefix, content, suffix) => {
    const nodesString = newProxyNames.join(', ');
    if (!content || content.trim() === '') {
      return `${prefix} ${nodesString} ${suffix}`;
    } else {
      return `${prefix}${content}, ${nodesString}${suffix}`;
    }
  });

  return yamlText;
}
