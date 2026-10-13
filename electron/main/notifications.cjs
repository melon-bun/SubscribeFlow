'use strict';
/**
 * M15 桌面通知的最小能力：设置页要能说明「这台机器能不能弹通知」，
 * 并提供一条明确标注为测试的消息。
 *
 * M17 在此之上加入调度、汇总通知生命周期与点击导航。
 * 这里不做任何定时逻辑，也不假设通知一定会被显示。
 */
const { Notification } = require('electron');
const activeNotifications = new Set();

function notificationStatus(NotificationClass = Notification) {
  let supported = false;
  try {
    supported = !!NotificationClass.isSupported();
  } catch {
    supported = false;
  }
  return {
    supported,
    // Electron 没有统一的授权查询接口。isSupported() 只代表系统支持通知，
    // 不代表用户已授权，也不代表专注模式会放行，因此这里如实标成未知。
    permission: 'unknown',
    detail: supported
      ? '系统支持桌面通知。是否真的弹出还取决于系统授权与专注模式，发送一条测试通知即可确认。'
      : '当前系统不支持桌面通知，正式提醒不会弹出。',
  };
}

async function sendTestNotification({ NotificationClass = Notification, timeoutMs = 5000 } = {}) {
  const status = notificationStatus(NotificationClass);
  if (!status.supported) {
    return { ...status, sent: false, message: '当前系统不支持桌面通知，无法发送测试通知。' };
  }
  return new Promise(resolve => {
    let notification;
    let timeout;
    let settled = false;
    const finish = (delivery, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // 保持通知对象存活，避免 show 后即被回收。测试通知最多保留一分钟。
      if (delivery === 'failed') activeNotifications.delete(notification);
      else setTimeout(() => activeNotifications.delete(notification), 60000).unref();
      resolve({ ...status, sent: delivery !== 'failed', delivery, message });
    };
    try {
      notification = new NotificationClass({
        title: '知流 · 测试通知',
        body: '这是一条测试通知。看到它说明系统通知能正常显示，它不代表正式提醒已经开启。',
      });
      activeNotifications.add(notification);
      notification.once('close', () => activeNotifications.delete(notification));
      notification.once('show', () => finish('shown', '系统已报告测试通知显示。如果没有看到，请检查通知中心与专注模式。'));
      notification.once('failed', (_event, error) => finish('failed', `测试通知发送失败：${error || '系统未提供原因，请检查通知权限。'}`));
      timeout = setTimeout(() => finish('unknown', '已提交测试通知，但未获得显示确认。请检查系统通知权限与专注模式。'), timeoutMs);
      notification.show();
    } catch (error) {
      finish('failed', `测试通知发送失败：${error.message}`);
    }
  });
}

module.exports = { notificationStatus, sendTestNotification };
