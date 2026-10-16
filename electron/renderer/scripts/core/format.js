/* ==========================================================================
   格式化工具：日期、相对时间、数字
   ========================================================================== */
(function (global) {
  "use strict";

  var SF = (global.SF = global.SF || {});

  var WEEK = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  var WEEK_SHORT = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function toDate(value) {
    if (value instanceof Date) return value;
    if (value == null || value === "") return new Date(NaN);
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(value + "T00:00:00");
    return new Date(value);
  }

  function ymd(date) {
    var d = toDate(date);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function sameDay(a, b) {
    return ymd(a) === ymd(b);
  }

  function addDays(date, n) {
    var d = new Date(toDate(date).getTime());
    d.setDate(d.getDate() + n);
    return d;
  }

  function startOfMonth(date) {
    var d = toDate(date);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  /** "2024年4月" */
  function yearMonth(date) {
    var d = toDate(date);
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月";
  }

  /** "2024年4月" / "4月"，用于下拉与统计卡 */
  function shortMonth(date) {
    var d = toDate(date);
    return d.getMonth() + 1 + "月";
  }

  /** "4月24日" */
  function monthDay(date) {
    var d = toDate(date);
    return d.getMonth() + 1 + "月" + d.getDate() + "日";
  }

  /** "2024年4月24日" */
  function fullDate(date) {
    var d = toDate(date);
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }

  function weekday(date) {
    return WEEK[toDate(date).getDay()];
  }

  function weekdayShort(date) {
    return WEEK_SHORT[toDate(date).getDay()];
  }

  /** 列表里的相对时间：3 小时前 / 昨天 / 4月20日 */
  function relative(value, now) {
    var d = toDate(value);
    if (!Number.isFinite(d.getTime())) return "时间未知";
    var base = now ? toDate(now) : new Date();
    var diff = base.getTime() - d.getTime();
    var min = Math.floor(diff / 60000);

    if (min < 1) return "刚刚";
    if (min < 60) return min + " 分钟前";
    var hour = Math.floor(min / 60);
    if (hour < 24) return hour + " 小时前";
    if (sameDay(d, base)) return hour + " 小时前";
    if (sameDay(d, addDays(base, -1))) return "昨天 " + weekdayShort(d);
    if (sameDay(d, addDays(base, -2))) return "前天";
    if (d.getFullYear() === base.getFullYear()) return monthDay(d);
    return d.getFullYear() + "年" + monthDay(d);
  }

  /** 表格里的绝对时间：2024-04-24 10:12 / 3 小时前 */
  function absolute(value, now) {
    var d = toDate(value);
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes())
    );
  }

  function timeOfDay(value) {
    var d = toDate(value);
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function publication(item, compact) {
    if (!item.publishedAt || item.publishedPrecision === "unknown") return item.publishedLabel ? item.publishedLabel + "（时间待确认）" : "发布时间未知";
    var value = String(item.publishedAt);
    if (compact) return value.slice(0,10) + (item.publishedPrecision === "date" ? "（仅日期）" : "");
    if (item.publishedPrecision === "date") return value.slice(0, 10) + "（仅日期" + (item.publishedTimezone ? "，" + item.publishedTimezone : "，时区未知") + "）";
    if (!Number.isFinite(new Date(value).getTime())) return "发布时间未知";
    return value.replace("T", " ") + "（" + (item.publishedTimezone || "时区未知") + "）";
  }
  function intakeTime(item, compact) {
    if (item.intakeMethod !== "manual") return publication(item, compact);
    if (!Number.isFinite(toDate(item.manualAddedAt).getTime())) return "添加时间未知";
    return "添加于 " + (compact ? ymd(item.manualAddedAt) : absolute(item.manualAddedAt));
  }

  /**
   * 这个时间到底是什么时间。
   *
   * 有些渠道（GitHub 趋势榜）在页面上根本没有单条发布时间，Adapter 只能把
   * 抓取时刻标成 provenance='fetched_at'。那种时间说的是「我们什么时候看到
   * 它」，显示成发布时间就是不诚实，因此这里按来源改标题。
   */
  function publicationHeading(item) {
    return item.publishedProvenance === "fetched_at" ? "收录时间" : "原始发布";
  }
  function publicationDay(item) {
    if (!item.publishedAt || item.publishedPrecision === "unknown") return null;
    var day = String(item.publishedAt).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  }
  function runState(state) {
    return {queued:"排队中", running:"采集中", waiting:"等待处理", succeeded:"采集完成", partial:"部分完成", failed:"读取失败", cancelled:"已取消", interrupted:"已中断"}[state] || state;
  }
  function coverage(scope) {
    return {history_end:"历史遍历已完成", window_only:"仅最近窗口，非全部历史", possible_gaps:"已保存部分内容，可能有缺口", refresh_interval:"刷新区间已完成"}[scope] || "覆盖范围尚未确定";
  }
  SF.fmt = {
    intakeTime: intakeTime, publication: publication, publicationDay: publicationDay, publicationHeading: publicationHeading, runState: runState, coverage: coverage,
    WEEK: WEEK,
    pad: pad,
    ymd: ymd,
    sameDay: sameDay,
    addDays: addDays,
    startOfMonth: startOfMonth,
    yearMonth: yearMonth,
    shortMonth: shortMonth,
    monthDay: monthDay,
    fullDate: fullDate,
    weekday: weekday,
    weekdayShort: weekdayShort,
    relative: relative,
    absolute: absolute,
    timeOfDay: timeOfDay,
  };
})(window);
