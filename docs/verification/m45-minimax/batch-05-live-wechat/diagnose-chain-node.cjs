#!/usr/bin/env node
/**
 * 诊断 data.wxrank.com 的 TLS 证书链（不带密钥、不调用付费接口）。
 *
 * 输出：
 * 1. 服务端实际下发的证书链（逐张的 subject / issuer CN、有效期、SHA-256 指纹）
 * 2. Node 自带信任库里能否找到该签发者
 * 3. 用 Node 的 X509Certificate 验签能力逐跳验签（叶子 ← 中间 ← 根）
 *
 * 只打印证书公开信息，不打印任何凭据。
 */

'use strict';

const tls = require('node:tls');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HOST = 'data.wxrank.com';
const OUT = __dirname;

function cn(name) {
  if (!name) return '';
  if (typeof name === 'string') {
    const match = name.match(/CN=([^,/]+)/);
    return match ? match[1].trim() : name.trim();
  }
  if (Array.isArray(name)) {
    const part = name.find((item) => Object.prototype.hasOwnProperty.call(item, 'CN'));
    return part ? part.CN : name.map((item) => Object.values(item).join('')).join('/');
  }
  return '';
}

function fp(der) {
  return crypto.createHash('sha256').update(der).digest('hex');
}

function describe(label, x509) {
  console.log(`  ${label}`);
  console.log(`    subjectCN : ${cn(x509.subject)}`);
  console.log(`    issuerCN  : ${cn(x509.issuer)}`);
  console.log(`    validFrom : ${x509.validFrom}`);
  console.log(`    validTo   : ${x509.validTo}`);
  console.log(`    sha256    : ${fp(x509.raw)}`);
  console.log(`    selfSigned: ${cn(x509.subject) === cn(x509.issuer)}`);
  return x509;
}

function main() {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: HOST, port: 443, servername: HOST, rejectUnauthorized: false },
      () => {
        const peer = socket.getPeerCertificate(true);
        const chain = Array.isArray(peer) ? peer : [peer];
        console.log(`服务端下发证书链长度: ${chain.length}`);
        const parsed = chain.map((cert) => new crypto.X509Certificate(cert.raw));

        parsed.forEach((x509, index) => describe(`[${index}]`, x509));

        // 落盘，便于 Python 侧复用同一份材料
        parsed.forEach((x509, index) => {
          fs.writeFileSync(path.join(OUT, 'wxrank-chain', `sent-${index}.pem`), x509.toString() + '\n');
        });

        const leaf = parsed[0];
        const issuerCn = cn(leaf.issuer);

        // Node 自带信任库里找签发者
        const roots = require('node:tls').rootCertificates || [];
        let rootsParsed = [];
        try {
          rootsParsed = roots.map((pem) => new crypto.X509Certificate(pem));
        } catch (error) {
          console.log(`  解析 Node 信任库失败: ${error.message}`);
        }
        const issuerHits = rootsParsed.filter((x509) => cn(x509.subject) === issuerCn);
        console.log(`Node 信任库证书数: ${rootsParsed.length}`);
        console.log(`信任库中 subjectCN == ${issuerCn} 的条目: ${issuerHits.length}`);

        // 逐跳验签：叶子 ← 链上下一张
        for (let i = 0; i < parsed.length - 1; i += 1) {
          const child = parsed[i];
          const parent = parsed[i + 1];
          const ok = child.verify(parent.publicKey);
          console.log(`验签 ${cn(child.subject)} ← ${cn(parent.subject)}: ${ok}`);
        }

        // 若链里缺中间证书，找信任库里能否签发叶子
        if (parsed.length === 1) {
          const signers = rootsParsed.filter((x509) => {
            try {
              return leaf.verify(x509.publicKey);
            } catch (error) {
              return false;
            }
          });
          console.log(`信任库中可直接签发叶子的条目: ${signers.length}`);
          signers.forEach((x509) => describe('    signer', x509));
        }

        socket.end();
        resolve();
      }
    );
    socket.on('error', (error) => {
      console.log(`连接失败: ${error.message}`);
      resolve();
    });
  });
}

main();
