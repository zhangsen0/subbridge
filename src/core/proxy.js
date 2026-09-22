'use strict';

/**
 * 统一节点模型 Proxy
 *
 * 所有协议解析器（ss/ssr/vmess/vless/trojan/hysteria/hysteria2/tuic/clash/v2ray）
 * 都输出该结构；所有转换器（clash/sing-box/links/v2ray）据此生成目标格式。
 * 新增协议字段时：在构造函数中补充默认值即可，不影响已有协议。
 */
class Proxy {
  constructor(fields = {}) {
    this.name = fields.name || '';              // 节点名称
    this.type = fields.type || '';              // 协议类型：ss/ssr/vmess/vless/trojan/hysteria/hysteria2/tuic/http/socks5
    this.server = fields.server || '';          // 服务器地址
    this.port = fields.port || 0;               // 服务器端口
    this.uuid = fields.uuid || '';              // vmess/vless/tuic 的 uuid
    this.password = fields.password || '';      // ss/trojan/hysteria2/tuic 的密码
    this.cipher = fields.cipher || '';          // ss/vmess 的加密方式
    this.protocol = fields.protocol || '';      // ssr 协议
    this.obfs = fields.obfs || '';              // ssr 混淆 / hysteria 混淆类型
    this.obfsParam = fields.obfsParam || '';    // ssr 混淆参数
    this.protocolParam = fields.protocolParam || ''; // ssr 协议参数
    this.alterId = fields.alterId ?? 0;         // vmess alterId
    this.network = fields.network || '';        // 传输方式：tcp/ws/grpc/http
    this.wsPath = fields.wsPath || '';          // ws/grpc 路径
    this.wsHost = fields.wsHost || '';          // ws Host 头
    this.tls = !!fields.tls;                    // 是否启用 TLS
    this.sni = fields.sni || '';                // TLS SNI
    this.skipCertVerify = !!fields.skipCertVerify; // 跳过证书校验
    this.fingerprint = fields.fingerprint || '';    // TLS 指纹（client-fingerprint）
    this.alpn = fields.alpn || '';              // ALPN，逗号分隔字符串
    this.flow = fields.flow || '';              // vless flow（xtls-rprx-vision 等）
    this.up = fields.up || '';                  // hysteria 上行带宽（Mbps）
    this.down = fields.down || '';              // hysteria 下行带宽（Mbps）
    this.auth = fields.auth || '';              // hysteria 认证密钥
    this.obfsPassword = fields.obfsPassword || ''; // hysteria2 混淆密码
    this.congestionControl = fields.congestionControl || ''; // tuic 拥塞控制
    this.udpRelayMode = fields.udpRelayMode || ''; // tuic udp 中继模式
    this.udp = fields.udp ?? true;              // 是否启用 udp
    this.group = fields.group || '';            // 订阅分组（ssr 等）
    this.raw = fields.raw || '';                // 原始分享链接（links 目标格式输出用）
    this.extras = fields.extras || {};          // 协议特有扩展字段（如 reality、plugin）
  }
}

module.exports = Proxy;
