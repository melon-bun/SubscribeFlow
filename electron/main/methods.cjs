const CORE_METHODS = new Set([
  'channel.list', 'connection.list', 'connection.check', 'source.resolve', 'source.search',
  'subscription.list', 'subscription.add', 'subscription.update', 'sync.start', 'sync.cancel',
  'sync.retry', 'sync.get', 'sync.list', 'sync.coverage', 'content.list', 'content.calendar', 'content.get',
  'content.update', 'content.bulk_update', 'priority.set_source',
  'tag.list', 'tag.get', 'tag.create', 'tag.update', 'tag.set_enabled', 'tag.remove', 'tag.contents',
  'content.set_tags', 'content.bulk_set_tags',
  'source.list', 'intake.start', 'intake.get', 'intake.cancel', 'intake.save',
  'schedule.list', 'schedule.status',
  // M16 自动打标：任务状态、失败重试与用户主动补打。只读状态与排队动作，
  // 不接受也不返回任何密钥；连接测试只用 Core 内存里的凭据，结果只有成败。
  'tagging.status', 'tagging.test', 'tagging.tasks', 'tagging.retry',
  'tagging.backfill_preview', 'tagging.backfill',
  // M25 公共 AI 层：连接列表与协议最小探针。只读配置与探针，
  // 不接受也不返回任何密钥；连接的新增／修改／删除走设置桥接的受控方法。
  'ai.provider.list', 'ai.provider.test',
]);
// settings.* 与 notification.* 刻意不在这里：它们必须经过 Main 的 UI 方法，
// 先加密保存密钥再向 Core 提交引用。放进白名单等于让 Renderer 绕过凭据编排。
const DESKTOP_METHODS = new Set(['core.status', 'core.restart', 'content.open', 'source.open', 'connection.login']);
module.exports = { CORE_METHODS, DESKTOP_METHODS };
