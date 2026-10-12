const CORE_METHODS = new Set([
  'channel.list', 'connection.list', 'connection.check', 'source.resolve', 'source.search',
  'subscription.list', 'subscription.add', 'subscription.update', 'sync.start', 'sync.cancel',
  'sync.retry', 'sync.get', 'sync.list', 'sync.coverage', 'content.list', 'content.calendar', 'content.get',
  'content.update', 'content.bulk_update', 'priority.set_source',
  'tag.list', 'tag.get', 'tag.create', 'tag.update', 'tag.set_enabled', 'tag.remove', 'tag.contents',
  'content.set_tags', 'content.bulk_set_tags',
  'source.list', 'intake.start', 'intake.get', 'intake.cancel', 'intake.save',
  'schedule.list', 'schedule.status',
]);
// settings.* 与 notification.* 刻意不在这里：它们必须经过 Main 的 UI 方法，
// 先加密保存密钥再向 Core 提交引用。放进白名单等于让 Renderer 绕过凭据编排。
const DESKTOP_METHODS = new Set(['core.status', 'core.restart', 'content.open', 'source.open', 'connection.login']);
module.exports = { CORE_METHODS, DESKTOP_METHODS };
