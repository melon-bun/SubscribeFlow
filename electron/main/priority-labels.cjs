'use strict';
/**
 * M20 优先级显示名（主进程侧）。
 *
 * 提醒通知与托盘菜单的文案在主进程生成，而名称来自 Core 的设置分区。
 * 这里只保存「当前显示名」：统计口径始终按稳定等级（high/medium/low）计算，
 * 改名不会改任何计数，也不影响提醒周期与打标任务。
 *
 * 名称只用于显示，因此这里做宽松归一：拿不到或被写坏就退回默认名，
 * 不让提醒文案因为一个显示项而空掉。
 */
const DEFAULT_PRIORITY_NAMES = {
  high: '高优先级',
  medium: '中优先级',
  low: '低优先级',
};

const LEVELS = Object.keys(DEFAULT_PRIORITY_NAMES);

/** 把 Core 给回的名字整理成完整的三级映射，缺项用默认名补齐。 */
function normalizePriorityNames(names) {
  const result = Object.assign({}, DEFAULT_PRIORITY_NAMES);
  if (!names || typeof names !== 'object') return result;
  for (const level of LEVELS) {
    const value = names[level];
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (name) result[level] = name;
  }
  return result;
}

class PriorityLabels {
  constructor() {
    this.names = Object.assign({}, DEFAULT_PRIORITY_NAMES);
  }

  /** 应用新名称；返回归一后的完整映射。 */
  apply(names) {
    this.names = normalizePriorityNames(names);
    return this.names;
  }

  /** 某一级的显示名。未知等级回落到等级 id 本身，不猜名字。 */
  label(level) {
    return this.names[level] || DEFAULT_PRIORITY_NAMES[level] || level;
  }

  /** 高优先级显示名：提醒与托盘文案只用到这一档。 */
  get high() {
    return this.label('high');
  }
}

module.exports = {PriorityLabels, DEFAULT_PRIORITY_NAMES, normalizePriorityNames, LEVELS};
