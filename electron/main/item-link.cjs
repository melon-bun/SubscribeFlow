// Used only by channel-private APIs, with each channel supplying its URL parser.
async function expandItemLink(raw, parse, fetch, signal, ErrorType) {
  let current = parse(raw), seen = new Set();
  for (let hop = 0; current.short; hop++) {
    signal?.throwIfAborted();
    if (hop >= 5 || seen.has(current.url)) throw new ErrorType('INVALID_INPUT', '短链接跳转过多或循环，请使用完整内容链接');
    seen.add(current.url);
    let response;
    try { response = await fetch(current.url, {method:'GET',redirect:'manual',credentials:'include',signal}); }
    catch (error) {
      signal?.throwIfAborted();
      throw new ErrorType('ACCESS_FAILED', '短链接展开失败，请稍后重试或使用完整链接');
    }
    await response.body?.cancel();
    if (response.status === 429) throw new ErrorType('RATE_LIMITED','平台访问过于频繁，请稍后重试');
    if (![301,302,303,307,308].includes(response.status) || !response.headers.get('location'))
      throw new ErrorType('INVALID_INPUT', '短链接未提供有效的内容跳转，请使用完整内容链接');
    try { current = parse(new URL(response.headers.get('location'),current.url).href); }
    catch(error) {
      if(error instanceof ErrorType) throw error;
      throw new ErrorType('INVALID_INPUT','短链接返回了无效跳转地址');
    }
  }
  signal?.throwIfAborted();
  return current;
}
module.exports = {expandItemLink};
