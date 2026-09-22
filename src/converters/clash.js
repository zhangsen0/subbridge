'use strict';

/**
 * Clash / Mihomo YAML 转换器
 *
 * 基于模板渲染（templates/clash.tmpl.yaml），支持占位符：
 *   {{proxies}}  {{proxy-groups}}  {{rules}}  {{name}}
 * 模板与规则文件均可通过前台编辑（data/templates/ 覆盖内置 templates/）。
 */

const yaml = require('js-yaml');
const fs = require('node:fs/promises');
const path = require('node:path');
const { cleanUndefined } = require('../core/util');

/** 将文本块整体缩进指定空格数（用于填入 YAML 列表项） */
function indentBlock(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

/** 读取模板文件：经存储层读运行时覆盖版本，其次内置 templates/ */
async function readTemplateFile(name, ctx) {
  const override = await ctx.store.readTemplate(name);
  if (override !== null) return override;
  return fs.readFile(path.join(ctx.templatesDir, name), 'utf8');
}

/**
 * 将统一节点模型转换为 Clash proxy 对象
 * @param {object} n 节点模型
 * @param {{udp?: boolean}} opts
 * @returns {object}
 */
function toClashProxy(n, opts) {
  const udp = opts.udp !== undefined ? opts.udp : true;
  const base = { name: n.name, server: n.server, port: n.port, udp };

  switch (n.type) {
    case 'ss':
      return cleanUndefined({ ...base, type: 'ss', cipher: n.cipher || 'aes-256-gcm', password: n.password || '' });
    case 'ssr':
      return cleanUndefined({
        ...base,
        type: 'ssr',
        cipher: n.cipher || '',
        password: n.password || '',
        protocol: n.protocol || '',
        'protocol-param': n.protocolParam || '',
        obfs: n.obfs || '',
        'obfs-param': n.obfsParam || '',
      });
    case 'vmess':
      return cleanUndefined({
        ...base,
        type: 'vmess',
        uuid: n.uuid || '',
        alterId: n.alterId ?? 0,
        cipher: n.cipher || 'auto',
        tls: !!n.tls,
        'skip-cert-verify': n.skipCertVerify || undefined,
        servername: n.sni || n.wsHost || undefined,
        network: n.network || 'tcp',
        'ws-opts': n.network === 'ws' && (n.wsPath || n.wsHost)
          ? cleanUndefined({ path: n.wsPath || undefined, headers: n.wsHost ? { Host: n.wsHost } : undefined })
          : undefined,
        'client-fingerprint': n.fingerprint || undefined,
      });
    case 'vless':
      return cleanUndefined({
        ...base,
        type: 'vless',
        uuid: n.uuid || '',
        flow: n.flow || undefined,
        tls: !!n.tls,
        'skip-cert-verify': n.skipCertVerify || undefined,
        servername: n.sni || n.wsHost || undefined,
        network: n.network || 'tcp',
        'ws-opts': n.network === 'ws' && (n.wsPath || n.wsHost)
          ? cleanUndefined({ path: n.wsPath || undefined, headers: n.wsHost ? { Host: n.wsHost } : undefined })
          : undefined,
        'reality-opts': n.extras && n.extras.reality
          ? cleanUndefined({
              'public-key': n.extras.reality.publicKey || undefined,
              'short-id': n.extras.reality.shortId || undefined,
              'spider-x': n.extras.reality.spiderX || undefined,
            })
          : undefined,
        'client-fingerprint': n.fingerprint || undefined,
      });
    case 'trojan':
      return cleanUndefined({
        ...base,
        type: 'trojan',
        password: n.password || '',
        sni: n.sni || n.wsHost || undefined,
        'skip-cert-verify': n.skipCertVerify || undefined,
        network: n.network || 'tcp',
        'ws-opts': n.network === 'ws' && (n.wsPath || n.wsHost)
          ? cleanUndefined({ path: n.wsPath || undefined, headers: n.wsHost ? { Host: n.wsHost } : undefined })
          : undefined,
        'client-fingerprint': n.fingerprint || undefined,
      });
    case 'hysteria':
      return cleanUndefined({
        ...base,
        type: 'hysteria',
        protocol: 'udp',
        up: n.up || '10',
        down: n.down || '50',
        auth: n.auth || n.password || '',
        obfs: n.obfs || undefined,
        sni: n.sni || undefined,
        'skip-cert-verify': n.skipCertVerify || undefined,
        alpn: n.alpn || undefined,
      });
    case 'hysteria2':
      return cleanUndefined({
        ...base,
        type: 'hysteria2',
        password: n.password || '',
        obfs: n.obfs || undefined,
        'obfs-password': n.obfsPassword || undefined,
        sni: n.sni || undefined,
        'skip-cert-verify': n.skipCertVerify || undefined,
        alpn: n.alpn || undefined,
      });
    case 'tuic':
      return cleanUndefined({
        ...base,
        type: 'tuic',
        uuid: n.uuid || '',
        password: n.password || undefined,
        alpn: n.alpn ? n.alpn.split(',') : ['h3'],
        'congestion-controller': n.congestionControl || 'bbr',
        'udp-relay-mode': n.udpRelayMode || 'native',
        sni: n.sni || undefined,
        'skip-cert-verify': n.skipCertVerify || undefined,
      });
    case 'http':
    case 'socks5':
      // 支持经 CF 隧道暴露的 TLS 代理节点
      return cleanUndefined({
        ...base,
        type: n.type,
        username: n.username || undefined,
        password: n.password || undefined,
        tls: n.tls || undefined,
        'skip-cert-verify': n.skipCertVerify || undefined,
        sni: n.sni || undefined,
      });
    default:
      // 未知类型原样透传（保留 extras.clash 中的原始定义）
      if (n.extras && n.extras.clash) return cleanUndefined(n.extras.clash);
      return null;
  }
}

/**
 * 生成 Clash YAML 配置
 * @param {Array} nodes 节点列表（已过滤/去重/排序/重命名）
 * @param {{name?: string, udp?: boolean, selectGroupName?: string, autoGroupName?: string}} opts
 * @param {{config: object, templatesDir: string, store: object}} ctx
 * @returns {Promise<string>} Clash YAML 文本
 */
async function convert(nodes, opts, ctx) {
  const cfg = ctx.config;
  const clashCfg = (cfg.converter && cfg.converter.clash) || {};

  const selectName = opts.selectGroupName || clashCfg.select_group_name || 'PROXY';
  const autoName = opts.autoGroupName || clashCfg.auto_group_name || 'AUTO';
  const urlTest = clashCfg.url_test_url || 'http://www.gstatic.com/generate_204';
  const interval = clashCfg.url_test_interval || 300;

  // 节点 -> Clash proxy 对象
  const proxies = nodes.map((n) => toClashProxy(n, opts)).filter(Boolean);
  const names = proxies.map((p) => p.name);

  // 策略组：AUTO（自动测速）+ PROXY（手动选择，默认指向 AUTO）
  const groups = [
    {
      name: autoName,
      type: 'url-test',
      url: urlTest,
      interval,
      proxies: names,
    },
    {
      name: selectName,
      type: 'select',
      proxies: [autoName, ...names],
    },
  ];

  const proxiesYaml = indentBlock(yaml.dump(cleanUndefined(proxies), { lineWidth: -1 }).trim(), 2);
  const groupsYaml = indentBlock(yaml.dump(cleanUndefined(groups), { lineWidth: -1 }).trim(), 2);

  // 规则：占位符 {{proxy}} 替换为手动选择组名；输出为 YAML 列表项
  const rulesFile = (cfg.converter && cfg.converter.rules_file) || 'rules.tmpl.txt';
  const rulesRaw = await readTemplateFile(rulesFile, ctx);
  const rulesLines = rulesRaw
    .replace(/\{\{proxy\}\}/g, selectName)
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const rules = indentBlock(rulesLines.map((line) => `- ${line}`).join('\n'), 2);

  // 模板渲染
  const templateFile = opts.template || (cfg.converter && cfg.converter.template_file) || 'clash.tmpl.yaml';
  const template = await readTemplateFile(templateFile, ctx);
  const rendered = template
    .replace(/\{\{proxies\}\}/g, proxiesYaml)
    .replace(/\{\{proxy-groups\}\}/g, groupsYaml)
    .replace(/\{\{rules\}\}/g, rules)
    .replace(/\{\{name\}\}/g, opts.name || 'SubBridge');

  return rendered.trim() + '\n';
}

module.exports = { convert, toClashProxy };
