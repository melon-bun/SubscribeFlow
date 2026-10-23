/* ==========================================================================
   平台与优先级元数据
   平台标识来自渠道的稳定值，不做展示层硬编码分支；未知平台回落到 other。
   ========================================================================== */
(function (global) {
  "use strict";

  var SF = (global.SF = global.SF || {});

  var PLATFORMS = {
    xiaohongshu: { id: "xiaohongshu", name: "小红书", short: "小红书", mark: "红" },
    bilibili: { id: "bilibili", name: "B站", short: "B站", mark: "B" },
    wechat: { id: "wechat", name: "微信公众号", short: "公众号", mark: "微" },
    weibo: { id: "weibo", name: "微博", short: "微博", mark: "博" },
    zhihu: { id: "zhihu", name: "知乎", short: "知乎", mark: "知" },
    /* GitHub 用官方实心标识（icon），其余平台仍用文字缩写（mark）。 */
    github: { id: "github", name: "GitHub", short: "GitHub", mark: "GH", icon: "github" },
    other: { id: "other", name: "其他", short: "其他", mark: "?" },
  };

  var PRIORITIES = {
    high: {
      id: "high",
      name: "高优先级",
      /* 「静流」§5：分段控件里只放一个固定等级字（高/中/低），
         用户自定义的显示名（可能很长）放到提示行里。
         short 是等级本身，不随改名变化。 */
      short: "高",
      hint: "重要内容，尽快查看",
      action: "重要内容，尽快查看",
      icon: "priority-set",
      tagClass: "tag--high",
      color: "var(--c-high)",
      bg: "var(--c-high-bg)",
    },
    medium: {
      id: "medium",
      name: "中优先级",
      short: "中",
      hint: "有价值，稍后查看",
      action: "有价值，稍后查看",
      icon: "priority-set",
      tagClass: "tag--mid",
      color: "var(--c-mid)",
      bg: "var(--c-mid-bg)",
    },
    low: {
      id: "low",
      name: "低优先级",
      short: "低",
      hint: "暂不关注，可稍后处理",
      action: "暂不关注，可稍后处理",
      icon: "priority-set",
      tagClass: "tag--low",
      color: "var(--c-low)",
      bg: "var(--c-low-bg)",
    },
  };

  PRIORITIES.none = {id:'none', short:'未设置', name:'未设置', hint:'尚未指定优先级', action:'可设置来源默认值或单条内容优先级', icon:'inbox', tagClass:'tag--neutral', color:'var(--c-text-3)', bg:'var(--c-surface)'};

  var PRIORITY_ORDER = ["high", "medium", "low"];

  /* M20 优先级名称：等级固定、顺序固定，只有显示名可由用户改。
     「未设置」是无优先级状态，不是第四个等级，因此不能被占用为名称。 */
  var PRIORITY_DEFAULT_NAMES = {high: "高优先级", medium: "中优先级", low: "低优先级"};
  var PRIORITY_NONE_NAME = "未设置";
  var PRIORITY_NAME_MAX = 12;

  /** 应用新的显示名；缺项或空值退回默认名，等级本身不受影响。 */
  function setPriorityNames(names) {
    PRIORITY_ORDER.forEach(function (id) {
      var value = names && typeof names[id] === "string" ? names[id].trim() : "";
      PRIORITIES[id].name = value || PRIORITY_DEFAULT_NAMES[id];
    });
    return priorityNames();
  }

  /** 当前生效的三级显示名。 */
  function priorityNames() {
    var names = {};
    PRIORITY_ORDER.forEach(function (id) { names[id] = PRIORITIES[id].name; });
    return names;
  }

  function platform(id) {
    return PLATFORMS[id] || PLATFORMS.other;
  }

  function priority(id) {
    return PRIORITIES[id] || PRIORITIES.none;
  }

  /** 把未知平台标识收敛到 other，页面因此不需要写平台分支。 */
  function normalizePlatform(id) {
    return PLATFORMS[id] ? id : "other";
  }

  function normalizePriority(id) {
    return PRIORITIES[id] ? id : "none";
  }

  SF.catalog = {
    PLATFORMS: PLATFORMS,
    PRIORITIES: PRIORITIES,
    PRIORITY_ORDER: PRIORITY_ORDER,
    PRIORITY_DEFAULT_NAMES: PRIORITY_DEFAULT_NAMES,
    PRIORITY_NONE_NAME: PRIORITY_NONE_NAME,
    PRIORITY_NAME_MAX: PRIORITY_NAME_MAX,
    platform: platform,
    priority: priority,
    priorityNames: priorityNames,
    setPriorityNames: setPriorityNames,
    normalizePlatform: normalizePlatform,
    normalizePriority: normalizePriority,
  };
})(window);
