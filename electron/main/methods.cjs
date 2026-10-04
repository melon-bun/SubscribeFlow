const CORE_METHODS = new Set([
  'channel.list', 'connection.list', 'connection.check', 'source.resolve', 'source.search',
  'subscription.list', 'subscription.add', 'subscription.update', 'sync.start', 'sync.cancel',
  'sync.retry', 'sync.get', 'sync.list', 'sync.coverage', 'content.list', 'content.get',
  'content.update', 'content.bulk_update',
]);
const DESKTOP_METHODS = new Set(['core.status', 'core.restart', 'content.open', 'source.open', 'connection.login']);
module.exports = { CORE_METHODS, DESKTOP_METHODS };
