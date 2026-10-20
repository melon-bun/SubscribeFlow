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
        var event = key.slice(2).toLowerCase();
        el.addEventListener(event, value);
        (el.__sfEvents || (el.__sfEvents = {}))[event] = value;
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

  /** 保存实际滚动容器的状态，加载占位不覆盖上一次列表位置。 */
  function renderWithScroll(parent, children, positions) {
    function containers() {
      var nodes = Array.from(parent.querySelectorAll('.scroll-y'));
      if (parent.matches('.scroll-y')) nodes.unshift(parent);
      var occurrences = {};
      return nodes.map(function (node) {
        var scope = node.closest('[data-scroll-scope]');
        var name = node.dataset.scrollKey || node.className;
        var base = JSON.stringify([scope ? scope.dataset.scrollScope : '', name]);
        var index = occurrences[base] || 0;
        occurrences[base] = index + 1;
        return {node: node, key: base + ':' + index};
      });
    }
    containers().forEach(function (entry) {
      if (entry.node.dataset.scrollReady === 'false') return;
      positions.delete(entry.key);
      positions.set(entry.key, {top: entry.node.scrollTop, left: entry.node.scrollLeft});
    });
    // 只保存少量界面状态，避免长期切换筛选累积无限历史。
    while (positions.size > 100) positions.delete(positions.keys().next().value);
    render(parent, children);
    containers().forEach(function (entry) {
      var position = positions.get(entry.key);
      if (!position || entry.node.dataset.scrollReady === 'false') return;
      entry.node.scrollTop = position.top;
      entry.node.scrollLeft = position.left;
    });
    return parent;
  }

  function refreshKey(node) {
    if (node.nodeType !== 1) return null;
    return node.getAttribute('data-refresh-key') || node.id ||
      (node.hasAttribute('data-content-id') ? 'content:' + node.getAttribute('data-content-id') : null);
  }

  function compatible(old, fresh) {
    return old && old.nodeType === fresh.nodeType &&
      (old.nodeType !== 1 || (old.tagName === fresh.tagName && refreshKey(old) === refreshKey(fresh) &&
        (refreshKey(old) || old.classList[0] === fresh.classList[0])));
  }

  function syncEvents(old, fresh) {
    Object.entries(old.__sfEvents || {}).forEach(function (entry) { old.removeEventListener(entry[0], entry[1]); });
    old.__sfEvents = fresh.__sfEvents || {};
    Object.entries(old.__sfEvents).forEach(function (entry) { old.addEventListener(entry[0], entry[1]); });
  }

  function reconcileNode(old, fresh) {
    if (old === fresh) return old;
    if (!compatible(old, fresh)) { old.replaceWith(fresh); return fresh; }
    if (old.nodeType !== 1) {
      if (old.nodeValue !== fresh.nodeValue) old.nodeValue = fresh.nodeValue;
      return old;
    }
    var preserve = old.getAttribute('data-refresh-preserve');
    if (preserve !== null && (preserve === 'always' || preserve === fresh.getAttribute('data-refresh-preserve'))) return old;
    var active = document.activeElement;
    // Local controls may close over their original DOM. Replace an entire
    // interactive boundary, never graft its new callbacks onto old containers.
    var boundary = old.hasAttribute('data-refresh-boundary') || old.classList.contains('select');
    if (boundary) {
      var controls = Array.from(old.querySelectorAll('input,textarea,select,option'));
      var nextControls = Array.from(fresh.querySelectorAll('input,textarea,select,option'));
      var sameControls = controls.length === nextControls.length && controls.every(function (node, index) {
        var next = nextControls[index];
        return node.value === next.value && node.checked === next.checked && node.selected === next.selected && node.disabled === next.disabled;
      });
      if (old.contains(active) && active.matches('textarea,select,input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),[contenteditable]')) {
        // A background change must not close the control under the keyboard.
        // Once focus leaves it, repaint from current data instead of leaving a
        // stale label/callback indefinitely.
        if (!old.__sfRefreshOnBlur) {
          old.__sfRefreshOnBlur = true;
          var route = SF.app && SF.app.state.route.name;
          old.addEventListener('focusout', function () {
            setTimeout(function () {
              if (old.isConnected && !old.contains(document.activeElement) && SF.app) SF.app.renderView(route);
            }, 0);
          });
        }
        return old;
      }
      if (old.isEqualNode(fresh) && sameControls) return old;
      // Submitted buttons must receive their new state immediately. Restore
      // keyboard focus to the corresponding control when replacing a boundary.
      var focusPath = [], focused = old.contains(active), node = active;
      if (focused) while (node !== old) {
        focusPath.unshift(Array.prototype.indexOf.call(node.parentNode.children, node));
        node = node.parentNode;
      }
      old.replaceWith(fresh);
      if (focused) {
        var target = focusPath.reduce(function (parent, index) { return parent && parent.children[index]; }, fresh);
        if (target && target.focus && !target.disabled) target.focus({preventScroll:true});
      }
      return fresh;
    }
    syncEvents(old, fresh);
    Array.from(old.attributes).forEach(function (attr) { if (!fresh.hasAttribute(attr.name)) old.removeAttribute(attr.name); });
    Array.from(fresh.attributes).forEach(function (attr) {
      if (old.getAttribute(attr.name) !== attr.value) old.setAttribute(attr.name, attr.value);
    });
    if (old.matches('input,textarea,select')) {
      if (old !== active && old.value !== fresh.value) old.value = fresh.value;
      if ('checked' in old) old.checked = fresh.checked;
      old.disabled = fresh.disabled;
    }
    reconcileChildren(old, Array.from(fresh.childNodes));
    return old;
  }

  function reconcileChildren(parent, freshNodes) {
    var oldNodes = Array.from(parent.childNodes), used = new Set();
    var keyed = new Map();
    oldNodes.forEach(function (node) { var key = refreshKey(node); if (key) keyed.set(key, node); });
    var cursor = parent.firstChild;
    freshNodes.forEach(function (fresh) {
      var key = refreshKey(fresh), old = key ? keyed.get(key) : null;
      if (old && used.has(old)) old = null;
      if (!old && !key) old = oldNodes.find(function (node) { return !used.has(node) && !refreshKey(node) && compatible(node, fresh); });
      if (old) {
        used.add(old);
        var atCursor = old === cursor;
        var live = reconcileNode(old, fresh);
        if (atCursor) cursor = live;
        if (live !== cursor) parent.insertBefore(live, cursor);
        cursor = live.nextSibling;
      } else {
        parent.insertBefore(fresh, cursor);
        cursor = fresh.nextSibling;
      }
    });
    oldNodes.forEach(function (node) { if (!used.has(node) && node.parentNode === parent) node.remove(); });
  }

  /** Background repaint: keep node identity and the first visible content anchor. */
  function reconcileWithScroll(parent, children, positions) {
    var holding = document.createElement('div');
    if (children && typeof children[Symbol.iterator] === 'function' && !(children instanceof Node) && typeof children !== 'string') children = Array.from(children);
    append(holding, children);
    var scroll = Array.from(parent.querySelectorAll('.scroll-y, .tags-ai, .kanban__list, .day-panel__list'));
    if (parent.matches('.scroll-y, .tags-ai, .kanban__list, .day-panel__list')) scroll.unshift(parent);
    var saved = scroll.map(function (node) {
      var top = node.getBoundingClientRect().top;
      // M22：标签列表的行也带稳定标签 ID，和内容／优先级／日历项一样当锚点用：
      // 列表重排后视口最上面那条标签仍然停在原处。
      var anchor = node.scrollTop > 0 && Array.from(node.querySelectorAll('[data-content-id],[data-priority-item],[data-calendar-item],[data-tag-id]')).find(function (item) { return item.getBoundingClientRect().bottom > top; });
      return {node:node, top:node.scrollTop, left:node.scrollLeft, anchor:anchor, anchorTop:anchor && anchor.getBoundingClientRect().top};
    });
    var active = document.activeElement;
    var selection = document.getSelection(), ranges = [];
    if (selection && !selection.isCollapsed) for (var i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange());
    reconcileChildren(parent, Array.from(holding.childNodes));
    saved.forEach(function (entry) {
      if (!entry.node.isConnected) return;
      entry.node.scrollTop = entry.top;
      entry.node.scrollLeft = entry.left;
      if (entry.anchor && entry.anchor.isConnected) entry.node.scrollTop += entry.anchor.getBoundingClientRect().top - entry.anchorTop;
    });
    if (active && active.isConnected && document.activeElement !== active && active.focus) active.focus({preventScroll:true});
    if (ranges.length && selection && ranges.every(function (range) { return range.startContainer.isConnected && range.endContainer.isConnected; })) {
      selection.removeAllRanges(); ranges.forEach(function (range) { selection.addRange(range); });
    }
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

  SF.dom = { h: h, render: render, renderWithScroll: renderWithScroll, reconcileWithScroll: reconcileWithScroll, svg: svg, trapFocus: trapFocus, append: append };
})(window);
