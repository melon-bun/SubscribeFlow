/* ==========================================================================
   分段控件滑块动画
   所有 .seg / .segment 在切换选中项时，浮起滑块从旧位置滑到新位置。

   - 视图整块重渲染时 dom.js 的 reconciler 会删掉多余子节点、
     抹掉不在新模板里的 class / style，所以滑块不能是真实节点或内联样式：
     它画在分组自己的 ::before 上，位置和外观全部由 Web Animations 驱动。
   - 静止时什么都不改：选中项仍由按钮自己的 .is-active 样式绘制，
     滑块只在动画期间出现，结束后把位置交还按钮（M35 样式对拍不受影响）。
   - 切换后分组常被整块换掉，且一次切换可能连续重绘两次
     （先 navigate 再 renderContent）：点击时记下旧位置，新的选中项出现后起跑；
     动画途中分组又被换掉，就接到新分组上从当前位置继续。
   ========================================================================== */
(function (global) {
  "use strict";

  var SF = (global.SF = global.SF || {});

  var GROUP = ".seg, .segment";
  var DURATION = 260;
  var MIN_LEG = 90; // 中途接力时剩余时间的下限，太短看起来像跳
  var EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)"; // 与 tokens.css --ease 一致
  var WAIT = 1200; // 等待视图重绘的上限：部分切换要先等一次 RPC 才重渲染

  var reduced = global.matchMedia ? global.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var pending = null;
  var runs = new Set();
  var observing = false;
  var observer = new MutationObserver(check);

  function items(group) {
    return Array.prototype.filter.call(group.children, function (node) {
      return node.tagName === "BUTTON";
    });
  }

  function isActive(btn) {
    return btn.classList.contains("is-active") || btn.classList.contains("on");
  }

  function activeOf(group) {
    return items(group).filter(isActive)[0] || null;
  }

  function label(btn) {
    var text = btn.textContent;
    var count = btn.querySelector(".n");
    return (count ? text.replace(count.textContent, "") : text).trim();
  }

  /* 计数会随重绘变化（「全部 12」→「全部 11」），签名只取名称。 */
  function signature(group) {
    return (group.getAttribute("aria-label") || "") + "|" + items(group).map(label).join("|");
  }

  function box(rect) {
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  function runOf(group) {
    var found = null;
    runs.forEach(function (run) { if (run.group === group) found = run; });
    return found;
  }

  /* 滑块此刻的位置：中途再切或接力时从这里继续，而不是跳回起点。 */
  function thumbBox(run) {
    var t = run.thumb.effect.getComputedTiming().progress;
    if (t === null) t = 1;
    return {
      left: run.from.left + (run.to.left - run.from.left) * t,
      top: run.from.top + (run.to.top - run.from.top) * t,
      width: run.from.width + (run.to.width - run.from.width) * t,
      height: run.from.height + (run.to.height - run.from.height) * t,
    };
  }

  function look(btn) {
    var cs = getComputedStyle(btn);
    return { backgroundColor: cs.backgroundColor, boxShadow: cs.boxShadow, borderRadius: cs.borderRadius };
  }

  function end(run) {
    run.anims.forEach(function (anim) { anim.cancel(); });
    runs.delete(run);
    sync();
  }

  /* 只在有事要等时才监听整棵树，平时零开销。 */
  function sync() {
    var need = !!pending || runs.size > 0;
    if (need && !observing) {
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
      observing = true;
    } else if (!need && observing) {
      observer.disconnect();
      observing = false;
    }
  }

  /* 原分组被整块替换时，按签名找新分组；同名的有多个时取离旧位置最近的。 */
  function locate(group, sig, near) {
    if (group.isConnected) return group;
    var best = null, bestDist = Infinity;
    Array.prototype.forEach.call(document.querySelectorAll(GROUP), function (candidate) {
      if (signature(candidate) !== sig) return;
      var r = candidate.getBoundingClientRect();
      var d = Math.abs(r.left - near.left) + Math.abs(r.top - near.top);
      if (d < bestDist) { best = candidate; bestDist = d; }
    });
    return best;
  }

  function onClick(event) {
    if (reduced && reduced.matches) return;
    var btn = event.target.closest ? event.target.closest("button") : null;
    if (!btn || btn.disabled || isActive(btn)) return;
    var group = btn.parentElement;
    if (!group || !group.matches(GROUP)) return;
    var old = activeOf(group);
    var run = runOf(group);
    var from = run ? thumbBox(run) : old ? box(old.getBoundingClientRect()) : null;
    if (!old || !from || !from.width) return;
    pending = {
      group: group,
      sig: signature(group),
      index: items(group).indexOf(btn),
      old: old,
      from: from,
      // 动画中途旧按钮的底被压成透明，外观要取正在跑的那次。
      look: run ? run.look : look(old),
      until: performance.now() + WAIT,
    };
    sync();
  }

  function check() {
    if (pending) {
      var p = pending;
      if (performance.now() > p.until) {
        pending = null;
      } else {
        var group = locate(p.group, p.sig, p.from);
        var target = group ? items(group)[p.index] : null;
        if (target && isActive(target)) {
          pending = null;
          var prev = runOf(group) || runOf(p.group);
          if (prev) end(prev);
          start(group, target, p.from, p.look, p.sig, p.index, DURATION, p.old);
        }
      }
    }
    runs.forEach(function (run) {
      if (run.group.isConnected) return;
      var next = locate(run.group, run.sig, run.to);
      var target = next ? items(next)[run.index] : null;
      var at = thumbBox(run);
      var left = DURATION - (performance.now() - run.started);
      end(run);
      if (target && isActive(target) && left > 0) start(next, target, at, run.look, run.sig, run.index, Math.max(MIN_LEG, left), null);
    });
    sync();
  }

  function start(group, target, from, face, sig, index, duration, old) {
    var to = box(target.getBoundingClientRect());
    if (!to.width) return;
    // 有 contain: layout，::before 的包含块就是分组的内边距盒。
    var g = group.getBoundingClientRect();
    var ox = g.left + group.clientLeft;
    var oy = g.top + group.clientTop;
    function frame(r) {
      return {
        transform: "translate(" + (r.left - ox) + "px, " + (r.top - oy) + "px)",
        width: r.width + "px",
        height: r.height + "px",
        opacity: 1,
        backgroundColor: face.backgroundColor,
        boxShadow: face.boxShadow,
        borderRadius: face.borderRadius,
      };
    }
    var timing = { duration: duration, easing: EASE };
    var bare = [{ backgroundColor: "transparent", boxShadow: "none" }, { backgroundColor: "transparent", boxShadow: "none" }];

    var thumb = group.animate([frame(from), frame(to)], Object.assign({ pseudoElement: "::before" }, timing));
    var anims = [thumb, target.animate(bare, timing)];
    // 就地改 class 时旧按钮还在，压住它的淡出过渡，免得和滑块叠出两块底。
    if (old && old.isConnected && old.parentElement === group) anims.push(old.animate(bare, timing));

    var run = {
      group: group, sig: sig, index: index, look: face, thumb: thumb, anims: anims,
      from: from, to: to, started: performance.now() - (DURATION - duration),
    };
    runs.add(run);
    thumb.onfinish = function () {
      runs.delete(run);
      sync();
    };
  }

  document.addEventListener("click", onClick, true);

  SF.segGlide = { selector: GROUP, duration: DURATION };
})(window);
