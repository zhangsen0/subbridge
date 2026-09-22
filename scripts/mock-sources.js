'use strict';

/**
 * 抓取中心测试源（本地 mock，供 /api/grab 集成测试使用）
 *
 * 端口：18100（与 18099 文本源区分）
 * 路由：
 *   /sub.txt    行式订阅（多协议）
 *   /base64.txt base64 编码订阅
 *   /clash.yaml Clash YAML 订阅
 *   /page.html  HTML 网页（内嵌节点 + 指向 /sub.txt 的订阅链接，模拟"网页发现订阅"）
 *   /vpngate    模拟 vpngate /api/iphone/ 的 CSV（openvpn 批量列表）
 *
 * 用法：node scripts/mock-sources.js [port]
 */

const http = require('http');
const port = Number(process.argv[2]) || 18100;

// 行式订阅：4 个假域名节点（vless / vmess / ss / trojan）
const LINE_NODES = [
  'vless://90cd4a77-141a-43c9-991b-08263cfe9c10@jp1.test-node.dev:443?security=tls&type=ws&path=%2F&encryption=none#%E6%B5%8B%E8%AF%95%E8%8A%82%E7%82%B9-JP',
  'vmess://eyJ2IjoiMiIsInBzIjoi6L2m6K6k5Yqg5bm0LVVTMSIsImFkZCI6InVzMS50ZXN0LW5vZGUuZGV2IiwicG9ydCI6IjQ0MyIsImlkIjoiOTBjZDRhNzctMTQxYS00M2M5LTk5MWItMDgyNjNjZmU5YzEwIiwiYWlkIjoiMCIsIm5ldCI6IndzIiwicGF0aCI6Ii8ifQ==',
  'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQx@sg1.test-node.dev:8388#%E6%B5%8B%E8%AF%95%E8%8A%82%E7%82%B9-SG',
  'trojan://password@hk1.test-node.dev:443?security=tls&sni=hk1.test-node.dev#%E6%B5%8B%E8%AF%95%E8%8A%82%E7%82%B9-HK',
];

// vpngate 模拟 CSV（15 列，含 OpenVPN 配置 base64）
const VPNGATE_CSV = [
  '*vpn_servers',
  'HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64',
  'vpntokyo1,203.0.113.10,100,50,8,Japan,JP,10,99,1000,5000,L,SoftEther VPN,VPN Gate Experimental Program,bGF0ZXI=',
  'vpnnny1,198.51.100.20,80,120,3,United States,US,5,95,800,4000,L,SoftEther VPN,VPN Gate Experimental Program,dGVzdA==',
  'vpnsg1,192.0.2.30,90,80,6,Singapore,SG,8,97,900,4500,L,SoftEther VPN,VPN Gate Experimental Program,c2luZ2Fwb3Jl',
  '',
].join('\n');

// HTML 网页：内嵌 1 个节点 + 链接到 /sub.txt（模拟网页递归发现订阅）
const PAGE_HTML = `<!DOCTYPE html>
<html><head><title>节点分享页</title></head>
<body>
  <h1>免费节点分享</h1>
  <p>每日更新，请复制以下节点：</p>
  <pre>ss://YWVzLTI1Ni1nY206cGFzc3dvcmQx@de1.test-node.dev:8388#%E6%B5%8B%E8%AF%95%E8%8A%82%E7%82%B9-DE</pre>
  <p>或订阅：<a href="http://127.0.0.1:${port}/sub.txt">订阅链接</a></p>
</body></html>`;

// Clash YAML 订阅
const CLASH_YAML = `proxies:
  - name: "yaml-test-01"
    type: ss
    server: yaml1.test-node.dev
    port: 8388
    cipher: aes-256-gcm
    password: pass-yaml-01
`;

const ROUTES = {
  '/sub.txt': { type: 'text/plain; charset=utf-8', body: LINE_NODES.join('\n') },
  '/base64.txt': { type: 'text/plain; charset=utf-8', body: Buffer.from(LINE_NODES.join('\n')).toString('base64') },
  '/clash.yaml': { type: 'text/yaml; charset=utf-8', body: CLASH_YAML },
  '/page.html': { type: 'text/html; charset=utf-8', body: PAGE_HTML },
  '/vpngate': { type: 'text/plain; charset=utf-8', body: VPNGATE_CSV },
};

http
  .createServer((req, res) => {
    const route = ROUTES[req.url.split('?')[0]];
    if (!route) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.setHeader('Content-Type', route.type);
    res.end(route.body);
  })
  .listen(port, '127.0.0.1', () => console.log(`mock-sources listening 127.0.0.1:${port}`));
