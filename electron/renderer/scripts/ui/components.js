/* ==========================================================================
   可复用组件
   按设计稿的实际复用需要拆分，不建设组件框架。
   所有组件返回 DOM 节点，不持有业务状态。
   ========================================================================== */
(function (global) {
  "use strict";

  var SF = (global.SF = global.SF || {});
  var h = SF.dom.h;
  var icon = SF.icon;
  var catalog = SF.catalog;
  var fmt = SF.fmt;

  var ui = {};

  /* ---------------- 基础控件 ---------------- */

  ui.btn = function (label, opts) {
    opts = opts || {};
    var cls = "btn";
    if (opts.variant) cls += " btn--" + opts.variant;
    if (opts.size) cls += " btn--" + opts.size;
    if (opts.block) cls += " btn--block";
    return h(
      "button",
      {
        class: cls,
        type: opts.type || "button",
        disabled: !!opts.disabled,
        title: opts.title || label,
        "aria-label": opts.ariaLabel || null,
        style: opts.style || null,
        onclick: opts.onClick || null,
      },
      opts.icon ? icon(opts.icon, 15) : null,
      label ? h("span", { text: label }) : null
    );
  };

  /**
   * 挂上悬浮提示。禁用控件不派发指针事件，套一层壳来承载提示。
   * 图标按钮原本用原生 title，延迟一秒多且样式不受控，这里统一交给 SF.tooltip。
   */
  ui.tip = function (el, text, opts) {
    if (!text) return el;
    opts = opts || {};
    if (opts.disabled) {
      return h(
        "span.icon-btn-tip",
        { "data-tip": text, "data-tip-placement": opts.placement || null },
        el
      );
    }
    el.setAttribute("data-tip", text);
    if (opts.placement) el.setAttribute("data-tip-placement", opts.placement);
    return el;
  };

  /**
   * 优先级信号条：三格高度代表等级，颜色只落在图形上，文字保持中性。
   * 「静流」5.1 期（M31）：颜色语义唯一性要求——一张卡片上的彩色元素要收敛，
   * 所以优先级不再用彩色文字胶囊，改用这个 11px 高也能分辨等级的信号条。
   * 色弱用户靠格数同样能区分（高=3 格、中=2 格、低=1 格）。
   */
  ui.prioSig = function (level, opts) {
    opts = opts || {};
    var cls = "prio-sig";
    if (level === "high") cls += " prio-sig--high";
    else if (level === "medium" || level === "mid") cls += " prio-sig--mid";
    else if (level === "low") cls += " prio-sig--low";
    else if (level === "none") cls += " prio-sig--none";
    return h(
      "span." + cls,
      { "aria-hidden": "true", title: opts.title || null },
      h("i"), h("i"), h("i")
    );
  };

  ui.iconBtn = function (iconName, title, onClick, opts) {
    opts = opts || {};
    var btn = h(
      "button.icon-btn" + (opts.danger ? ".icon-btn--danger" : ""),
      {
        type: "button",
        "aria-label": opts.ariaLabel || title,
        onclick: onClick || null,
        disabled: !!opts.disabled,
      },
      icon(iconName, opts.size || 18)
    );
    return ui.tip(btn, opts.tip || title, { disabled: !!opts.disabled, placement: opts.tipPlacement });
  };

  ui.select = function (options, value, onChange, opts) {
    opts = opts || {};
    var sel = h(
      "select",
      {
        "aria-label": opts.ariaLabel || null,
        onchange: function (e) {
          onChange && onChange(e.target.value, e);
        },
      },
      options.map(function (o) {
        return h("option", { value: o.value, selected: o.value === value }, o.label);
      })
    );
    sel.value = value;
    var wrap = h("span.select" + (opts.small ? ".select--sm" : ""), null, sel);
    wrap._input = sel;
    return wrap;
  };

  /**
   * 筛选条上的无框按钮（不是原生下拉）。
   * 「静流」§筛选条：下拉一律用无框形态——靠留白与悬停底色区分，
   * 旁边再画一条细竖线分段；只有真正需要选项的才用原生 select。
   */
  ui.selectBtn = function (label, opts) {
    opts = opts || {};
    return h(
      "button.select.select--btn" + (opts.arrow === false ? ".select--no-arrow" : ""),
      {
        type: "button",
        title: opts.title || label,
        "aria-label": opts.ariaLabel || label,
        onclick: opts.onClick || null,
      },
      opts.icon ? icon(opts.icon, 14) : null,
      label ? h("span", { text: label }) : null,
      opts.arrow === false ? null : icon("chevron-down", 14)
    );
  };

  /**
   * 筛选条上的下拉。
   *
   * 不用原生 <select>：原生控件的宽度由**最长选项**决定，
   * 优先级名可被用户改成「开箱即用的项目_教程」这类长名，
   * 一条筛选条会被撑得横跨整屏、散成一排。
   * 方案里的 .select 是一个按钮 + 箭头，点开才是选项；
   * 这里用同一套视觉，选项走已有的 ui.menu（浮层、Esc 关闭、焦点管理都有）。
   *
   * options: [{ value, label }]
   */
  ui.dropdown = function (options, value, onChange, opts) {
    opts = opts || {};
    options = options || [];
    var current = options.filter(function (o) { return o.value === value; })[0] || options[0];
    if (!current) return null;
    var btn = h(
      "button.select.select--btn",
      {
        type: "button",
        title: opts.title || current.label,
        "aria-label": opts.ariaLabel || current.label,
        "aria-haspopup": "menu",
        /* 当前值挂在按钮上：验收脚本与外部自动化按值定位用 */
        "data-value": String(value),
        /* 按钮文案未变时，异步目录仍可能增加菜单项；让协调器同步新的回调。 */
        "data-options": JSON.stringify(options.map(function (o) { return [o.value, o.label]; })),
        onclick: function (e) {
          e.stopPropagation();
          ui.menu(options.map(function (o) {
            return {
              label: o.label,
              value: o.value,
              active: o.value === value,
              onClick: function () { onChange && onChange(o.value); },
            };
          }), btn);
        },
      },
      opts.icon ? icon(opts.icon, 14) : null,
      /* 前置节点：等级信号条等（参考页 .prow .select 把信号条放在按钮里）。 */
      opts.node || null,
      h("span" + (opts.labelClass ? "." + opts.labelClass : ""), { text: current.label }),
      /* 「静流」§.select：箭头是按钮里的一个内联图标，不是 ::after 伪元素。
         参考页的月份 / 日期按钮只有日历图标、没有下拉箭头，arrow:false 去掉它。 */
      opts.arrow === false ? null : icon("chevron-down", 14)
    );
    return btn;
  };

  ui.searchInput = function (placeholder, value, onInput, opts) {
    opts = opts || {};
    var input = h("input.input", {
      type: "search",
      placeholder: placeholder,
      "aria-label": opts.ariaLabel || placeholder,
      value: value || "",
      oninput: function (e) {
        onInput && onInput(e.target.value, e);
      },
    });
    return h("span.search-input", null, icon("search", 15), input);
  };

  ui.check = function (checked, onToggle, label) {
    var box = h(
      "button.check",
      {
        type: "button",
        role: "checkbox",
        "aria-checked": checked ? "true" : "false",
        "aria-label": label || "选择",
        onclick: function (e) {
          e.stopPropagation();
          onToggle && onToggle();
        },
      },
      icon("check", 11)
    );
    if (checked) box.classList.add("is-checked");
    return box;
  };

  ui.toggle = function (on, onToggle, opts) {
    opts = opts || {};
    return h(
      "button.switch" + (on ? ".is-on" : ""),
      {
        type: "button",
        role: "switch",
        "aria-checked": on ? "true" : "false",
        "aria-label": opts.label || "开关",
        disabled: !!opts.disabled,
        onclick: function () {
          onToggle && onToggle(!on);
        },
      }
    );
  };

  ui.tag = function (text, variant) {
    return h("span.tag" + (variant ? "." + variant : ""), { text: text });
  };

  /**
   * 标签色块。SF.tagUi 由后加载的 tag-controls.js 提供，这里在渲染时才取，
   * 不依赖脚本加载顺序；万一未加载也退回纯文本标签，不会渲染出 [object Object]。
   */
  function tagChip(tag) {
    if (SF.tagUi && SF.tagUi.tagChip) return SF.tagUi.tagChip(tag);
    return ui.tag(tag && tag.name ? tag.name : "");
  }

  /**
   * 平台标识（内容卡片用）。
   * 「静流」5.1 期（M31）：原先是「B站」这样的彩色文字胶囊，
   * 现在改为来源名前的 15px 平台色方块——颜色落在图形上，文字位置让给来源名。
   */
  ui.platformTag = function (platformId) {
    var p = catalog.platform(platformId);
    var body = p.icon ? icon(p.icon, 11) : p.mark;
    return h(
      "span.plat.plat--sm.plat--" + p.id,
      { title: p.name, "aria-label": p.name },
      body
    );
  };

  /**
   * 平台标识块。有专属矢量图标的平台（GitHub）画图标，其余仍用两字缩写，
   * 图形与底色统一由 .plat--<平台> 决定，避免各界面各画一套。
   */
  ui.platformIcon = function (platformId, opts) {
    opts = opts || {};
    var p = catalog.platform(platformId);
    var cls = "plat.plat--" + p.id + (opts.large ? ".plat--lg" : "") +
      (opts.className ? "." + opts.className.split(" ").join(".") : "");
    var body = p.icon ? icon(p.icon, opts.large ? 18 : 13) : p.mark;
    // 宿主元素已经带 aria-label 时，标识本身只做装饰，避免读屏重复念两遍。
    var label = opts.decorative ? { "aria-hidden": "true" } : { title: p.name, "aria-label": p.name };
    return h("span." + cls, label, body);
  };

  ui.avatar = function (name, src, size) {
    var cls = "avatar" + (size ? ".avatar--" + size : "");
    if (src) {
      return h("span." + cls.split(" ").join("."), null, h("img", { src: src, alt: name, loading: "lazy" }));
    }
    return h("span." + cls.split(" ").join("."), { title: name, "aria-label": name }, (name || "?").slice(0, 1));
  };

  /**
   * 优先级标识（内容卡片用）。
   * 「静流」§3：原先是「高优先级」这样的彩色文字胶囊，
   * 现在改为三格信号条 + 一个字——颜色只落在图形上，文字保持中性。
   *
   * 那个「一个字」用固定等级字（高 / 中 / 低），不是用户自定义的显示名：
   * 显示名可长到 12 个字（例：开箱即用的项目_教程），塞进卡片元信息行
   * 会把整行挤成两行。完整名字放在 title 里，悬停可见。
   */
  ui.priorityTag = function (priorityId) {
    var p = catalog.priority(priorityId);
    if (priorityId === "none" || !priorityId) {
      return h("span.prio.prio--none", { title: p.name }, ui.prioSig("none"), h("span", { text: p.short || p.name }));
    }
    return h(
      "span.prio.prio--" + priorityId,
      { title: p.name },
      ui.prioSig(priorityId),
      h("span", { text: p.short || p.name })
    );
  };

  ui.countPill = function (n, variant) {
    return h("span.count-pill" + (variant ? ".count-pill--" + variant : ""), {
      text: String(n),
    });
  };

  /* ---------------- 内容卡片 ---------------- */

  /**
   * 收件箱 / 优先级模式共用的内容卡片。
   *
   * 「静流」§3 + §组件样张：版式照方案的 .card —
   *   左列 96px 缩略图；右列依次是标题、摘要、元信息行、脚注行。
   * 元信息行：平台方块 + 来源名 · 日期，优先级信号条贴最右。
   * 脚注行：标签、收录方式、URL（悬停才出现）——不再单独占一行，也不画分隔线。
   *
   * opts: { selected, onSelect, onToggleRead, onToggleArchive, onDefer, onBookmark, now }
   */
  ui.contentCard = function (item, opts) {
    opts = opts || {};
    var p = catalog.platform(item.platform);

    var ops = h(
      "div.content-card__ops",
      null,
      opts.onBookmark ? ui.iconBtn("bookmark", "收藏", opts.onBookmark) : null,
      ui.iconBtn("more-vert", "更多操作", opts.onMenu, { ariaLabel: "更多操作" })
    );

    var card = h(
      "div.content-card",
      {
        "data-content-id": item.id,
        role: "button", tabindex: "0",
        onkeydown: function (e) { if (e.target === e.currentTarget && ["Enter", " "].includes(e.key)) { e.preventDefault(); opts.onSelect(); } },
        "aria-pressed": opts.selected ? "true" : "false",
        onclick: opts.onSelect,
      },
      h(
        "span.content-card__thumb",
        null,
        /* 没有封面时放一个山形占位（方案样张的缩略图就是这个画法），
           比一块纯灰的空框更像「这里本来该是图」。 */
        item.cover ? h("img", { src: item.cover, alt: "", loading: "lazy" }) : icon("mountain", 40)
      ),
      h(
        "span.content-card__main",
        null,
        h("span.content-card__title", { text: item.title }),
        item.summary ? h("span.content-card__summary", { text: item.summary }) : null,
        h(
          "span.content-card__meta",
          null,
          // 「静流」§3：平台标识放到来源名前面的色块上，来源名本身保持中性。
          h(
            "span.content-card__author",
            null,
            ui.platformTag(item.platform),
            h("span.t-ellipsis", { text: item.channelName })
          ),
          h("span.content-card__dot"),
          /* 「静流」§样张：日期是 <span class="date num">，等宽数字来自 num 类。 */
          h("span.content-card__time.num", { text: fmt.intakeTime(item, true) }),
          // 「静流」§3：优先级用信号条表达，贴在元信息行最右。
          ui.priorityTag(item.priority)
        ),
        h(
          "span.content-card__foot",
          null,
          // 标签容器固定存在，具体标签由调用方（收件箱）按数据填充。
          h("span.content-card__tags", null),
          // M27：写过的笔记在卡片上留个记号。没有笔记不显示否定徽标。
          item.hasNote ? h("span.content-card__note", { title: "有笔记", "aria-label": "有笔记" }, icon("edit", 12)) : null,
          // 「静流」§3：收录方式由灰色胶囊改为小图标 + 浅灰文字，排在卡片脚注里。
          h(
            "span.content-card__method",
            { title: item.intakeMethod === "manual" ? "手动收录" : "自动采集" },
            icon(item.intakeMethod === "manual" ? "hand" : "refresh", 12),
            h("span", { text: item.intakeMethod === "manual" ? "手动" : "自动" })
          ),
          /* 「静流」§样张：URL 行是 <span class="link mono">——
             等宽字体来自 mono 类，不是这条规则自己写的。 */
          h(
            "span.content-card__link.mono",
            null,
            icon("link", 13),
            h("span", { text: item.url })
          ),
          ops
        )
      )
    );

    if (opts.selected) card.classList.add("is-selected");
    if (item.state.read) card.classList.add("is-read");
    card.setAttribute("aria-label", item.title + "，" + p.name);
    return card;
  };

  /**
   * 紧凑行：日历右侧「当日内容」列表（参考页 .dli）。
   *
   * 结构照参考页抄：缩略图 + 标题 + 一行元信息（平台 + 来源名，右端是优先级信号条）。
   * 之前这一行还塞了头像、日期、优先级文字，外加一整行摘要——
   * 六个元素挤在两百多像素宽的窄列里，缺口全落在来源名上，
   * 名字被压成「Mi…」甚至一个字，看着像渲染坏了。
   */
  ui.rowCard = function (item, opts) {
    opts = opts || {};
    var card = h(
      "button.row-card",
      { type: "button", onclick: opts.onSelect },
      /* 没有封面时放山形占位（参考页 .dli .thumb 就是 i-mtn）：
         留一块空灰框会让人以为图还没加载出来。 */
      h("span.row-card__thumb", null, item.cover ? h("img", { src: item.cover, alt: "", loading: "lazy" }) : icon("mountain", 24)),
      h(
        "span.grow",
        null,
        h("span.row-card__title", { text: item.title }),
        h(
          "span.row-card__meta",
          null,
          h("span.row-card__src", null, ui.platformTag(item.platform), h("span.t-ellipsis", { text: item.channelName })),
          h("span.row-card__prio", null, ui.prioSig(item.priority))
        )
      )
    );
    return card;
  };

  /* ---------------- 状态区块 ---------------- */

  /**
   * 空态 / 错误 / 阻塞等统一区块。
   * F1.4 要求各状态都能独立展示，复制文案必须说明「发生了什么」和「下一步做什么」。
   */
  ui.state = function (opts) {
    return h(
      "div.state",
      { role: "status" },
      h(
        "div.state__icon" + (opts.tone ? ".state__icon--" + opts.tone : ""),
        null,
        icon(opts.icon || "info", 26)
      ),
      h("p.state__title", { text: opts.title }),
      opts.desc ? h("p.state__desc", { text: opts.desc }) : null,
      opts.actions && opts.actions.length
        ? h(
            "div.state__actions",
            null,
            opts.actions.map(function (a) {
              return ui.btn(a.label, { variant: a.variant, onClick: a.onClick });
            })
          )
        : null
    );
  };

  ui.notice = function (opts) {
    return h(
      "div.notice.notice--" + (opts.tone || "info"),
      { role: opts.tone === "danger" ? "alert" : "status" },
      icon(opts.icon || "info", 16),
      h(
        "div.notice__body",
        null,
        opts.title ? h("div.notice__title", { text: opts.title }) : null,
        h("div.notice__text", { text: opts.text })
      )
    );
  };

  ui.progress = function (value, indeterminate) {
    var bar = h("div.progress__bar");
    if (indeterminate) {
      bar.classList.add("progress__bar--indeterminate");
    } else {
      bar.style.width = Math.max(0, Math.min(100, value)) + "%";
    }
    return h("div.progress", { role: "progressbar" }, bar);
  };

  ui.skeletonCards = function (count) {
    var n = count || 4;
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(
        h(
          "div.skeleton-card",
          null,
          h("div.skeleton", { style: { width: "96px", height: "68px", flex: "none", "border-radius": "8px" } }),
          h(
            "div.col.grow",
            { style: { gap: "8px" } },
            h("div.skeleton", { style: { height: "14px", width: "86%" } }),
            h("div.skeleton", { style: { height: "12px", width: "64%" } }),
            h("div.skeleton", { style: { height: "12px", width: "42%" } })
          )
        )
      );
    }
    return h("div.inbox__grid", null, out);
  };

  /* ---------------- 弹层 ---------------- */

  var openLayers = [];

  function pushLayer(layer) {
    openLayers.push(layer);
    document.body.appendChild(layer.mask);
    var focusable = layer.el.querySelector("input, button, select, textarea, [tabindex]");
    if (focusable) focusable.focus();
    else layer.el.setAttribute("tabindex", "-1"), layer.el.focus();
  }

  function closeTop() {
    var layer = openLayers.pop();
    if (layer) layer.close();
  }

  /**
   * 对话框。opts: { title, body(node|fn), footer(node), wide, onClose }
   * 返回 { el, close }
   */
  ui.dialog = function (opts) {
    opts = opts || {};
    var previousFocus = document.activeElement;
    var el = h(
      "div.dialog" + (opts.wide ? ".dialog--wide" : ""),
      { role: "dialog", "aria-modal": "true", "aria-label": opts.title },
      h(
        "div.dialog__head",
        null,
        h("div.dialog__title", { text: opts.title }),
        h("div.spacer"),
        ui.iconBtn("close", "关闭", close, { ariaLabel: "关闭对话框" })
      ),
      h("div.dialog__body.scroll-y", null, opts.body || null),
      opts.footer ? h("div.dialog__foot", null, opts.footer) : null
    );

    function onKeydown(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      } else if (e.key === "Tab") {
        SF.dom.trapFocus(el, e);
      }
    }

    function close() {
      if (opts.beforeClose && opts.beforeClose() === false) return;
      document.removeEventListener("keydown", onKeydown, true);
      var idx = openLayers.indexOf(layer);
      if (idx >= 0) openLayers.splice(idx, 1);
      if (layer.mask.parentNode) layer.mask.parentNode.removeChild(layer.mask);
      opts.onClose && opts.onClose();
      if (previousFocus && previousFocus.isConnected) previousFocus.focus();
    }

    var mask = h("div.dialog-mask", {
      onmousedown: function (e) {
        if (e.target === mask) close();
      },
    }, el);

    var layer = { el: el, mask: mask, close: close };
    document.addEventListener("keydown", onKeydown, true);
    pushLayer(layer);
    return layer;
  };

  /** 确认对话框：破坏性操作统一走这里 */
  ui.confirm = function (opts) {
    return new Promise(function (resolve) {
      var settled = false;
      function done(v) {
        if (settled) return;
        settled = true;
        resolve(v);
      }
      ui.dialog({
        title: opts.title,
        body: h("p.state__desc", { style: { "text-align": "left", "max-width": "none" }, text: opts.message }),
        footer: [
          h("div.spacer"),
          ui.btn(opts.cancelText || "取消", { onClick: function () { done(false); layer.close(); } }),
          ui.btn(opts.confirmText || "确认", {
            variant: opts.danger ? "danger" : "primary",
            onClick: function () { done(true); layer.close(); },
          }),
        ],
        onClose: function () { done(false); },
      });
      var layer = openLayers[openLayers.length - 1];
    });
  };

  /* ---------------- 轻提示 ---------------- */

  var toastLayer = null;

  ui.toast = function (message, type) {
    if (!toastLayer) {
      toastLayer = h("div.toast-layer", { "aria-live": "polite" });
      document.body.appendChild(toastLayer);
    }
    var el = h(
      "div.toast" + (type ? ".toast--" + type : ""),
      null,
      icon(type === "error" ? "alert" : "check", 15),
      h("span", { text: message })
    );
    toastLayer.appendChild(el);
    setTimeout(function () {
      el.style.opacity = "0";
      el.style.transition = "opacity 200ms";
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 220);
    }, 2200);
  };

  /* ---------------- 下拉菜单 ---------------- */

  var openMenu = null;

  ui.closeMenu = function () {
    if (openMenu && openMenu.parentNode) openMenu.parentNode.removeChild(openMenu);
    openMenu = null;
  };

  /**
   * 浮层相对锚点定位：默认在下方，空间不够翻到上方，并夹在视口内。
   * 菜单和标签浮层共用，翻转规则不会各写一份而漂移。
   */
  function positionOverlay(el, anchor, align) {
    var rect = anchor.getBoundingClientRect();
    var w = el.offsetWidth;
    var left = align === "left" ? rect.left : Math.min(rect.right - w, window.innerWidth - w - 8);
    var top = rect.bottom + 4;
    if (top + el.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - el.offsetHeight - 4);
    }
    el.style.left = Math.max(8, left) + "px";
    el.style.top = top + "px";
  }

  /**
   * items: [{ label, icon, danger, active, onClick }] 或 '-' 分隔线
   * anchor: 触发元素，菜单相对其右下角定位
   */
  ui.menu = function (items, anchor) {
    ui.closeMenu();
    var el = h(
      "div.menu",
      { role: "menu" },
      items.map(function (it) {
        if (it === "-") return h("div.menu__sep");
        return h(
          "button.menu__item" + (it.danger ? ".menu__item--danger" : "") + (it.active ? ".is-active" : ""),
          {
            type: "button",
            role: "menuitem",
            /* 带选项值：下拉菜单的选项要能被按值定位（验收脚本与自动化都靠它） */
            "data-value": it.value === undefined ? null : String(it.value),
            onclick: function () {
              ui.closeMenu();
              it.onClick && it.onClick();
            },
          },
          it.icon ? icon(it.icon, 14) : null,
          h("span", { text: it.label }),
          /* 当前项在菜单末尾打一个勾——下拉里必须能一眼看出「现在是哪个」。 */
          it.active ? icon("check", 14) : null
        );
      })
    );

    document.body.appendChild(el);
    positionOverlay(el, anchor, "right");
    var firstItem = el.querySelector("button"); if (firstItem) firstItem.focus();
    el.addEventListener("keydown", function (e) { if (e.key === "Escape") { ui.closeMenu(); if (anchor.isConnected) anchor.focus(); } });
    openMenu = el;

    setTimeout(function () {
      document.addEventListener("mousedown", onDocDown, { once: true });
    }, 0);

    function onDocDown(e) {
      if (!el.contains(e.target)) ui.closeMenu();
    }
    return el;
  };

  /**
   * 标签挂载对话框：上方是已挂载托盘，中间是搜索/新建输入框，下方是全部标签。
   *
   * 用对话框而不是下拉或贴着按钮的小浮层：标签一多，下拉会被拉得很长把详情顶出
   * 视口，而浮层盖在内容上又会挡住想对照的内容。对话框给出完整的高度和宽度，
   * 已挂载与待选同时可见，也能边挂载边对照。
   *
   * 选中的改动先在本对话框内累积，点「确认挂载」才一次性交给调用方——
   * 避免每点一个标签就整页重绘一次。
   *
   * tags:     [{id, name, color}]
   * selected: 已挂载 ID 数组
   * onConfirm: (ids) => void，确认后调用；关闭或取消不调用
   * onCreate: 可选。输入框回车时若没有同名标签则调用它新建并直接挂载
   */
  ui.tagPicker = function (opts) {
    opts = opts || {};
    var tags = opts.tags || [];
    var selected = {};
    var order = [];
    (opts.selected || []).forEach(function (id) { selected[id] = true; order.push(id); });
    var keyword = "";
    var closed = false;

    function byId(id) {
      return tags.filter(function (t) { return t.id === id; })[0];
    }
    function mountedTags() {
      return order.map(byId).filter(Boolean);
    }
    function visible() {
      var q = keyword.trim().toLowerCase();
      var available = tags.filter(function (t) { return t.enabled !== false; });
      if (!q) return available;
      return available.filter(function (t) {
        return (t.name || "").toLowerCase().indexOf(q) >= 0 ||
          (t.synonyms || []).some(function (s) { return s.toLowerCase().indexOf(q) >= 0; });
      });
    }

    var tray = h("div.tag-pool__tray", { role: "list", "aria-label": "已挂载标签" });
    var grid = h("div.tag-pool__grid", { role: "group", "aria-label": "全部标签" });
    var count = h("span.tag-pool__count", { "aria-live": "polite" });
    var search = ui.searchInput(opts.searchPlaceholder || "输入以筛选标签，回车新建并挂载", "", function (value) {
      keyword = value;
      paint();
    }, { ariaLabel: "筛选或新建标签" });

    function mount(id) {
      if (selected[id]) return;
      selected[id] = true;
      order.push(id);
      paint();
    }
    function unmount(id) {
      if (!selected[id]) return;
      delete selected[id];
      order = order.filter(function (x) { return x !== id; });
      paint();
    }

    function paintTray() {
      SF.dom.render(tray);
      var rows = mountedTags();
      if (!rows.length) {
        SF.dom.append(tray, h("p.tag-pool__empty", { text: "还没有挂载标签 · 在下方标签池点选即可挂载" }));
        return;
      }
      rows.forEach(function (tag) {
        tray.appendChild(
          h("span.tag-pool__mounted", { role: "listitem" },
            SF.tagUi ? SF.tagUi.colorDot(tag.color) : h("span.tag-chip__dot", { "aria-hidden": "true" }),
            h("span.tag-pool__mounted-name", { text: tag.name }),
            ui.iconBtn("close", "取消挂载 " + tag.name, function () { unmount(tag.id); }))
        );
      });
    }

    function paintGrid() {
      SF.dom.render(grid);
      var rows = visible();
      if (!rows.length) {
        SF.dom.append(grid, h("p.tag-pool__empty", {
          text: keyword ? "没有匹配的标签 · 回车可新建「" + keyword.trim() + "」" : "没有可用标签",
        }));
        return;
      }
      rows.forEach(function (tag) {
        var on = !!selected[tag.id];
        grid.appendChild(
          h("button.tag-pool__chip" + (on ? ".is-on" : ""), {
            type: "button",
            role: "checkbox",
            "aria-checked": on ? "true" : "false",
            // 行内只有色点和名称，读屏与自动化都需要一个稳定标识。
            "data-tag-option": tag.id,
            "aria-label": tag.name,
            onclick: function () { on ? unmount(tag.id) : mount(tag.id); },
          },
          SF.tagUi ? SF.tagUi.colorDot(tag.color) : h("span.tag-chip__dot", { "aria-hidden": "true" }),
          h("span.tag-pool__name", { text: tag.name }),
          on ? icon("check", 13) : null)
        );
      });
    }

    function paint() {
      paintTray();
      paintGrid();
      count.textContent = order.length + " 个已挂载 · 共 " + tags.length + " 个标签";
    }

    /* 回车即新建：这是最常见的下一步动作，比让人先关掉对话框去标签页建要顺手。 */
    function onSearchKey(e) {
      if (e.key !== "Enter") return;
      var name = keyword.trim();
      if (!name || !opts.onCreate) return;
      e.preventDefault();
      var existed = tags.filter(function (t) { return t.name.toLowerCase() === name.toLowerCase(); })[0];
      if (existed) {
        if (existed.enabled === false && !selected[existed.id]) ui.toast("该标签已停用，请先在标签管理中启用。", "error");
        else mount(existed.id);
        return;
      }
      opts.onCreate(name, function (tag) {
        if (closed) return;
        tags.push(tag);
        mount(tag.id);
      });
    }
    var searchInput = search.querySelector("input");
    if (searchInput) searchInput.addEventListener("keydown", onSearchKey);

    function close() {
      if (closed) return;
      closed = true;
      // 关闭只取消挂载，不回调 onConfirm：调用方还没拿到任何结果。
      if (searchInput) searchInput.removeEventListener("keydown", onSearchKey);
      layer.close();
    }

    function confirm() {
      if (closed) return;
      closed = true;
      if (searchInput) searchInput.removeEventListener("keydown", onSearchKey);
      layer.close();
      opts.onConfirm && opts.onConfirm(order.slice());
    }

    var layer = ui.dialog({
      title: opts.title || "挂载标签",
      body: h("div.tag-pool", null,
        h("div.tag-pool__section", null,
          h("div.tag-pool__label", null, h("span", { text: "已挂载" }), count),
          tray),
        search,
        h("div.tag-pool__section.tag-pool__section--grow", null,
          h("div.tag-pool__label", null, h("span", { text: "标签池" }),
            h("span.muted", { text: "点选标签即可挂载" })),
          grid)),
      footer: [
        ui.btn("清空", { onClick: function () { order = []; selected = {}; paint(); } }),
        h("div.spacer"),
        ui.btn("取消", { onClick: close }),
        ui.btn(opts.doneText || "确认挂载", { variant: "primary", onClick: confirm }),
      ],
      onClose: function () { if (!closed) { closed = true; } },
    });

    paint();
    return { close: close, confirm: confirm };
  };

  /* ---------------- 统计卡 ---------------- */

  /* 5.1 期补齐（「静流」§内容总览）：统计卡加一条占比细条，
     等级用信号条表达而不是彩色实心图标块。
     opts.level：优先级 id（high/medium/low/none），给出时图标位换成信号条；
     opts.share：0~1 的占比，给出时画底部细条与右上角读数。 */
  ui.stat = function (opts) {
    var level = opts.level;
    var hasBar = typeof opts.share === "number" && isFinite(opts.share);
    var iconBox = h(
      "div.stat__icon.stat__icon--" + (opts.tone || "brand"),
      null,
      level ? ui.prioSig(level) : icon(opts.icon || "file-text", 18)
    );
    if (level) iconBox.classList.remove("stat__icon--" + (opts.tone || "brand"));
    return h(
      "div.stat" + (hasBar ? ".stat--has-bar" : ""),
      level ? { style: { "--pc": "var(--c-" + (level === "medium" ? "mid" : level) + ")" } } : null,
      iconBox,
      h(
        "div.grow",
        null,
        h(
          "div.stat__value",
          null,
          h("span.stat__num", { text: String(opts.value) }),
          hasBar ? h("span.stat__share", { text: Math.round(opts.share * 100) + "%" }) : null,
          opts.trend !== undefined && opts.trend !== null
            ? h(
                "span.stat__trend.stat__trend--" + (opts.trend >= 0 ? "up" : "down"),
                null,
                icon(opts.trend >= 0 ? "trending-up" : "trending-down", 12),
                h("span", { text: Math.abs(opts.trend) + "%" })
              )
            : null
        ),
        h("div.stat__label", { text: opts.label, title: opts.label })
      ),
      hasBar
        ? h("span.stat__bar", null, h("i", { style: { "--w": Math.max(0, Math.min(1, opts.share)) * 100 + "%" } }))
        : null
    );
  };

  /* ---------------- 分段控件 ---------------- */

  /**
   * 「静流」§组件样张：分段控件替代并排的胶囊按钮和单选卡片。
   * 凹槽 + 浮起滑块，当前项一眼可见。
   *
   * options: [{value, label, icon?, title?}]
   * opts: {role:'tablist'|'group', ariaLabel, full}
   */
  ui.seg = function (options, value, onChange, opts) {
    opts = opts || {};
    var role = opts.role || "tablist";
    var group = h("div.seg" + (opts.full ? ".seg--full" : ""), {
      role: role,
      "aria-label": opts.ariaLabel || null,
    });
    (options || []).forEach(function (opt) {
      var active = opt.value === value;
      group.appendChild(
        h(
          "button.seg__item" + (active ? ".is-active" : ""),
          {
            type: "button",
            role: role === "group" ? "radio" : "tab",
            "aria-selected": role === "group" ? null : active ? "true" : "false",
            "aria-checked": role === "group" ? String(active) : null,
            title: opt.title || null,
            onclick: function () {
              if (active) return;
              onChange(opt.value);
            },
          },
          opt.icon ? icon(opt.icon, 15) : null,
          /* opt.node：分段项前面的自定义节点（平台方块、信号条等）。
             「静流」组件样张里收件箱的平台筛选就是「方块 + 名称 + 计数」。 */
          opt.node || null,
          h("span", { text: opt.label }),
          /* opt.count：等宽计数。样张里写成 .n，和 .seg 的字重体系统一。 */
          opt.count === undefined || opt.count === null
            ? null
            : h("span.n", { text: String(opt.count) })
        )
      );
    });
    return group;
  };

  /* ---------------- 通用小组件 ---------------- */

  /* 状态徽标：ok / warn / bad / info */
  ui.badge = function (text, tone) {
    return h("span.badge" + (tone ? ".badge--" + tone : ""), { text: text });
  };

  /* 状态点：最近任务、连接状态 */
  ui.statusDot = function (tone, title) {
    return h("span.status-dot" + (tone ? ".status-dot--" + tone : ""), {
      title: title || null,
      "aria-hidden": "true",
    });
  };

  /* 分段队列条：完成 / 进行中 / 失败三段拼成一条。
     segments: [{value: 0~1, color: cssColor, run?: bool}] */
  ui.queueBar = function (segments) {
    return h(
      "div.queue",
      null,
      segments.map(function (s) {
        return h("i" + (s.run ? ".run" : ""), {
          style: { width: Math.max(0, Math.min(1, s.value)) * 100 + "%", "--qc": s.color || null },
        });
      })
    );
  };

  /* ---------------- 标签输入 ---------------- */

  /* 标签输入：已加的词以标签形式列出，右边跟一条数量上限读数。
     opts: {placeholder, max}——max 存在时才显示「N / max」。 */
  ui.tagInput = function (initial, onChange, opts) {
    opts = opts || {};
    var tags = (initial || []).slice();
    var list = h("span.row.row-gap-2", { style: { "flex-wrap": "wrap", gap: "6px" } });
    var input = h("input", {
      placeholder: opts.placeholder || "输入标签，回车添加",
      "aria-label": opts.placeholder || "添加标签",
      onkeydown: function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Backspace" && !input.value && tags.length) {
          tags.pop();
          paint();
          onChange && onChange(tags);
        }
      },
    });
    var counter = opts.max ? h("span.tag-input__count.mono") : null;

    function commit() {
      var v = input.value.trim();
      if (v && tags.indexOf(v) < 0) {
        tags.push(v);
        input.value = "";
        paint();
        onChange && onChange(tags);
      }
    }

    function paint() {
      list.textContent = "";
      tags.forEach(function (t, i) {
        list.appendChild(
          h(
            "span.tag-input__tag",
            null,
            h("span", { text: t }),
            h(
              "button",
              {
                type: "button",
                "aria-label": "移除标签 " + t,
                onclick: function () {
                  tags.splice(i, 1);
                  paint();
                  onChange && onChange(tags);
                },
              },
              icon("close", 9)
            )
          )
        );
      });
      if (counter) counter.textContent = tags.length + " / " + opts.max;
    }

    paint();
    var wrap = h("div.tag-input", { onclick: function () { input.focus(); } }, list, input, counter);
    wrap._getTags = function () {
      return tags.slice();
    };
    return wrap;
  };

  SF.ui = ui;
})(window);
