#!/usr/bin/env node
/**
 * 重复探测上游 TLS：默认校验是否通过、服务端下发的链长度（不带密钥、不调付费接口）。
 */

'use strict';

const tls = require('node:tls');

const HOST = 'data.wxrank.com';
const ROUNDS = 5;

function once(index) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: HOST, port: 443, servername: HOST }, () => {
      const peer = socket.getPeerCertificate(true);
      const chain = Array.isArray(peer) ? peer : [peer];
      const cn = (name) => {
        if (!name) return '';
        if (typeof name === 'string') {
          const match = name.match(/CN=([^,/]+)/);
          return match ? match[1].trim() : name.trim();
        }
        const part = name.find((item) => Object.prototype.hasOwnProperty.call(item, 'CN'));
        return part ? part.CN : '';
      };
      console.log(`  [${index}] 默认校验通过; 链长=${chain.length} leafIssuer=${cn(chain[0].issuer)}`);
      socket.end();
      resolve();
    });
    socket.on('error', (error) => {
      console.log(`  [${index}] 失败 ${error.code || ''} ${error.message}`);
      resolve();
    });
  });
}

(async () => {
  for (let i = 0; i < ROUNDS; i += 1) {
    await once(i);
  }
})();
