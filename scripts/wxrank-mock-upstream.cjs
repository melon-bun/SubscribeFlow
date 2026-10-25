/**
 * M45 公众号付费渠道（wxrank）的本机假上游。
 *
 * 真实付费上游 data.wxrank.com 在本机没有授权密钥，因此用这个本机服务复刻它的
 * 响应形状，让产品的真实传输层（urllib + 真 JSON 请求体 + 真超时／重定向拒绝）
 * 跑通整条链路。它是模拟器，不是真实上游，证据里必须这么写。
 *
 * 纪律：运行时密钥只出现在请求体里。这里只记 hasKey／keyLength，绝不记密钥原文，
 * 也不打印请求体全文。
 */
const http = require('node:http');

const BIZ = 'MzI4NTEyMzQ1Ng==';
const LOW_BALANCE_BIZ = 'LOWBALANCE000000';
const CHKSM = 'cc47af0e';
const PIC_URL = 'https://mmbiz.qpic.cn/sz_mmbiz_jpg/demo/640?wxtype=jpeg&amp;wxfrom=0';
const UNSUPPORTED = {code: 1004, msg: 'mock: 只支持 /weixin/getinfo 与 /weixin/getps'};

const ACCOUNT = {
  name: '真实形态公众号',
  user_name: 'gh_demo0001',
  signature: '一份关于设计与工具的公众号',
  hd_head_img: 'http://mmbiz.qpic.cn/mmbiz_png/demo/0?wx_fmt=png',
};

// 一页是一次推送的十篇：第 1 条头条、第 2 条副条，其余条目同属这次推送。
// 末页用空列表表示服务端数据集已扫完。
const PAGES = [
  {from: null, cursor: 'C1', mid: '1000000001'},
  {from: 'C1', cursor: 'C2', mid: '1000000101'},
  {from: 'C2', cursor: 'C3', mid: '1000000201'},
  {from: 'C3', cursor: '', mid: '1000000201', empty: true},
];

function pubTime(idx) {
  const minutes = 10 * 60 + 15 + (idx - 1);
  const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
  const minute = String(minutes % 60).padStart(2, '0');
  return `2026-10-23 ${hour}:${minute}:00`;
}

function snOf(mid, idx) {
  return (BigInt(mid) + BigInt(idx)).toString(16).padStart(8, '0');
}

function buildList(mid) {
  const items = [];
  for (let idx = 1; idx <= 10; idx += 1) {
    const sn = snOf(mid, idx);
    items.push({
      pub_time: pubTime(idx),
      title: `真实形态样本 ${mid}-${idx}`,
      sn,
      art_url: ('http://mp.weixin.qq.com/s?__biz=' + BIZ
        + '&amp;mid=' + mid + '&amp;idx=' + idx + '&amp;sn=' + sn
        + '&amp;chksm=' + CHKSM + '&amp;scene=126#rd'),
      pic_url: PIC_URL,
    });
  }
  return items;
}

function getinfoDocument(payload) {
  if (payload.biz === LOW_BALANCE_BIZ) {
    return {code: 1000, msg: '剩余0积分（充值积分 https://data.wxrank.com）'};
  }
  return {code: 0, msg: '数据获取成功，剩余120积分', data: ACCOUNT};
}

function getpsDocument(cursor) {
  const page = PAGES.find((item) => item.from === cursor);
  if (!page) return {code: 1003, msg: 'cursor校验失败'};
  return {
    code: 0,
    msg: '剩余32653积分',
    data: {
      wxid: ACCOUNT.user_name,
      cursor: page.cursor,
      list: page.empty ? [] : buildList(page.mid),
    },
  };
}

function parsePayload(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // 坏请求体按「没有字段」处理，让路由决定答复，不猜上游语义。
    return {};
  }
}

function summarise(path, payload) {
  const key = typeof payload.key === 'string' ? payload.key : '';
  return {
    path,
    hasKey: key.length > 0,
    keyLength: key.length,
    biz: payload.biz === undefined ? null : payload.biz,
    wxid: payload.wxid === undefined ? null : payload.wxid,
    cursor: payload.cursor === undefined ? null : payload.cursor,
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function respond(response, status, document) {
  const body = Buffer.from(JSON.stringify(document), 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  response.end(body);
}

async function startUpstream(options = {}) {
  const requests = [];
  const requested = Number(options.port === undefined ? 0 : options.port);
  const port = Number.isInteger(requested) && requested >= 0 ? requested : 0;

  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method !== 'POST') {
      requests.push(summarise(pathname, {}));
      respond(response, 404, UNSUPPORTED);
      return;
    }
    let payload = {};
    try {
      payload = parsePayload(await readBody(request));
    } catch {
      payload = {};
    }
    requests.push(summarise(pathname, payload));

    if (pathname === '/weixin/getinfo') {
      respond(response, 200, getinfoDocument(payload));
      return;
    }
    if (pathname === '/weixin/getps') {
      const cursor = typeof payload.cursor === 'string' && payload.cursor !== '' ? payload.cursor : null;
      respond(response, 200, getpsDocument(cursor));
      return;
    }
    respond(response, 200, UNSUPPORTED);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const actual = server.address().port;
  return {
    base: `http://127.0.0.1:${actual}`,
    port: actual,
    requests,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      // urllib 的连接池会留着长连接，不主动断掉的话 close 永远不回调。
      server.closeAllConnections();
    }),
  };
}

module.exports = {startUpstream, ACCOUNT};

if (require.main === module) {
  startUpstream({port: Number(process.argv[2]) || 0}).then((upstream) => {
    console.log(`WXrank mock upstream: ${upstream.base}`);
  });
}
