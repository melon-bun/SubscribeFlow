#!/usr/bin/env node
/**
 * 签名级核对：叶子分别能否被 ISRG Root X1 / X2 / YE1 的公钥验证。
 * 只打印公开证书信息。
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CHAIN = path.join(__dirname, 'wxrank-chain');

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

function load(file) {
  const full = path.join(CHAIN, file);
  if (!fs.existsSync(full)) return null;
  return new crypto.X509Certificate(fs.readFileSync(full));
}

function rootByCn(wanted) {
  return (require('node:tls').rootCertificates || [])
    .map((pem) => {
      try {
        return new crypto.X509Certificate(pem);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean)
    .find((x509) => cn(x509.subject) === wanted);
}

const leaf = load('leaf.pem');
const ye1 = load('aia-intermediate.pem');

console.log('叶子 :', leaf ? `${cn(leaf.subject)} <- ${cn(leaf.issuer)}` : '缺失');
console.log('YE1  :', ye1 ? `${cn(ye1.subject)} <- ${cn(ye1.issuer)}` : '缺失');

if (leaf) {
  for (const name of ['ISRG Root X1', 'ISRG Root X2']) {
    const root = rootByCn(name);
    if (!root) {
      console.log(`  叶子 ← ${name}: Node 信任库里没有`);
      continue;
    }
    let ok = false;
    try {
      ok = leaf.verify(root.publicKey);
    } catch (error) {
      ok = `异常 ${error.message}`;
    }
    console.log(`  叶子 ← ${name}: ${ok}`);
  }
  if (ye1) {
    console.log(`  叶子 ← YE1: ${leaf.verify(ye1.publicKey)}`);
  }
}

if (ye1) {
  for (const name of ['ISRG Root X1', 'ISRG Root X2']) {
    const root = rootByCn(name);
    if (!root) continue;
    let ok = false;
    try {
      ok = ye1.verify(root.publicKey);
    } catch (error) {
      ok = `异常 ${error.message}`;
    }
    console.log(`  YE1 ← ${name}: ${ok}`);
  }
  console.log(`  YE1 自签: ${cn(ye1.subject) === cn(ye1.issuer)}`);
}
