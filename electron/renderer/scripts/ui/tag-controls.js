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
   * 一条内容上的标签编辑器：已选标签可逐个移除，未选的启用标签从下拉里添加。
   * 不直接发请求，由调用方在 onChange 里调用 setContentTags / bulkSetTags。
   */
  controls.tagEditor = function (opts) {
    var selected = (opts.selected || []).slice();
    var chosen = {};
    selected.forEach(function (t) {
      chosen[t.id] = true;
    });
    var wrap = h("div.tag-editor", null);
    var chips = h("div.tag-editor__chips");

    function paint() {
      while (chips.firstChild) chips.removeChild(chips.firstChild);
      if (!selected.length) {
        chips.appendChild(h("span.muted", { text: opts.emptyHint || "还没有标签" }));
      }
      selected.forEach(function (tag) {
        chips.appendChild(
          controls.tagChip(tag, {
            removable: true,
            onRemove: function () {
              selected = selected.filter(function (t) {
                return t.id !== tag.id;
              });
              delete chosen[tag.id];
              paint();
              opts.onChange(selected.slice());
            }
          })
        );
      });
      /* 停用标签不再参与新归类，但已有归类仍要能显示和移除。 */
      var available = (opts.allTags || []).filter(function (t) {
        return !chosen[t.id] && t.enabled !== false;
      });
      var picker = ui.select(
        [{ value: "", label: available.length ? "添加标签" : "没有更多标签" }].concat(
          available.map(function (t) {
            return { value: t.id, label: t.name };
          })
        ),
        "",
        function (value) {
          if (!value) return;
          var tag = available.filter(function (t) {
            return t.id === value;
          })[0];
          if (!tag) return;
          chosen[value] = true;
          selected.push({ id: tag.id, name: tag.name, color: tag.color });
          paint();
          opts.onChange(selected.slice());
        },
        { ariaLabel: opts.selectLabel || "添加标签", small: true }
      );
      picker.setAttribute("data-tag-add", "");
      picker.disabled = !available.length;
      chips.appendChild(picker);
    }

    paint();
    wrap.appendChild(chips);
    wrap.paint = paint;
    return wrap;
  };

  SF.tagUi = controls;
})(window);
