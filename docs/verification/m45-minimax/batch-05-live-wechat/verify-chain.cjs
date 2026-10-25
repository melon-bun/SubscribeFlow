#!/usr/bin/env node
/**
 * 用 Node 的 X509Certificate 逐跳验签：叶子 ← YE1 ← 根，并打印服务端实际下发的链。
 * 只打印公开证书信息。
 */

'use strict';

const tls = require('node:tls');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HOST = 'data.wxrank.com';
const DIR = __dirname;
const CHAIN = path.join(DIR, 'wxrank-chain');

function cn(name) {
  if (!name) return '';
  if (typeof name === 'string') {
    const match = name.match(/CN=([^,/]+)/);
    return match ? match[1].trim() : name.trim();
  }
  if (Array.isArray(name)) {
    const part = name.find((item) => Object.prototype.hasOwnProperty.call(item, 'CN'));
    return part ? part.CN : '';
  }
  return '';
}

function load(name) {
  const file = path.join(CHAIN, name);
  if (!fs.existsSync(file)) return null;
  return new crypto.X509Certificate(fs.readFileSync(file));
}

function findRoot(cnWanted) {
  const roots = (require('node:tls').rootCertificates || [])
    .map((pem) => {
      try {
        return new crypto.X509Certificate(pem);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
  return roots.find((x509) => cn(x509.subject) === cnWanted) || null;
}

function main() {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: HOST, port: 443, servername: HOST }, () => {
      const peer = socket.getPeerCertificate(true);
      const chain = Array.isArray(peer) ? peer : [peer];
      console.log(`服务端下发证书链长度: ${chain.length}`);
      chain.forEach((cert, index) => {
        const x509 = new crypto.X509Certificate(cert.raw);
        console.log(
          `  [${index}] ${cn(x509.subject)} <- ${cn(x509.issuer)}  (${x509.validFrom} → ${x509.validTo})`
        );
      });
      console.log(`Node 默认校验: authorized=${socket.authorized} error=${socket.authorizationError || '无'}`);

      const leaf = chain.length ? new crypto.X509Certificate(chain[0].raw) : null;
      const aia = load('aia-intermediate.pem');
      console.log('\n--- 材料验签 ---');
      if (leaf) {
        console.log(`叶子 subject=${cn(leaf.subject)} issuer=${cn(leaf.issuer)}`);
      }
      if (aia) {
        console.log(`AIA 中间证书 subject=${cn(aia.subject)} issuer=${cn(aia.issuer)}`);
        if (leaf) {
          try {
            console.log(`叶子 ← AIA中间: ${leaf.verify(aia.publicKey)}`);
          } catch (error) {
            console.log(`叶子 ← AIA中间: 验签异常 ${error.message}`);
          }
        }
        for (const rootName of ['ISRG Root X1', 'ISRG Root X2']) {
          const root = findRoot(rootName);
          if (!root) {
            console.log(`  Node 信任库里没有 ${rootName}`);
            continue;
          }
          try {
            console.log(`AIA中间 ← ${rootName}: ${aia.verify(root.publicKey)}`);
          } catch (error) {
            console.log(`AIA中间 ← ${rootName}: 验签异常 ${error.message}`);
          }
        }
      } else {
        console.log('没有 aia-intermediate.pem（先跑 fetch-aia.py）');
      }
      socket.end();
      resolve();
    });
    socket.on('error', (error) => {
      console.log(`连接失败: ${error.code || ''} ${error.message}`);
      resolve();
    });
  });
}

main();
