/* ==========================================================================
   标签色板与元数据（M9）
   --------------------------------------------------------------------------
   颜色是标签的身份，不是装饰：列表色块、表格色条、编辑器预览、使用量条
   全部从这里取同一个值。页面因此不需要出现任何十六进制色值。
   ========================================================================== */
(function (global) {
  "use strict";

  var SF = (global.SF = global.SF || {});

  /**
   * 每档色板对应 tokens.css 里的三个变量：
   *   solid → 图形（色点、色条、选中态描边、使用量条）
   *   soft  → 背景（标签底色、覆盖率条的浅色段）
   *   ink   → 文字（在 soft 上仍能读）
   * 键名同时作为标签数据里的 color 值。
   */
  var TAG_COLORS = [
    { id: "violet", name: "紫" },
    { id: "blue", name: "蓝" },
    { id: "cyan", name: "青" },
    { id: "green", name: "绿" },
    { id: "lime", name: "青柠" },
    { id: "yellow", name: "黄" },
    { id: "amber", name: "橙" },
    { id: "red", name: "红" },
    { id: "pink", name: "粉" },
    { id: "plum", name: "梅紫" },
    { id: "slate", name: "灰" }
  ];

  var BY_ID = {};
  TAG_COLORS.forEach(function (c) {
    BY_ID[c.id] = {
      id: c.id,
      name: c.name,
      solid: "var(--tag-" + c.id + ")",
      soft: "var(--tag-" + c.id + "-soft)",
      ink: "var(--tag-" + c.id + "-ink)"
    };
  });

  /** 未知色值一律收敛到 slate，页面因此不需要写颜色分支。 */
  function color(id) {
    return BY_ID[id] || BY_ID.slate;
  }

  function colorOptions() {
    return TAG_COLORS.map(function (c) {
      return { id: c.id, name: c.name };
    });
  }

  /** 新建标签时的默认取色：按现有数量最少的一档轮转，避免新标签总是同色。 */
  function nextColor(tags) {
    var used = {};
    (tags || []).forEach(function (t) {
      used[t.color] = (used[t.color] || 0) + 1;
    });
    var best = TAG_COLORS[0].id;
    var min = Infinity;
    TAG_COLORS.forEach(function (c) {
      var n = used[c.id] || 0;
      if (n < min) {
        min = n;
        best = c.id;
      }
    });
    return best;
  }

  SF.tagCatalog = {
    COLORS: TAG_COLORS,
    color: color,
    colorOptions: colorOptions,
    nextColor: nextColor
  };
})(window);
