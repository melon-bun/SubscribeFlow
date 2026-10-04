// Resolve links from persisted records; Renderer never supplies an external URL.
async function openSavedLink(core, name, params, openExternal) {
  const key = name === 'content.open' ? 'item_id' : 'subscription_id';
  if (Object.keys(params).length !== 1 || typeof params[key] !== 'string' || !params[key]) throw new Error('需要已保存的记录 ID');
  const record = name === 'content.open'
    ? await core.call('content.get', {item_id: params.item_id})
    : (await core.call('subscription.list', {include_cancelled:true})).find(sub => sub.id === params.subscription_id);
  if (!record) throw new Error('来源不存在');
  const url = new URL(record.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || record.url.length > 2000) throw new Error('原文链接无效');
  await openExternal(url.href);
  return {opened:true};
}
module.exports = {openSavedLink};
