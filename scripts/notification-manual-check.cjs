const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * M17 真实系统通知的人工验收入口。
 *
 * 自动化测试全部使用替身，**替身不构成真实显示证据**。本入口用隔离的 userData
 * 与正式通知代码，向真实桌面弹出一条测试通知，请用户肉眼确认：
 *   1. 通知是否真的出现在系统通知中心；
 *   2. 文案是否为「你有 N 条内容未处理」这类真实措辞；
 *   3. 点击通知是否回到应用并打开对应列表。
 *
 * 不会碰用户日常数据、登录态或系统通知权限设置；退出即清理本轮临时目录。
 *
 * 用法：
 *   node scripts/notification-manual-check.cjs
 */
async function main() {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-notify-'));
  console.log('隔离数据目录：' + folder);
  console.log('即将发送一条真实桌面测试通知（会出现在系统通知中心）。');
  console.log('请肉眼确认后按回车退出；Ctrl+C 也会退出并清理。');

  const child = spawn(require('electron'), [root], {
    env: {
      ...process.env,
      SUBSCRIBE_FLOW_DATA_DIR: folder,
      SUBSCRIBE_FLOW_NOTIFICATION_MANUAL: '1',
    },
    stdio: 'inherit',
  });

  // 用户确认后结束本轮进程并清理临时目录。
  await new Promise((resolve) => {
    process.stdin.on('data', () => resolve());
    process.stdin.resume();
    child.on('close', () => resolve());
  });
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 800));
  child.kill('SIGKILL');
  fs.rmSync(folder, {recursive: true, force: true});
  console.log('已退出并清理：' + folder);
  console.log('请把「是否真的看到 / 点击是否有反应」的观察结果填回 docs/M17_REMINDERS_TRAY.md。');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('人工验收入口异常：' + (error && error.message));
    process.exitCode = 1;
  });
}

module.exports = {main};
