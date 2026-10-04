/* ==========================================================================
   悬浮提示
   单个复用浮层 + 事件委托：视图整块重渲染时不必重新绑定，也不会留下游离监听。
   任何带 data-tip 的元素都会得到提示；data-tip-placement 可指定 top / bottom。
   ========================================================================== */
(function (global) {
  "use strict";

  var SF = (global.SF = global.SF || {});

  var TIP_ID = "sf-tooltip";
  var SHOW_DELAY = 260; // 扫过表格时不该闪一片
  var GAP = 8;          // 气泡与锚点的间距
  var MARGIN = 8;       // 距视口边缘的最小留白

  var el = null;
  var anchor = null;
  var showTimer = null;
  var suppressFocus = false; // 指针点击引起的聚焦不弹提示

  function layer() {
    if (!el) {
      el = document.createElement("div");
      el.className = "tooltip";
      el.id = TIP_ID;
      el.setAttribute("role", "tooltip");
      el.hidden = true;
      document.body.appendChild(el);
    }
    return el;
  }

  function hide() {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    if (anchor) {
      anchor.removeAttribute("aria-describedby");
      anchor = null;
    }
    if (el) el.hidden = true;
  }

  function show(target) {
    var text = target.getAttribute("data-tip");
    if (!text || !target.isConnected) return;
    var tip = layer();
    anchor = target;
    tip.textContent = text;
    tip.hidden = false;
    target.setAttribute("aria-describedby", TIP_ID);
    place(tip, target);
  }

  function place(tip, target) {
    var rect = target.getBoundingClientRect();
    var width = tip.offsetWidth;
    var height = tip.offsetHeight;
    var forced = target.getAttribute("data-tip-placement");
    var fitsBelow = rect.bottom + GAP + height <= window.innerHeight - MARGIN;
    var fitsAbove = rect.top - GAP - height >= MARGIN;
    // 默认下方；下方放不下而上方放得下时才翻上去
    var onTop = forced === "top" ? true : forced === "bottom" ? false : !fitsBelow && fitsAbove;

    var top = onTop ? rect.top - GAP - height : rect.bottom + GAP;
    var left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN));

    tip.style.left = Math.round(left) + "px";
    tip.style.top = Math.round(top) + "px";
    // 箭头对准锚点中心，同时不越过气泡圆角
    var shift = rect.left + rect.width / 2 - left;
    tip.style.setProperty("--tip-shift", Math.round(Math.max(10, Math.min(shift, width - 10))) + "px");
    tip.classList.toggle("tooltip--top", onTop);
  }

  function tipOf(node) {
    return node && node.closest ? node.closest("[data-tip]") : null;
  }

  document.addEventListener(
    "mouseover",
    function (e) {
      var t = tipOf(e.target);
      if (t === anchor) return; // 锚点内部移动，不必重来
      hide();
      if (t) {
        showTimer = setTimeout(function () {
          showTimer = null;
          show(t);
        }, SHOW_DELAY);
      }
    },
    true
  );

  document.addEventListener(
    "focusin",
    function (e) {
      var t = tipOf(e.target);
      hide();
      if (suppressFocus) {
        suppressFocus = false;
        return;
      }
      if (t) show(t); // 键盘聚焦立即给提示，不做延迟
    },
    true
  );

  document.addEventListener("focusout", hide, true);
  document.addEventListener("mouseleave", hide);

  document.addEventListener(
    "mousedown",
    function () {
      suppressFocus = true;
      hide();
      // 聚焦紧随本次点击发生，清掉标记就不会误伤之后的键盘聚焦
      setTimeout(function () {
        suppressFocus = false;
      }, 0);
    },
    true
  );

  // 捕获阶段才能覆盖任意祖先容器的滚动
  document.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") hide();
  }, true);

  window.addEventListener("resize", hide);
  window.addEventListener("blur", hide);

  SF.tooltip = { show: show, hide: hide };
})(window);
