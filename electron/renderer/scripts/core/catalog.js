/* ==========================================================================
   平台与优先级元数据
   平台标识来自渠道的稳定值，不做展示层硬编码分支；未知平台回落到 other。
   ========================================================================== */
(function (global) {
  "use strict";

  var SF = (global.SF = global.SF || {});

  var PLATFORMS = {
    xiaohongshu: { id: "xiaohongshu", name: "小红书", short: "小红书", mark: "RED" },
    bilibili: { id: "bilibili", name: "B站", short: "B站", mark: "B" },
    wechat: { id: "wechat", name: "微信公众号", short: "公众号", mark: "微" },
    weibo: { id: "weibo", name: "微博", short: "微博", mark: "博" },
    zhihu: { id: "zhihu", name: "知乎", short: "知乎", mark: "知" },
    other: { id: "other", name: "其他", short: "其他", mark: "?" },
  };

  var PRIORITIES = {
    high: {
      id: "high",
      name: "高优先级",
      hint: "重要内容，尽快查看",
      action: "重要内容，尽快查看",
      icon: "chevron-up",
      tagClass: "tag--high",
      color: "var(--c-high)",
      bg: "var(--c-high-bg)",
    },
    medium: {
      id: "medium",
      name: "中优先级",
      hint: "有价值，稍后查看",
      action: "有价值，稍后查看",
      icon: "chevron-top",
      tagClass: "tag--mid",
      color: "var(--c-mid)",
      bg: "var(--c-mid-bg)",
    },
    low: {
      id: "low",
      name: "低优先级",
      hint: "暂不关注，可稍后处理",
      action: "暂不关注，可稍后处理",
      icon: "chevron-bottom",
      tagClass: "tag--low",
      color: "var(--c-low)",
      bg: "var(--c-low-bg)",
    },
  };

  var PRIORITY_ORDER = ["high", "medium", "low"];

  function platform(id) {
    return PLATFORMS[id] || PLATFORMS.other;
  }

  function priority(id) {
    return PRIORITIES[id] || PRIORITIES.low;
  }

  /** 把未知平台标识收敛到 other，页面因此不需要写平台分支。 */
  function normalizePlatform(id) {
    return PLATFORMS[id] ? id : "other";
  }

  function normalizePriority(id) {
    return PRIORITIES[id] ? id : "low";
  }

  SF.catalog = {
    PLATFORMS: PLATFORMS,
    PRIORITIES: PRIORITIES,
    PRIORITY_ORDER: PRIORITY_ORDER,
    platform: platform,
    priority: priority,
    normalizePlatform: normalizePlatform,
    normalizePriority: normalizePriority,
  };
})(window);
