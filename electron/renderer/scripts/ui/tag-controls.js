/* ==========================================================================
   标签控件（M9）
   --------------------------------------------------------------------------
   只做「颜色的统一入口」和标签的呈现/选取结构，不含任何业务判断、不发请求。
   所有控件都返回 DOM 节点，不持有状态；状态由 views/tags.js 与 views/inbox.js 持有。
   ========================================================================== */
(function (global) {
  "use strict";

  var SF = (global.SF = global.SF || {});
  var h = SF.dom.h;
  var ui = SF.ui;
  var icon = SF.icon;
  var tagCatalog = SF.tagCatalog;

  var controls = {};

  /* ---------------- 标签色块 ---------------- */

  /**
   * 标签色块：底色 + 文字，颜色取自色板。
   * 这是标签在页面里最主要的呈现形式，列表、内容卡片与详情共用。
   * origin 为 suggested 时加一个说明角标，避免人工标签与识别结果混为一谈。
   */
  controls.tagChip = function (tag, opts) {
    opts = opts || {};
    var c = tagCatalog.color(tag.color);
    var el = h(
      "span.tag-chip" + (opts.removable ? ".tag-chip--removable" : ""),
      {
        style: { "background-color": c.soft, color: c.ink },
        title: opts.title || tag.name,
        "data-tag-id": tag.id || ""
      },
      h("span.tag-chip__dot", { style: { "background-color": c.solid }, "aria-hidden": "true" }),
      h("span.tag-chip__text", { text: tag.name }),
      tag.origin === "suggested" ? h("span.tag-chip__origin", { text: "识别", title: "由自动识别建议，未经人工确认" }) : null
    );
    if (opts.onClick) {
      el.classList.add("is-clickable");
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        opts.onClick(tag);
      });
    }
    if (opts.onRemove) {
      el.appendChild(
        h(
          "button.tag-chip__remove",
          {
            type: "button",
            "aria-label": "移除标签 " + tag.name,
            title: "移除标签",
            onclick: function (e) {
              e.stopPropagation();
              opts.onRemove(tag);
            }
          },
          icon("close", 9)
        )
      );
    }
    return el;
  };

  /** 纯色点：表格「颜色」列与使用量条用，不带文字 */
  controls.colorDot = function (colorId, size) {
    var c = tagCatalog.color(colorId);
    return h("span.color-dot", {
      style: { "background-color": c.solid, width: size + "px", height: size + "px" },
      "aria-hidden": "true",
      title: c.name
    });
  };

  /** 使用量条：按使用次数排序的横向条，一眼看出哪些标签在真正承担分类 */
  controls.usageBar = function (count, max, colorId) {
    var pct = max > 0 ? Math.round((count / max) * 100) : 0;
    var c = tagCatalog.color(colorId);
    return h(
      "span.usage-bar",
      {
        role: "img",
        "aria-label": "使用 " + count + " 条，占比 " + pct + "%"
      },
      h("span.usage-bar__fill", {
        style: { width: Math.max(count > 0 ? pct : 0, count > 0 ? 2 : 0) + "%", "background-color": c.solid }
      })
    );
  };

  /* ---------------- 取色器 ---------------- */

  /**
   * 颜色选择器。当前色用实心圆点 + 描边表示，其余色板平铺。
   * 不用原生 <input type=color>：标签色是受控的 11 档，不该出现任意色值。
   */
  controls.colorPicker = function (current, onPick) {
    var wrap = h("div.swatches", { role: "radiogroup", "aria-label": "标签颜色" });
    tagCatalog.colorOptions().forEach(function (opt) {
      var c = tagCatalog.color(opt.id);
      var active = opt.id === current;
      wrap.appendChild(
        h(
          "button.swatch" + (active ? ".is-active" : ""),
          {
            type: "button",
            role: "radio",
            "aria-checked": active ? "true" : "false",
            "aria-label": opt.name,
            title: opt.name,
            "data-color": opt.id,
            style: { "background-color": c.solid },
            onclick: function () {
              onPick(opt.id);
            }
          },
          active ? icon("check", 11) : null
        )
      );
    });
    return wrap;
  };

  /* ---------------- 内容侧打标 ---------------- */

  /**
   * 一条内容上的标签编辑器：已挂载标签可逐个移除，其余从对话框里点选挂载。
   *
   * 用对话框而不是下拉：标签一多，原生下拉会被撑得很长，把详情面板顶出视口。
   * 对话框里已挂载与标签池同时可见，标签再多也只占一块固定高度。
   *
   * 改动先在对话框内累积，点「确认挂载」才写入，不每点一个就存一次。
   * 由调用方在 onChange 里调用 setContentTags / bulkSetTags。
   */
  controls.tagEditor = function (opts) {
    var selected = (opts.selected || []).slice();
    var wrap = h("div.tag-editor", null);
    var chips = h("div.tag-editor__chips");

    /* 停用标签不再参与新归类，但已有归类仍要能显示和移除。 */
    function pool() {
      return (opts.allTags || []).filter(function (t) {
        return t.enabled !== false;
      });
    }
    function findTag(id) {
      return (opts.allTags || []).filter(function (t) { return t.id === id; })[0];
    }

    function commit(ids) {
      selected = ids.map(function (id) {
        var tag = findTag(id);
        return tag || { id: id, name: id, color: "slate" };
      });
      paint();
      opts.onChange(selected.slice());
    }

    var trigger = ui.btn(opts.addLabel || "添加标签", {
      icon: "plus",
      size: "sm",
      onClick: function () {
        ui.tagPicker({
          // 托盘必须能解析停用的已有标签；新增候选由 tagPicker 单独过滤。
          tags: (opts.allTags || []).concat(selected.filter(function (tag) { return !findTag(tag.id); })),
          selected: selected.map(function (t) { return t.id; }),
          title: opts.selectLabel || "添加标签",
          // 回车新建的标签直接挂载，省掉「新建完还要再点一次」
          onCreate: opts.onCreateTag ? function (name, done) {
            opts.onCreateTag(name, function (tag) {
              if (!findTag(tag.id)) opts.allTags.push(tag);
              done(tag);
            });
          } : null,
          onConfirm: function (ids) {
            if (ids.length === selected.length && selected.every(function (tag) { return ids.indexOf(tag.id) >= 0; })) return;
            commit(ids);
          },
        });
      },
    });
    trigger.setAttribute("data-tag-add", "");
    trigger.setAttribute("aria-label", opts.selectLabel || "添加标签");
    chips.appendChild(trigger);

    function paint() {
      // 只换掉 trigger 前面的标签节点，trigger 本身保持同一个实例。
      while (chips.firstChild !== trigger) chips.removeChild(chips.firstChild);
      if (!selected.length) {
        chips.insertBefore(h("span.muted", { text: opts.emptyHint || "还没有标签" }), trigger);
      }
      selected.forEach(function (tag) {
        chips.insertBefore(
          controls.tagChip(tag, {
            removable: true,
            onRemove: function () {
              commit(selected.filter(function (t) { return t.id !== tag.id; })
                .map(function (t) { return t.id; }));
            }
          }),
          trigger
        );
      });
      trigger.disabled = !!opts.loading || (!pool().length && !selected.length);
    }

    paint();
    wrap.appendChild(chips);
    wrap.paint = paint;
    return wrap;
  };

  SF.tagUi = controls;
})(window);
