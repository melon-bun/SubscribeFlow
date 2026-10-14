'use strict';
/**
 * M17 启动失败分类（BUG-082）。
 *
 * 顶层 catch 过去丢弃 error 对象，把任何内部代码异常都说成「资源无法读取，
 * 请重新解压」，导致真实根因完全不可见。这里把分类与脱敏做成可单测的纯函数：
 * 资源读取故障才提示重新解压，内部代码异常如实说明并给出诊断入口。
 */

/** 只保留可能有助于定位的形状，绝不记录配置内容、请求头或密钥。 */
function redact(message) {
  return String(message || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key|token|secret|password)[\s:=]+\S+/gi, '$1=[redacted]')
    .slice(0, 500);
}

function redactStack(stack) {
  return String(stack || '')
    .split('\n')
    .slice(0, 8)
    .map((line) => redact(line.replace(/[A-Za-z]:\\[^\s)]+/g, '<path>')))
    .join('\n');
}

// 只有「应用自身资源读取不到」才提示重新解压。磁盘满、权限不足、目标卷未挂载
// 都是环境问题，重新解压没有用——把它们混进资源损坏会让用户白折腾。
const RESOURCE_CODES = new Set(['ENOENT']);
const ENVIRONMENT_CODES = new Set(['EACCES', 'EPERM', 'EMFILE', 'ENOSPC', 'EBUSY', 'EROFS', 'ETARGETMOUNT']);
const ENVIRONMENT_HINTS = {
  EACCES: '当前进程没有读取该路径的权限。请检查文件权限后重试。',
  EPERM: '当前进程没有该路径的操作权限。请检查文件权限后重试。',
  EMFILE: '进程打开的文件过多。请关闭其他程序后重试。',
  ENOSPC: '磁盘空间不足，无法读取所需数据。请清理空间后重试。',
  EBUSY: '相关文件正被占用。请退出其他知流进程后重试。',
  EROFS: '所在磁盘为只读，无法读取所需数据。',
  ETARGETMOUNT: '目标卷未挂载，无法读取所需数据。',
};

/**
 * 判断是不是「应用资源读取故障」——只有这类才建议重新解压。
 * 代码异常（例如调用了不存在的 API）必须区别对待。
 */
function classifyStartupFailure(error) {
  const code = (error && error.code) || null;
  const message = redact(error && error.message);
  if (code && RESOURCE_CODES.has(code)) {
    return {
      kind: 'resource',
      code,
      message,
      stack: redactStack(error && error.stack),
      title: '知流无法启动',
      detail: '应用资源无法读取，请重新解压完整应用。应用数据目录中的订阅与内容会保留。',
    };
  }
  if (code && ENVIRONMENT_CODES.has(code)) {
    return {
      kind: 'environment',
      code,
      message,
      stack: redactStack(error && error.stack),
      title: '知流无法启动',
      detail: ENVIRONMENT_HINTS[code] || '启动所需的文件暂时不可访问，请检查系统环境后重试。',
    };
  }
  if (error && (error.name === 'TypeError' || error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    return {
      kind: 'code',
      code,
      name: error.name,
      message,
      stack: redactStack(error && error.stack),
      title: '知流启动失败',
      detail: '应用内部出现程序错误，这不是资源解压问题。请把诊断信息反馈给开发者。',
    };
  }
  return {
    kind: 'unknown',
    code,
    name: (error && error.name) || null,
    message,
    stack: redactStack(error && error.stack),
    title: '知流启动失败',
    detail: '启动过程中出现未知错误。请查看诊断目录中的启动日志以定位原因。',
  };
}

/** 供诊断日志使用的脱敏记录。 */
function startupFailureRecord(error, phase) {
  const classified = classifyStartupFailure(error);
  return {
    event: 'app.startup.failed',
    phase: phase || 'start',
    kind: classified.kind,
    code: classified.code || null,
    name: classified.name || null,
    message: classified.message,
    stack: classified.stack,
  };
}

module.exports = {classifyStartupFailure, startupFailureRecord, redact, redactStack};
