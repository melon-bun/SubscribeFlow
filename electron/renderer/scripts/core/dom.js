/* ==========================================================================
   轻量 DOM 工具
   不引入框架；只提供构建视图所需的最小能力。
   ========================================================================== */
(function (global) {
  "use strict";

  var SF = (global.SF = global.SF || {});

  /**
   * 创建元素。
   * h("div.card", { onclick: fn }, child, child)
   * 标签可写成 "button.btn.btn--primary" 简写类名。
   */
  function h(tag, props, children) {
    var parts = String(tag).split(".");
    var el = document.createElement(parts[0] || "div");
    if (parts.length > 1) {
      el.className = parts.slice(1).join(" ");
    }

    var start = 1;
    if (props && typeof props === "object" && !(props instanceof Node) && !Array.isArray(props)) {
      start = 2;
      applyProps(el, props);
    }

    for (var i = start; i < arguments.length; i++) {
      append(el, arguments[i]);
    }
    return el;
  }

  function applyProps(el, props) {
    Object.keys(props).forEach(function (key) {
      var value = props[key];
      if (value === null || value === undefined || value === false) return;

      if (key === "class" || key === "className") {
        el.className = el.className ? el.className + " " + value : String(value);
      } else if (key === "style" && typeof value === "object") {
        Object.keys(value).forEach(function (k) {
          el.style.setProperty(k, value[k]);
        });
      } else if (key === "dataset" && typeof value === "object") {
        Object.keys(value).forEach(function (k) {
          el.dataset[k] = value[k];
        });
      } else if (key === "text") {
        el.textContent = String(value);
      } else if (key === "html") {
        el.innerHTML = value;
      } else if (key.slice(0, 2) === "on" && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in el && key !== "list" && typeof value !== "object") {
        try {
          el[key] = value;
        } catch (e) {
          el.setAttribute(key, value);
        }
      } else {
        el.setAttribute(key, value === true ? "" : value);
      }
    });
  }

  function append(parent, child) {
    if (child === null || child === undefined || child === false || child === true) return;
    if (Array.isArray(child)) {
      child.forEach(function (c) {
        append(parent, c);
      });
      return;
    }
    if (child instanceof Node) {
      parent.appendChild(child);
      return;
    }
    parent.appendChild(document.createTextNode(String(child)));
  }

  /** 清空并写入新内容 */
  function render(parent, children) {
    parent.textContent = "";
    append(parent, children);
    return parent;
  }

  /** 由 SVG 字符串创建节点（图标全部走这里） */
  function svg(markup) {
    var wrap = document.createElement("div");
    wrap.innerHTML = markup;
    return wrap.firstElementChild;
  }

  /** 焦点陷阱：弹层打开时把 Tab 键限制在容器内 */
  function trapFocus(container, event) {
    var focusables = container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  SF.dom = { h: h, render: render, svg: svg, trapFocus: trapFocus, append: append };
})(window);
