/* ==========================================================================
   「留下点什么」笔记编辑区（M27）

   可复用组件：内容详情用它，M28 的笔记页也用它。

   几条不能破的规矩：
   - 草稿按内容 ID 分开存：换了条目再回来，文字还在；迟到的回包按请求序号
     丢弃，不会串到别的内容上。
   - 只选模板不落库：真正写进库的只有「保存」。
   - 已有笔记改成「不写笔记」要确认：确认成功才删。取消或失败就恢复原来的
     模板与文字。
   - 冲突不覆盖：草稿保留，并说清有更新的版本，由用户决定刷新还是用草稿覆盖。
   - 写笔记不改内容的处理状态、优先级与标签，也不触发自动打标：那些是内容
     自己的事。
   ========================================================================== */
(function (global) {
  "use strict";

  var SF = (global.SF = global.SF || {});
  var ui = SF.ui;
  var h = SF.dom.h;

  // 与 Core 的上限一致（总结 2000、心得 20000）。
  var SUMMARY_MAX = 2000;
  var TAKEAWAY_MAX = 20000;

  var TYPES = [
    { value: "none", label: "不写笔记" },
    { value: "general", label: "通用笔记" },
    { value: "project", label: "项目笔记" },
  ];

  var VERDICTS = [
    { value: "", label: "还没决定" },
    { value: "using", label: "在用" },
    { value: "watching", label: "观望" },
    { value: "dropped", label: "放弃" },
  ];

  // 内容 ID → 编辑区状态。草稿、已保存的笔记与异步请求序号都在这里。
  var states = {};

  function stateOf(itemId) {
    if (!states[itemId]) {
      states[itemId] = {
        itemId: itemId,
        loaded: false,
        loading: false,
        error: null,
        saving: false,
        touched: false,
        note: null,
        draft: blankDraft(),
        notice: null,
        conflict: false,
        seq: 0,
      };
    }
    return states[itemId];
  }

  function blankDraft() {
    return { template: "none", summary: "", takeaway: "", verdict: "", origin: null };
  }

  function draftOf(note) {
    if (!note) return blankDraft();
    return {
      template: note.template || "general",
      summary: note.summary || "",
      takeaway: note.takeaway || "",
      verdict: note.verdict || "",
      origin: note.summary_origin || null,
    };
  }

  function isDirty(st) {
    if (!st || !st.draft) return false;
    var base = draftOf(st.note);
    return (
      st.draft.template !== base.template ||
      st.draft.summary !== base.summary ||
      st.draft.takeaway !== base.takeaway ||
      (st.draft.verdict || "") !== (base.verdict || "")
    );
  }

  /** 和 Core 同一把尺子：总结与心得都空、也没有结论，就是没有笔记。 */
  function hasContent(draft) {
    return !!(String(draft.summary || "").trim() || String(draft.takeaway || "").trim() || draft.verdict);
  }

  /** 总结的来路：手写是 manual，改过 AI 草稿是 ai_edited，总结清空就没有来路。 */
  function originFor(st) {
    var draft = st.draft;
    if (!String(draft.summary || "").trim()) return null;
    var base = draftOf(st.note);
    if (draft.summary === base.summary) return base.origin || null;
    return base.origin === "ai" || base.origin === "ai_edited" ? "ai_edited" : "manual";
  }

  /* ---------------------------------------------------------------- 读取 */

  function refreshNote(itemId, client, keepDraft, done) {
    var st = stateOf(itemId);
    var seq = ++st.seq;
    st.loading = true;
    st.error = null;
    client.getNote(itemId).then(
      function (note) {
        if (st.seq !== seq) return; // 迟到的回包：丢弃，别串到别的内容上
        st.loading = false;
        st.loaded = true;
        st.note = note || null;
        if (!keepDraft) {
          st.touched = false;
          st.draft = draftOf(note);
        }
        if (done) done(st);
      },
      function (err) {
        if (st.seq !== seq) return;
        st.loading = false;
        st.error = err;
        if (done) done(st);
      }
    );
  }

  /* ---------------------------------------------------------------- 写入 */

  function save(itemId, client, done) {
    var st = stateOf(itemId);
    if (st.saving) {
      if (done) done(false);
      return;
    }
    var draft = st.draft;
    var payload = {
      template: draft.template === "none" ? "general" : draft.template,
      summary: draft.summary,
      takeaway: draft.takeaway,
      verdict: draft.verdict || null,
      summaryOrigin: originFor(st),
      expectedVersion: st.note ? st.note.version : null,
    };
    st.saving = true;
    st.notice = null;
    st.conflict = false;
    var seq = ++st.seq;
    client.saveNote(itemId, payload).then(
      function (note) {
        if (st.seq !== seq) return;
        st.saving = false;
        st.loaded = true;
        st.touched = false;
        st.note = note || null;
        st.draft = draftOf(note);
        st.notice = {
          tone: "success",
          text: note ? "笔记已保存。" : "这条内容现在没有笔记。",
        };
        if (done) done(true, note);
      },
      function (err) {
        if (st.seq !== seq) return;
        st.saving = false;
        if (err && err.code === "CONFLICT") {
          // 冲突不覆盖：草稿留着，并说清有更新的版本。
          st.conflict = true;
          st.notice = {
            tone: "danger",
            text: "这条笔记已经有更新的版本了。你写的文字还在，没有覆盖。",
          };
        } else {
          st.notice = { tone: "danger", text: (err && err.message) || "笔记没能保存。" };
        }
        if (done) done(false, err);
      }
    );
  }

  function remove(itemId, client, done) {
    var st = stateOf(itemId);
    if (st.saving || !st.note) {
      if (done) done(false);
      return;
    }
    st.saving = true;
    st.notice = null;
    var seq = ++st.seq;
    client.deleteNote(itemId, st.note.version).then(
      function () {
        if (st.seq !== seq) return;
        st.saving = false;
        st.loaded = true;
        st.touched = false;
        st.note = null;
        st.draft = blankDraft();
        st.notice = { tone: "success", text: "笔记已删除。原内容和处理状态保留。" };
        if (done) done(true);
      },
      function (err) {
        if (st.seq !== seq) return;
        st.saving = false;
        st.notice = { tone: "danger", text: (err && err.message) || "笔记没能删除。" };
        if (done) done(false, err);
      }
    );
  }

  /* ---------------------------------------------------------------- 组件 */

  /**
   * 渲染一个编辑区。opts: { itemId, item, client, onChanged }
   * onChanged 在保存或删除成功后调用：内容列表要跟着更新「有笔记」标记。
   */
  function noteEditor(opts) {
    opts = opts || {};
    var itemId = opts.itemId;
    var client = opts.client;
    var st = stateOf(itemId);
    var box = h("div.note-editor", {
      "data-refresh-key": "note:" + itemId,
      "data-note-editor": itemId,
      "data-refresh-boundary": true,
    });

    /** 局部重画：只在自己还挂在文档里时用（初次构建）。 */
    function paint() {
      box.setAttribute("data-refresh-key", "note:" + itemId + ":" + ((st.draft && st.draft.template) || "none"));
      SF.dom.render(box, [head(), body()]);
    }

    /**
     * 结构变了要重画整个视图，而不是往自己这个节点上写：
     * 后台刷新可能已经把这个节点换掉了，往脱离文档的节点上画没有意义。
     * 草稿在模块状态里，重画不会丢字。
     */
    function repaint() {
      if (opts.repaint) {
        opts.repaint();
        return;
      }
      if (SF.app && SF.app.state && SF.app.state.route) SF.app.renderView(SF.app.state.route.name);
    }

    function head() {
      var draft = st.draft || blankDraft();
      return h(
        "div.note-editor__head",
        null,
        h("div.detail__section-title", { text: "留下点什么" }),
        h("div.spacer"),
        ui.select(
          TYPES,
          draft.template,
          function (value) {
            changeType(itemId, value, client, opts, repaint);
          },
          { ariaLabel: "笔记类型" }
        )
      );
    }

    function body() {
      var draft = st.draft || blankDraft();
      var children = [];
      if (st.error) {
        children.push(
          h("p.field__error", { role: "status", text: "笔记读取失败：" + (st.error.message || "") })
        );
        children.push(
          ui.btn("重试", {
            onClick: function () {
              refreshNote(itemId, client, true, repaint);
            },
          })
        );
        return children;
      }
      if (st.loading && !st.loaded) {
        children.push(h("p.field__hint", { text: "正在读取笔记…" }));
        return children;
      }
      if (draft.template === "none") {
        children.push(hintBox(draft, opts));
        return children;
      }
      children.push(hintBox(draft, opts));
      children.push(fields(draft, st));
      children.push(actions(draft, st));
      children.push(status(draft, st));
      return children;
    }

    function hintBox(draft, options) {
      var item = options.item || {};
      var lines = [];
      if (draft.template === "none") {
        lines.push("这条内容可以不写笔记。");
        lines.push("照常阅读、稍后处理或归档。想记点什么时，再选择笔记类型。");
        if (String(item.platform || "").toLowerCase() === "github") {
          // 只给建议，不替用户选，也不预选「观望」。
          lines.push("这条内容来自 GitHub，通常是工具或项目，可以考虑记一条项目笔记。");
        }
      } else if (draft.template === "general") {
        lines.push("通用笔记：写一句总结，再记下自己的收获或打算用在哪。");
      } else {
        lines.push("项目笔记：写清这个项目解决什么问题，标出你在用、观望还是放弃。");
      }
      return h(
        "div.note-editor__hint",
        null,
        lines.map(function (line) {
          return h("p.field__hint", { text: line });
        })
      );
    }

    function fields(draft, state) {
      var project = draft.template === "project";
      var children = [];
      children.push(
        h(
          "div.field",
          null,
          h("span.field__label", { text: project ? "这个项目解决什么问题" : "总结" }),
          h("textarea.input.note-editor__input", {
            "aria-label": project ? "这个项目解决什么问题" : "总结",
            placeholder: project ? "这个项目解决什么问题？" : "这条内容讲了什么？",
            maxlength: SUMMARY_MAX,
            value: draft.summary,
            oninput: function (e) {
              state.draft.summary = e.target.value;
              state.touched = true;
              refreshStatus();
            },
          })
        )
      );
      if (project) {
        children.push(
          h(
            "div.field",
            null,
            h("span.field__label", { text: "在用／观望／放弃" }),
            ui.select(
              VERDICTS,
              draft.verdict || "",
              function (value) {
                state.draft.verdict = value;
                state.touched = true;
                refreshStatus();
              },
              { ariaLabel: "项目结论" }
            )
          )
        );
      }
      children.push(
        h(
          "div.field",
          null,
          h("span.field__label", { text: project ? "我的判断／使用心得" : "我的收获／打算用在哪" }),
          h("textarea.input.note-editor__input", {
            "aria-label": project ? "我的判断／使用心得" : "我的收获／打算用在哪",
            placeholder: project ? "你打算怎么用它？" : "你打算拿它做什么？",
            maxlength: TAKEAWAY_MAX,
            value: draft.takeaway,
            oninput: function (e) {
              state.draft.takeaway = e.target.value;
              state.touched = true;
              refreshStatus();
            },
          })
        )
      );
      return h("div.note-editor__fields", null, children);
    }

    function actions(draft, state) {
      var canSave = hasContent(draft) || !!state.note;
      var buttons = [
        ui.btn("保存笔记", {
          variant: "primary",
          disabled: state.saving || !canSave,
          onClick: function () {
            save(itemId, client, function (ok) {
              repaint();
              if (ok && opts.onChanged) opts.onChanged();
            });
          },
        }),
      ];
      if (state.note) {
        buttons.push(
          ui.btn("删除这条笔记", {
            variant: "ghost",
            disabled: state.saving,
            onClick: function () {
              ui.confirm({
                title: "删除这条笔记？",
                message: "删除这条笔记？原内容和处理状态会保留。",
                confirmText: "删除",
                danger: true,
              }).then(function (ok) {
                if (!ok) return;
                remove(itemId, client, function (done) {
                  repaint();
                  if (done && opts.onChanged) opts.onChanged();
                });
              });
            },
          })
        );
      }
      return h("div.note-editor__actions", null, buttons);
    }

    function status(draft, state) {
      var line = h("p.note-editor__status", { role: "status" });
      var extra = [];
      if (state.notice) {
        line.textContent = state.notice.text;
        line.classList.add("is-" + (state.notice.tone || "danger"));
      } else if (state.note) {
        line.textContent = "已保存 · " + (state.note.updated_at || "") + "。保存后会出现在「笔记」中。";
      } else {
        line.textContent = "保存后会出现在「笔记」中。";
      }
      if (state.conflict) {
        extra.push(
          ui.btn("刷新（放弃我的文字）", {
            size: "sm",
            onClick: function () {
              refreshNote(itemId, client, false, repaint);
            },
          })
        );
        extra.push(
          ui.btn("用我的文字覆盖", {
            size: "sm",
            variant: "danger",
            onClick: function () {
              // 明确的覆盖：先取回较新的版本，再用它当令牌保存。
              refreshNote(itemId, client, true, function () {
                save(itemId, client, function (ok) {
                  repaint();
                  if (ok && opts.onChanged) opts.onChanged();
                });
              });
            },
          })
        );
      }
      if (!extra.length) return line;
      return h("div.note-editor__status-row", null, line, h("div.note-editor__actions", null, extra));
    }

    /** 只改提示文字，不重建输入框：正在打字时不能把光标弄丢。 */
    function refreshStatus() {
      var old = box.querySelector(".note-editor__status");
      if (!old) return;
      var next = status(st.draft || blankDraft(), st);
      if (old.textContent !== next.textContent) old.textContent = next.textContent;
      old.className = next.className;
      var saveBtn = box.querySelector(".note-editor__actions .btn--primary");
      if (saveBtn) {
        saveBtn.disabled = st.saving || !(hasContent(st.draft || blankDraft()) || !!st.note);
      }
    }

    paint();
    if (!st.loaded && !st.loading) refreshNote(itemId, client, true, repaint);
    return box;
  }

  /* ---------------------------------------------------------------- 切换 */

  function changeType(itemId, value, client, opts, repaint) {
    var st = stateOf(itemId);
    var draft = st.draft || blankDraft();
    var previous = draft.template;
    if (value === previous) return;

    // 项目 → 通用：结论没有了要问一句，但总结与心得留着。
    if (previous === "project" && value === "general" && draft.verdict) {
      ui.confirm({
        title: "改成通用笔记",
        message: "通用笔记没有「在用／观望／放弃」。清掉这个结论后，总结和收获会保留。",
        confirmText: "清掉结论",
      }).then(function (ok) {
        if (!ok) {
          repaint();
          return;
        }
        draft.template = value;
        st.draft.verdict = "";
        st.touched = true;
        repaint();
      });
      return;
    }

    if (value === "none") {
      if (st.note) {
        // 已有笔记改成不写：明确确认，确认成功才删。
        ui.confirm({
          title: "删除这条笔记？",
          message: "删除这条笔记？原内容和处理状态会保留。",
          confirmText: "删除",
          danger: true,
        }).then(function (ok) {
          if (!ok) {
            repaint();
            return;
          }
          remove(itemId, client, function (done) {
            repaint();
            if (done && opts.onChanged) opts.onChanged();
          });
        });
        return;
      }
      if (hasContent(draft)) {
        // 没保存过但写了东西：确认放弃，空草稿才直接收起。
        ui.confirm({
          title: "放弃还没保存的内容？",
          message: "你写的内容还没有保存。改成「不写笔记」会放弃这些文字。",
          confirmText: "放弃",
          danger: true,
        }).then(function (ok) {
          if (!ok) {
            repaint();
            return;
          }
          st.touched = false;
          st.draft = blankDraft();
          repaint();
        });
        return;
      }
      st.touched = false;
      st.draft = blankDraft();
      repaint();
      return;
    }

    draft.template = value;
    st.touched = true;
    repaint();
  }

  /* ---------------------------------------------------------------- 离开 */

  /** 有未保存的文字时，离开前问一句：保存、放弃还是继续编辑。 */
  function confirmLeave(app, itemId) {
    var st = states[itemId];
    if (!st || !isDirty(st)) return Promise.resolve(true);
    var client = app.client;
    return new Promise(function (resolve) {
      var settled = false;
      var layer;
      function done(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }
      layer = ui.dialog({
        title: "这条笔记还有未保存的内容",
        body: h(
          "div.note-editor__leave",
          null,
          h("p.field__hint", {
            text: "你在这条内容上写的文字还没有保存。可以先保存，也可以放弃这些文字直接离开。",
          })
        ),
        footer: [
          h("div.spacer"),
          ui.btn("继续编辑", {
            onClick: function () {
              done(false);
              layer.close();
            },
          }),
          ui.btn("放弃内容", {
            variant: "danger",
            onClick: function () {
              st.touched = false;
              st.draft = draftOf(st.note);
              done(true);
              layer.close();
            },
          }),
          ui.btn("保存并离开", {
            variant: "primary",
            disabled: st.saving,
            onClick: function () {
              save(itemId, client, function (ok) {
                done(ok);
                layer.close();
              });
            },
          }),
        ],
        // 通用关闭路径（Escape、右上角关闭、点遮罩）必须结算，
        // 否则这个 Promise 永远悬着，导航锁也解不开（BUG-105）。
        onClose: function () {
          done(false);
        },
      });
    });
  }

  function hasDirty(itemId) {
    var st = states[itemId];
    return !!(st && isDirty(st));
  }

  function dirtyIds() {
    return Object.keys(states).filter(function (itemId) {
      return isDirty(states[itemId]);
    });
  }

  /** 丢掉某个内容的本地状态（确认放弃之后用）。 */
  function forget(itemId) {
    delete states[itemId];
  }

  SF.noteUi = {
    noteEditor: noteEditor,
    confirmLeave: confirmLeave,
    hasDirty: hasDirty,
    dirtyIds: dirtyIds,
    forget: forget,
    refreshNote: refreshNote,
  };
})(window);
