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

  ui.platformTag = function (platformId) {
    var p = catalog.platform(platformId);
    return h("span.tag.tag--" + p.id, { text: p.name });
  };

  ui.platformIcon = function (platformId, opts) {
    opts = opts || {};
    var p = catalog.platform(platformId);
    return h(
      "span.plat.plat--" + p.id + (opts.large ? ".plat--lg" : ""),
      { title: p.name, "aria-label": p.name },
      p.mark
    );
  };

  ui.avatar = function (name, src, size) {
    var cls = "avatar" + (size ? ".avatar--" + size : "");
    if (src) {
      return h("span." + cls.split(" ").join("."), null, h("img", { src: src, alt: name, loading: "lazy" }));
    }
    return h("span." + cls.split(" ").join("."), { title: name, "aria-label": name }, (name || "?").slice(0, 1));
  };

  ui.priorityTag = function (priorityId) {
    var p = catalog.priority(priorityId);
    return h("span." + p.tagClass.replace("tag--", "tag.tag--"), { text: p.name });
  };

  ui.countPill = function (n, variant) {
    return h("span.count-pill" + (variant ? ".count-pill--" + variant : ""), {
      text: String(n),
    });
  };

  /* ---------------- 内容卡片 ---------------- */

  /**
   * 收件箱 / 优先级模式共用的内容卡片。
   * opts: { selected, onSelect, onToggleRead, onToggleArchive, onDefer, onBookmark, now }
   */
  ui.contentCard = function (item, opts) {
    opts = opts || {};
    var p = catalog.platform(item.platform);
    var prio = catalog.priority(item.priority);

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
        item.cover ? h("img", { src: item.cover, alt: "", loading: "lazy" }) : null
      ),
      h(
        "span.content-card__main",
        null,
        h("span.content-card__title", { text: item.title }),
        item.summary ? h("span.content-card__summary", { text: item.summary }) : null,
        h(
          "span.content-card__meta",
          null,
          h(
            "span.content-card__author",
            null,
            ui.avatar(item.channelName),
            h("span.t-ellipsis", { text: item.channelName })
          ),
          ui.platformTag(item.platform),
          ui.priorityTag(item.priority),
          h("span.content-card__dot", { text: "·" }),
          h("span.content-card__time", { text: fmt.publication(item, true) })
        ),
        item.tags && item.tags.length
          ? h(
              "span.content-card__tags",
              null,
              item.tags.map(function (t) {
                return ui.tag(t);
              })
            )
          : null,
        h(
          "span.content-card__foot",
          null,
          h(
            "span.content-card__link",
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

  /** 紧凑行：日历右侧列表、优先级看板复用 */
  ui.rowCard = function (item, opts) {
    opts = opts || {};
    var card = h(
      "button.row-card",
      { type: "button", onclick: opts.onSelect },
      h("span.row-card__thumb", null, item.cover ? h("img", { src: item.cover, alt: "", loading: "lazy" }) : null),
      h(
        "span.grow",
        null,
        h("span.row-card__title", { text: item.title }),
        item.summary ? h("span.row-card__summary", { text: item.summary }) : null,
        h(
          "span.row-card__meta",
          null,
          ui.avatar(item.channelName, null, "sm"),
          h("span.t-ellipsis", { text: item.channelName }),
          h("span.content-card__dot", { text: "·" }),
          ui.platformTag(item.platform),
          ui.priorityTag(item.priority),
          h("span.spacer"),
          h("span", { text: fmt.publication(item, true) })
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
   * items: [{ label, icon, danger, onClick }] 或 '-' 分隔线
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
          "button.menu__item" + (it.danger ? ".menu__item--danger" : ""),
          {
            type: "button",
            role: "menuitem",
            onclick: function () {
              ui.closeMenu();
              it.onClick && it.onClick();
            },
          },
          it.icon ? icon(it.icon, 14) : null,
          h("span", { text: it.label })
        );
      })
    );

    document.body.appendChild(el);
    var rect = anchor.getBoundingClientRect();
    var w = el.offsetWidth;
    var left = Math.min(rect.right - w, window.innerWidth - w - 8);
    var top = rect.bottom + 4;
    if (top + el.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - el.offsetHeight - 4);
    }
    el.style.left = Math.max(8, left) + "px";
    el.style.top = top + "px";
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

  /* ---------------- 统计卡 ---------------- */

  ui.stat = function (opts) {
    return h(
      "div.stat",
      null,
      h(
        "div.stat__icon.stat__icon--" + (opts.tone || "brand"),
        null,
        icon(opts.icon || "file-text", 18)
      ),
      h(
        "div.grow",
        null,
        h(
          "div.stat__value",
          null,
          h("span.stat__num", { text: String(opts.value) }),
          opts.trend !== undefined && opts.trend !== null
            ? h(
                "span.stat__trend.stat__trend--" + (opts.trend >= 0 ? "up" : "down"),
                null,
                icon(opts.trend >= 0 ? "trending-up" : "trending-down", 12),
                h("span", { text: Math.abs(opts.trend) + "%" })
              )
            : null
        ),
        h("div.stat__label", { text: opts.label })
      )
    );
  };

  /* ---------------- 标签输入 ---------------- */

  ui.tagInput = function (initial, onChange) {
    var tags = (initial || []).slice();
    var list = h("span.row.row-gap-2", { style: { "flex-wrap": "wrap", gap: "6px" } });
    var input = h("input", {
      placeholder: "输入标签，回车添加",
      "aria-label": "添加标签",
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
    }

    paint();
    var wrap = h("div.tag-input", { onclick: function () { input.focus(); } }, list, input);
    wrap._getTags = function () {
      return tags.slice();
    };
    return wrap;
  };

  SF.ui = ui;
})(window);
