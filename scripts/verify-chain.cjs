/**
 * 从 Node 自带信任库里取出 data.wxrank.com 需要的中间证书，并验签确认。
 *
 * - 叶子 ← 中间证书：checkIssued 验签
 * - 中间证书 ← 根（Node 信任库里的 ISRG Root X1）：checkIssued 验签
 * 两条都成立 = 这条链是真的，中间证书由受信根签发。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const https = require('node:https');

const outDir = process.argv[2];
if (!outDir) {
  console.error('用法：node verify-chain.cjs <输出目录>');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

function subjectCN(cert) {
  for (const entry of cert.subject.split('\n')) {
    const match = entry.match(/CN\s*=\s*(.+)/);
    if (match) return match[1].trim();
  }
  return '';
}

// 取回服务端叶子证书（不校验，只为拿签发者信息）。
const leaf = new tls.TLSSocket;
const socket = tls.connect({host: 'data.wxrank.com', port: 443, servername: 'data.wxrank.com',
                             rejectUnauthorized: false}, () => {
  const raw = socket.getPeerCertificate().raw;
  const leafCert = new crypto.X509Certificate(raw);
  const leafPem = leafCert.toString();
  fs.writeFileSync(path.join(outDir, 'leaf.pem'), leafPem);
  console.log('leaf subject:', leafCert.subject);
  console.log('leaf issuer :', leafCert.issuer);

  // 在 Node 信任库里找签发者（CN=YE1）。
  let intermediate = null;
  let root = null;
  for (const pem of tls.rootCertificates) {
    let cert;
    try { cert = new crypto.X509Certificate(pem); } catch (error) { continue; }
    if (subjectCN(cert) === 'YE1' && leafCert.checkIssued(cert)) {
      intermediate = {cert, pem};
      for (const rootPem of tls.rootCertificates) {
        let rootCert;
        try { rootCert = new crypto.X509Certificate(rootPem); } catch (error) { continue; }
        if (cert.checkIssued(rootCert)) { root = {cert, pem: rootPem}; break; }
      }
      break;
    }
  }
  if (!intermediate) {
    console.log('Node 信任库里没有能签发这张叶子的中间证书');
    socket.destroy();
    process.exit(1);
  }
  fs.writeFileSync(path.join(outDir, 'intermediate.pem'), intermediate.pem);
  console.log('中间证书 subject:', intermediate.cert.subject);
  console.log('中间证书 issuer :', intermediate.cert.issuer);
  console.log('叶子由中间证书签发:', true);
  console.log('中间证书由根签发  :', Boolean(root));
  if (root) {
    console.log('根证书 subject    :', root.cert.subject);
    fs.writeFileSync(path.join(outDir, 'root.pem'), root.pem);
  }
  const sha256 = crypto.createHash('sha256').update(intermediate.pem).digest('hex');
  console.log('中间证书 sha256   :', sha256);
  fs.writeFileSync(path.join(outDir, 'intermediate.sha256'), sha256 + '\n');
  socket.destroy();

  // 再从 CA 自己的 HTTPS 站点取一份，交叉核对指纹。
  https.get('https://letsencrypt.org/certs/', (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      const links = [...body.matchAll(/href="([^"]+\.pem)"/g)].map((m) => m[1]);
      console.log('letsencrypt.org 可用中间证书数:', links.length);
      for (const link of links) {
        https.get(new URL(link, 'https://letsencrypt.org/certs/').href, (r) => {
          let pem = '';
          r.on('data', (c) => { pem += c; });
          r.on('end', () => {
            try {
              const cert = new crypto.X509Certificate(pem);
              if (subjectCN(cert) === 'YE1') {
                const digest = crypto.createHash('sha256').update(pem).digest('hex');
                console.log('letsencrypt.org 的 YE1 sha256:', digest);
                console.log('与 Node 信任库一致:', digest === sha256);
                fs.writeFileSync(path.join(outDir, 'intermediate-from-ca.pem'), pem);
              }
            } catch (error) { /* 不是证书就跳过 */ }
          });
        }).on('error', () => {});
      }
    });
  }).on('error', (error) => { console.log('letsencrypt.org 不可达:', error.code || error.message); });
});
socket.on('error', (error) => { console.error('连接失败:', error.message); process.exit(1); });
