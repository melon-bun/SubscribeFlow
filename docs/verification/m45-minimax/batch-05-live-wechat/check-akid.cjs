#!/usr/bin/env node
/**
 * 深挖：叶子与 ISRG Root X1/X2 的 AKID/SKID、指纹对比、服务端是否换证书。
 * 只打印公开证书信息。
 */

'use strict';

const tls = require('node:tls');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HOST = 'data.wxrank.com';
const DIR = path.join(__dirname, 'wxrank-chain');

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

function fp(x509) {
  return crypto.createHash('sha256').update(x509.raw).digest('hex');
}

function nodeRoots() {
  return (require('node:tls').rootCertificates || [])
    .map((pem) => {
      try {
        return new crypto.X509Certificate(pem);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

function once(index) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: HOST, port: 443, servername: HOST }, () => {
      const peer = socket.getPeerCertificate(true);
      const chain = Array.isArray(peer) ? peer : [peer];
      const leaf = new crypto.X509Certificate(chain[0].raw);
      console.log(`  [${index}] 链长=${chain.length} 叶子=${cn(leaf.subject)}<-${cn(leaf.issuer)}`);
      console.log(`       叶子指纹=${fp(leaf)}`);
      console.log(`       叶子 AKID=${leaf.authorityKeyIdentifier || '无'}`);
      console.log(`       叶子 SKID=${leaf.subjectKeyIdentifier || '无'}`);
      console.log(`       authorized=${socket.authorized} error=${socket.authorizationError || '无'}`);
      socket.end();
      resolve(leaf);
    });
    socket.on('error', (error) => {
      console.log(`  [${index}] 失败 ${error.code || ''} ${error.message}`);
      resolve(null);
    });
  });
}

(async () => {
  console.log('--- 服务端证书稳定性（多次连接）---');
  const leaves = [];
  for (let i = 0; i < 4; i += 1) {
    leaves.push(await once(i));
  }
  const prints = new Set(leaves.filter(Boolean).map(fp));
  console.log(`不同叶子指纹数: ${prints.size}`);

  console.log('\n--- Node 信任库中的 ISRG 根 ---');
  for (const root of nodeRoots().filter((x509) => cn(x509.subject).startsWith('ISRG'))) {
    console.log(`  ${cn(root.subject)}  指纹=${fp(root)}  SKID=${root.subjectKeyIdentifier || '无'}`);
  }

  console.log('\n--- certifi 中的 ISRG 根（用本地 certifi 路径）---');
  const certifiPath = '/Library/Frameworks/Python.framework/Versions/3.12/lib/python3.12/site-packages/certifi/cacert.pem';
  for (const candidate of [certifiPath, '/usr/local/lib/python3.12/site-packages/certifi/cacert.pem']) {
    if (!fs.existsSync(candidate)) continue;
    const text = fs.readFileSync(candidate, 'utf8');
    const marker = '-----BEGIN CERTIFICATE-----';
    text.split(marker).slice(1).forEach((part, index) => {
      const pem = marker + part.split('-----END CERTIFICATE-----')[0] + '-----END CERTIFICATE-----\n';
      let x509;
      try {
        x509 = new crypto.X509Certificate(pem);
      } catch (error) {
        return;
      }
      if (!cn(x509.subject).startsWith('ISRG')) return;
      console.log(`  ${cn(x509.subject)}  指纹=${fp(x509)}  SKID=${x509.subjectKeyIdentifier || '无'}`);
      if (leaves[0]) {
        let ok = false;
        try {
          ok = leaves[0].verify(x509.publicKey);
        } catch (error) {
          ok = `异常`;
        }
        console.log(`       叶子 ← 该根: ${ok}`);
      }
    });
    break;
  }

  const leaf = leaves[0];
  if (leaf) {
    console.log('\n--- 叶子与根的 AKID/SKID 对照 ---');
    for (const root of nodeRoots().filter((x509) => cn(x509.subject).startsWith('ISRG'))) {
      console.log(
        `  ${cn(root.subject)}: 根SKID=${root.subjectKeyIdentifier || '无'} 叶子AKID=${leaf.authorityKeyIdentifier || '无'} 匹配=${
          root.subjectKeyIdentifier && leaf.authorityKeyIdentifier
            ? root.subjectKeyIdentifier === leaf.authorityKeyIdentifier
            : '未知'
        }`
      );
    }
  }
})();
