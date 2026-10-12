/* ==========================================================================
   视图：设置（M15）
   --------------------------------------------------------------------------
   布局沿用参考图：大面板 + 左侧导航 + 右侧分区表单 + 底部操作区。
   本期左栏只有「AI 模型配置」「提醒设置」两项，图片里的其他导航不进入本期。

   交互按开发方案 §2：
   - 编辑只改草稿，保存成功才生效；失败保留输入并把原因落到对应输入框下面；
   - 按页保存：只提交当前分区，不会把另一页没填完的 API 配置一起存进去；
   - 离开有未保存修改的页面时先问保存还是放弃；
   - 密钥明文只在输入框和提交那一刻存在，保存后草稿里立刻清掉，界面永不回显。

   连接测试在 M15 不可用：真实识别调用属于 M16，这里如实说明，不用模拟结果充数。
   ========================================================================== */
(function (global) {
  "use strict";

  var SF = global.SF;
  var h = SF.dom.h;
  var ui = SF.ui;
  var icon = SF.icon;
  var fmt = SF.fmt;

  var MODES = ["jev", "llm"];
  var INTERVAL_MIN = 5;
  var INTERVAL_MAX = 1440;
  var INTERVAL_PRESETS = [
    { value: "15", label: "每 15 分钟" },
    { value: "30", label: "每 30 分钟" },
    { value: "60", label: "每 60 分钟" },
    { value: "120", label: "每 120 分钟" },
    { value: "custom", label: "自定义" },
  ];

  var SECTIONS = [
    {
      id: "tagging",
      label: "AI 模型配置",
      icon: "zap",
      title: "AI 模型配置",
      desc: "配置识别模型与 API。自动打标接在信息采集之后，只添加标签，不覆盖你的手动整理。",
    },
    {
      id: "reminder",
      label: "提醒设置",
      icon: "clock",
      title: "提醒设置",
      desc: "按固定间隔提醒还有多少内容未处理。",
    },
  ];

  var MODE_META = {
    jev: {
      label: "Jev 已有标签分类",
      desc: "从你已经创建并启用的标签里挑选合适的，不新建标签。",
      defaults: { endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest" },
    },
    llm: {
      label: "LLM 自由生成标签",
      desc: "由模型判断该用哪些标签，必要时可以新建标签并挂载。",
      defaults: null,
    },
  };

  /* ---------------- 状态 ---------------- */

  var cache = {
    loaded: false,
    loading: false,
    error: null,
    saved: null, // 最近一次读到的脱敏设置，同时充当「已保存」的基线
    draft: null,
    errors: {}, // 字段路径 -> 原因，例如 jev.endpoint
    notice: null,
    saving: null,
    section: "tagging",
    editing: { jev: false, llm: false }, // 是否正在替换密钥
    cleared: { jev: false, llm: false }, // 是否已勾选清除
    notification: null,
    testing: false,
  };

  function emptyDraft() {
    return {
      tagging: {
        enabled: false,
        mode: "llm",
        providers: {
          jev: { endpoint: "", model: "", secret: "" },
          llm: { endpoint: "", model: "", secret: "" },
        },
      },
      reminder: { enabled: false, preset: "60", interval: 60 },
    };
  }

  /** 用读到的设置铺草稿：未保存过的字段显示官方默认值，用户一眼知道该填什么。 */
  function draftFrom(settings) {
    var draft = emptyDraft();
    var tagging = settings.tagging;
    draft.tagging.enabled = !!tagging.enabled;
    draft.tagging.mode = tagging.mode;
    MODES.forEach(function (mode) {
      var saved = tagging.providers[mode] || {};
      var defaults = (MODE_META[mode].defaults) || {};
      draft.tagging.providers[mode].endpoint = saved.endpoint || defaults.endpoint || "";
      draft.tagging.providers[mode].model = saved.model || defaults.model || "";
    });
    var interval = settings.reminder.intervalMinutes;
    draft.reminder.enabled = !!settings.reminder.enabled;
    draft.reminder.interval = interval;
    draft.reminder.preset = INTERVAL_PRESETS.some(function (p) { return p.value === String(interval); })
      ? String(interval)
      : "custom";
    return draft;
  }

  function reset() {
    cache.loaded = false;
    cache.loading = false;
    cache.error = null;
    cache.saved = null;
    cache.draft = null;
    cache.errors = {};
    cache.notice = null;
    cache.saving = null;
    cache.editing = { jev: false, llm: false };
    cache.cleared = { jev: false, llm: false };
    cache.testing = false;
  }

  function load(app, opts) {
    opts = opts || {};
    if (cache.loading) return Promise.resolve();
    if (cache.loaded && !opts.force) return Promise.resolve();
    cache.loading = true;
    cache.error = null;
    paint(app);
    return app.client
      .getSettings()
      .then(function (settings) {
        cache.saved = settings;
        cache.loaded = true;
        // 只有在没有草稿时才重新铺：加载失败后重试不能吃掉用户正在输入的内容。
        if (!cache.draft) cache.draft = draftFrom(settings);
      })
      .catch(function (err) {
        cache.error = err.message;
      })
      .then(function () {
        cache.loading = false;
        paint(app);
      });
  }

  function paint(app) {
    SF.app.renderContent();
  }

  /* ---------------- 草稿与脏检查 ---------------- */

  function currentSection() {
    return cache.section === "reminder" ? "reminder" : "tagging";
  }

  function sectionDraft(section) {
    return cache.draft ? cache.draft[section] : null;
  }

  /** 只比较当前分区：别的页有草稿不该让本页的保存按钮亮起来。 */
  function isDirty(section) {
    var target = section || currentSection();
    if (!cache.saved || !cache.draft) return false;
    if (target === "reminder") {
      var r = cache.draft.reminder;
      var saved = cache.saved.reminder;
      return r.enabled !== !!saved.enabled || Number(r.interval) !== Number(saved.intervalMinutes);
    }
    var t = cache.draft.tagging;
    var savedTagging = cache.saved.tagging;
    if (t.enabled !== !!savedTagging.enabled || t.mode !== savedTagging.mode) return true;
    var dirty = MODES.some(function (mode) {
      var savedProvider = savedTagging.providers[mode] || {};
      return (
        t.providers[mode].endpoint !== (savedProvider.endpoint || "") ||
        t.providers[mode].model !== (savedProvider.model || "") ||
        !!t.providers[mode].secret ||
        cache.cleared[mode]
      );
    });
    return dirty;
  }

  function dirtySections() {
    return SECTIONS.map(function (s) { return s.id; }).filter(function (id) { return isDirty(id); });
  }

  /* ---------------- 保存 ---------------- */

  function buildSaveParams(section) {
    if (section === "reminder") {
      var r = cache.draft.reminder;
      var minutes = r.preset === "custom" ? Number(r.interval) : Number(r.preset);
      return { section: "reminder", patch: { enabled: !!r.enabled, intervalMinutes: minutes } };
    }
    var t = cache.draft.tagging;
    var credentials = {};
    MODES.forEach(function (mode) {
      if (cache.cleared[mode]) credentials[mode] = null;
      else if (t.providers[mode].secret) credentials[mode] = t.providers[mode].secret;
    });
    return {
      section: "tagging",
      patch: {
        enabled: !!t.enabled,
        mode: t.mode,
        providers: {
          jev: { endpoint: t.providers.jev.endpoint, model: t.providers.jev.model },
          llm: { endpoint: t.providers.llm.endpoint, model: t.providers.llm.model },
        },
      },
      credentials: credentials,
    };
  }

  function saveSection(app, section) {
    var params = buildSaveParams(section);
    cache.saving = section;
    cache.notice = null;
    cache.errors = {};
    paint(app);
    return app.client
      .saveSettings(params)
      .then(function (settings) {
        cache.saved = settings;
        cache.loaded = true;
        // 密钥明文只在输入与提交期间存在：保存成功立刻从草稿里抹掉。
        MODES.forEach(function (mode) {
          cache.draft.tagging.providers[mode].secret = "";
          cache.cleared[mode] = false;
          cache.editing[mode] = false;
        });
        cache.notice = { tone: "success", text: "已保存设置" };
        return true;
      })
      .catch(function (err) {
        // 保存失败保留全部输入，原因落到对应输入框下方，顶栏再给一条整体说明。
        cache.notice = { tone: "danger", text: err.message };
        // Core 用 scope_key 报错，跨桥后原样带过来；两种写法都认，避免只在横幅里报。
        var key = err.scopeKey || err.scope_key;
        if (err.scope === "field" && key) cache.errors[key] = err.message;
        return false;
      })
      .then(function (ok) {
        cache.saving = null;
        paint(app);
        return ok;
      });
  }

  function cancelSection(app, section) {
    cache.draft = draftFrom(cache.saved);
    cache.errors = {};
    cache.notice = null;
    MODES.forEach(function (mode) {
      cache.editing[mode] = false;
      cache.cleared[mode] = false;
    });
    paint(app);
  }

  /* ---------------- 离开确认 ---------------- */

  function sectionLabel(id) {
    return SECTIONS.filter(function (s) { return s.id === id; })[0].label;
  }

  function confirmLeave(app) {
    var dirty = dirtySections();
    if (!dirty.length) return Promise.resolve(true);
    var current = currentSection();
    var currentDirty = dirty.indexOf(current) >= 0;
    var others = dirty.filter(function (id) { return id !== current; });
    var labels = dirty.map(sectionLabel);
    var note = null;
    if (currentDirty && others.length) {
      note =
        "本期按页保存：这里只会保存「" +
        sectionLabel(current) +
        "」，" +
        others.map(sectionLabel).join("、") +
        "的修改会一并放弃。";
    } else if (!currentDirty) {
      // 当前页没有草稿时说清楚：点保存不会写入任何东西，能做的只有放弃。
      note = "当前「" + sectionLabel(current) + "」没有未保存的修改，保存不会写入任何内容；「" + others.map(sectionLabel).join("、") + "」的修改会一并放弃。";
    }
    var body = h(
      "div.settings-leave",
      null,
      h("p.settings-leave__lead", {
        text: "「" + labels.join("、") + "」还有未保存的修改。可以先保存，也可以放弃这些修改直接离开。",
      }),
      note ? h("p.settings-leave__note", { text: note }) : null
    );
    return new Promise(function (resolve) {
      var settled = false;
      var layer;
      function done(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }
      layer = ui.dialog({
        title: "还有未保存的修改",
        body: body,
        footer: [
          h("div.spacer"),
          ui.btn("继续编辑", { onClick: function () { done(false); layer.close(); } }),
          ui.btn("放弃修改", {
            variant: "danger",
            onClick: function () {
              cache.draft = draftFrom(cache.saved);
              cache.errors = {};
              cache.notice = null;
              done(true);
              layer.close();
            },
          }),
          ui.btn("保存并离开", {
            variant: "primary",
            // 当前页没有草稿时不给可点的保存：按页保存，点了也写不进任何东西。
            disabled: !currentDirty || cache.saving === current,
            onClick: function () {
              saveSection(app, current).then(function (ok) {
                done(ok);
                layer.close();
              });
            },
          }),
        ],
        onClose: function () {
          done(false);
        },
      });
    });
  }

  /* ---------------- 通用片段 ---------------- */

  function field(label, control, opts) {
    opts = opts || {};
    var error = opts.error;
    return h(
      "div.field" + (error ? ".field--invalid" : ""),
      null,
      h("label.field__label", { text: label }),
      control,
      opts.hint ? h("p.field__hint", { text: opts.hint }) : null,
      error
        ? h(
            "p.field__error",
            { role: "alert", "data-error-key": opts.errorKey || null },
            icon("alert", 13),
            h("span", { text: error })
          )
        : null
    );
  }

  function textInput(value, onInput, opts) {
    opts = opts || {};
    return h("input.input.field__input", {
      type: opts.type || "text",
      value: value || "",
      placeholder: opts.placeholder || null,
      autocomplete: "off",
      spellcheck: "false",
      oninput: function (e) {
        onInput(e.target.value);
      },
    });
  }

  function switchRow(title, desc, on, onToggle, opts) {
    opts = opts || {};
    return h(
      "div.setting-row" + (opts.idle ? ".setting-row--idle" : ""),
      null,
      h(
        "div.setting-row__text",
        null,
        h("div.setting-row__title", { text: title }),
        desc ? h("p.setting-row__desc", { text: desc }) : null
      ),
      ui.toggle(on, onToggle, { label: title, disabled: !!opts.disabled })
    );
  }

  function badge(text, tone) {
    return h("span.badge" + (tone ? ".badge--" + tone : ""), { text: text });
  }

  /* ---------------- AI 模型配置 ---------------- */

  function buildProvider(app, mode) {
    var meta = MODE_META[mode];
    var draft = cache.draft.tagging.providers[mode];
    var state = (cache.saved && cache.saved.credentials.providers[mode]) || { configured: false, usable: false, unresolved: false };
    var protection = (cache.saved && cache.saved.credentials.protection) || { available: false, reason: "正在读取保护能力" };
    var active = cache.draft.tagging.mode === mode;
    var status = providerStatus(state, protection);

    var keyRow = buildKeyField(app, mode, state, protection, draft);
    var children = [
      h(
        "div.setting-block__head",
        null,
        h(
          "div",
          null,
          h("h3.setting-block__title", { text: meta.label }),
          h("p.setting-block__desc", { text: meta.desc })
        ),
        active ? badge("当前模式", "brand") : badge("已保留")
      ),
      h(
        "div.setting-block__status",
        null,
        badge(status.text, status.tone),
        h("span.setting-block__status-note", { text: status.note })
      ),
      field(
        "接口地址",
        textInput(draft.endpoint, function (value) {
          draft.endpoint = value;
          clearFieldError(mode + ".endpoint");
          refreshFoot(app);
        }, {
          placeholder: meta.defaults ? meta.defaults.endpoint : "https://api.example.com/v1",
        }),
        {
          hint: meta.defaults
            ? "官方默认地址与模型已预填，可以直接使用，也可以改成你自己的地址。"
            : "填写与本期适配器兼容的聊天接口地址；具体协议在自动打标接入时确定。",
          error: cache.errors[mode + ".endpoint"],
          errorKey: mode + ".endpoint",
        }
      ),
      field(
        "模型标识",
        textInput(draft.model, function (value) {
          draft.model = value;
          clearFieldError(mode + ".model");
          refreshFoot(app);
        }, { placeholder: meta.defaults ? meta.defaults.model : "模型名称" }),
        { hint: "服务侧的模型标识，不是显示别名。", error: cache.errors[mode + ".model"], errorKey: mode + ".model" }
      ),
      keyRow,
    ];
    if (meta.defaults) {
      children.push(
        h(
          "div.setting-block__foot",
          null,
          ui.btn("填入官方默认值", {
            size: "sm",
            onClick: function () {
              draft.endpoint = meta.defaults.endpoint;
              draft.model = meta.defaults.model;
              clearFieldError(mode + ".endpoint");
              clearFieldError(mode + ".model");
              paint(app);
            },
          })
        )
      );
    }
    return h("section.setting-block" + (active ? "" : ".setting-block--idle"), null, children);
  }

  function providerStatus(state, protection) {
    if (state.unresolved) {
      return { tone: "danger", text: "密钥缺失", note: "设置指向的密钥在凭据文件里找不到，请重新输入并保存。" };
    }
    if (state.configured && !state.usable) {
      return { tone: "danger", text: "密钥不可用", note: "已保存的密钥无法解密（系统密钥环可能已更换账户），请重新输入并保存。" };
    }
    if (state.configured) {
      return { tone: "success", text: "已保存", note: "配置完整。" + (state.updatedAt ? "最近更新：" + fmt.absolute(state.updatedAt) : "") };
    }
    if (!protection.available) {
      return { tone: "warn", text: "无法保存密钥", note: protection.reason || "当前系统没有可用的加密保护能力。" };
    }
    return { tone: "neutral", text: "未配置", note: "填齐接口地址、模型标识和 API Key 后才能保存完整配置。" };
  }

  function buildKeyField(app, mode, state, protection, draft) {
    var label = "API Key";
    var hint = "保存时用系统保护能力加密，写入应用数据目录；保存后不再回显，界面只显示是否已配置。";
    if (!protection.available) {
      return field(
        label,
        h("div.setting-key.is-blocked", null,
          icon("alert", 15),
          h("span", { text: protection.reason || "当前系统没有可用的加密保护能力，密钥不会保存。" })
        ),
        { hint: hint }
      );
    }
    if (state.unresolved || (state.configured && !state.usable)) {
      return field(
        label,
        h("div.setting-key", null,
          h("span.setting-key__state.is-danger", { text: state.unresolved ? "已保存的密钥找不到" : "已保存的密钥无法解密" }),
          ui.btn("重新输入", {
            size: "sm",
            variant: "primary",
            onClick: function () {
              cache.editing[mode] = true;
              paint(app);
            },
          })
        ),
        { hint: hint }
      );
    }
    if (state.configured && !cache.cleared[mode] && !draft.secret && !cache.editing[mode]) {
      return field(
        label,
        h("div.setting-key", null,
          h("span.setting-key__state", { text: "已保存（不回显）" }),
          ui.btn("替换", {
            size: "sm",
            onClick: function () {
              cache.editing[mode] = true;
              paint(app);
            },
          }),
          ui.btn("清除", {
            size: "sm",
            danger: true,
            onClick: function () {
              cache.cleared[mode] = true;
              cache.editing[mode] = false;
              draft.secret = "";
              paint(app);
            },
          })
        ),
        { hint: hint }
      );
    }
    var control = textInput(draft.secret, function (value) {
      draft.secret = value;
      if (value) cache.cleared[mode] = false;
      refreshFoot(app);
    }, { type: "password", placeholder: "粘贴 API Key" });
    var children = [control];
    if (cache.cleared[mode]) {
      children.push(
        h("p.field__hint.field__hint--danger", {
          text: "保存后将清除已保存的密钥，该方式会变成未配置。",
        })
      );
    }
    if (cache.editing[mode] && state.configured && !cache.cleared[mode]) {
      children.push(
        ui.btn("取消替换", {
          size: "sm",
          onClick: function () {
            cache.editing[mode] = false;
            draft.secret = "";
            paint(app);
          },
        })
      );
    }
    return field(label, h("div.setting-key.is-editing", null, children), { hint: hint });
  }

  /**
   * 输入过程中只重建底部操作区，不重建整张表单：
   * 整表重绘会让正在输入的输入框失焦，用户每敲一个字符都要从头点回去。
   */
  function refreshFoot(app) {
    var previous = footEl;
    if (!previous || !previous.parentNode) {
      paint(app);
      return;
    }
    var next = buildFoot(app);
    previous.parentNode.replaceChild(next, previous);
  }

  /**
   * 定点清除某个字段的错误：不重绘，错误消失的同时输入焦点留在原处。
   * 只管清错，不顺手刷新底部——是否要刷新由调用方按「草稿是否真的变了」决定。
   */
  function clearFieldError(key) {
    if (!cache.errors[key]) return;
    delete cache.errors[key];
    var node = document.querySelector('[data-error-key="' + key + '"]');
    if (!node) return;
    var wrap = node.closest(".field");
    if (wrap) wrap.classList.remove("field--invalid");
    if (node.parentNode) node.parentNode.removeChild(node);
  }

  function buildTagging(app) {
    var t = cache.draft.tagging;
    var savedTagging = cache.saved.tagging;
    var boundary = t.enabled && savedTagging.enabledSince
      ? "生效边界：只覆盖 " + fmt.absolute(savedTagging.enabledSince) + " 之后首次收录的内容；关闭期间收录的内容需要在「标签 → AI 自动识别」里补打。"
      : "开启后只覆盖此后首次收录的内容，之前的内容不会被自动打标。";
    return [
      h(
        "section.setting-block",
        null,
        switchRow(
          "启用自动打标",
          "接在信息采集之后执行。" + boundary,
          t.enabled,
          function (next) {
            t.enabled = next;
            clearFieldError("enabled");
            paint(app);
          }
        ),
        cache.errors.enabled
          ? h(
              "p.field__error",
              { role: "alert", "data-error-key": "enabled" },
              icon("alert", 13),
              h("span", { text: cache.errors.enabled })
            )
          : null
      ),
      h(
        "section.setting-block",
        null,
        h(
          "div.setting-block__head",
          null,
          h(
            "div",
            null,
            h("h3.setting-block__title", { text: "识别方式" }),
            h("p.setting-block__desc", { text: "两种方式互斥选择，各自的配置分别保存，切换后仍保留另一种。" })
          )
        ),
        h(
          "div.mode-picker",
          null,
          MODES.map(function (mode) {
            var picked = t.mode === mode;
            return h(
              "button.mode-card" + (picked ? ".is-active" : ""),
              {
                type: "button",
                role: "radio",
                "aria-checked": picked ? "true" : "false",
                onclick: function () {
                  t.mode = mode;
                  clearFieldError("mode");
                  paint(app);
                },
              },
              h("span.mode-card__mark", { "aria-hidden": "true" }, picked ? icon("check", 13) : null),
              h(
                "span.mode-card__text",
                null,
                h("span.mode-card__title", { text: MODE_META[mode].label }),
                h("span.mode-card__desc", { text: MODE_META[mode].desc })
              )
            );
          })
        ),
        cache.errors.mode
          ? h(
              "p.field__error",
              { role: "alert", "data-error-key": "mode" },
              icon("alert", 13),
              h("span", { text: cache.errors.mode })
            )
          : null
      ),
      // 两种方式并排：切换后另一种仍保留，摆在同一屏才看得出这一点。
      h("div.setting-grid", null, buildProvider(app, "jev"), buildProvider(app, "llm")),
      buildTestBlock(),
    ];
  }

  /**
   * 连接测试属于 M16 的真实模型调用。M15 没有可调用的 Provider，
   * 这里如实标为不可用，而不是给一个点了会「成功」的假按钮。
   */
  function buildTestBlock() {
    return h(
      "section.setting-block.setting-block--muted",
      null,
      h(
        "div.setting-block__head",
        null,
        h(
          "div",
          null,
          h("h3.setting-block__title", { text: "连接测试" }),
          h("p.setting-block__desc", {
            text: "用固定的测试文本验证认证、模型调用和输出结构。真实识别调用在自动打标接入后开放。",
          })
        ),
        badge("本期不可用", "neutral")
      ),
      h(
        "div.setting-block__foot",
        null,
        ui.btn("测试连接", { disabled: true, title: "自动打标尚未接入模型，本期不提供连接测试" }),
        h("span.field__hint", { text: "现在点下去不会有任何真实调用，也不会返回模拟结果。" })
      )
    );
  }

  /* ---------------- 提醒设置 ---------------- */

  function buildReminder(app) {
    var r = cache.draft.reminder;
    var saved = cache.saved.reminder;
    var notice = cache.notification;
    var children = [
      h(
        "section.setting-block",
        null,
        switchRow(
          "启用定时提醒",
          "按下面设置的时间间隔提醒未处理数量。",
          r.enabled,
          function (next) {
            r.enabled = next;
            paint(app);
          }
        ),
        h(
          "div.setting-inline",
          null,
          h("label.setting-inline__label", { text: "提醒间隔" }),
          ui.select(INTERVAL_PRESETS, r.preset, function (value) {
            r.preset = value;
            if (value !== "custom") r.interval = Number(value);
            clearFieldError("intervalMinutes");
            paint(app);
          }, { ariaLabel: "提醒间隔" }),
          r.preset === "custom"
            ? h(
                "span.setting-inline__custom",
                null,
                textInput(r.interval, function (value) {
                  r.interval = value === "" ? "" : Number(value);
                  clearFieldError("intervalMinutes");
                  refreshFoot(app);
                }, { type: "number", placeholder: String(saved.intervalMinutes) }),
                h("span.setting-inline__unit", { text: "分钟" })
              )
            : null,
          cache.errors.intervalMinutes
            ? h(
                "p.field__error",
                { role: "alert", "data-error-key": "intervalMinutes" },
                icon("alert", 13),
                h("span", { text: cache.errors.intervalMinutes })
              )
            : h("p.field__hint", { text: "可选 15 / 30 / 60 / 120 分钟，自定义范围 " + INTERVAL_MIN + "–" + INTERVAL_MAX + " 分钟。" })
        )
      ),
      h(
        "section.setting-block",
        null,
        h(
          "div.setting-block__head",
          null,
          h(
            "div",
            null,
            h("h3.setting-block__title", { text: "统计口径" }),
            h("p.setting-block__desc", { text: "提醒里的两个数字固定按下面的口径统计，不会随界面筛选变化。" })
          )
        ),
        h(
          "ul.settings-list",
          null,
          h("li.settings-list__item", null,
            h("span.settings-list__name", { text: "未处理" }),
            h("span.settings-list__desc", { text: "收件箱与稍后处理的并集，排除已读和已归档。" })),
          h("li.settings-list__item", null,
            h("span.settings-list__name", { text: "高优先级未归档" }),
            h("span.settings-list__desc", { text: "最终优先级为高且尚未归档的内容，包含已读内容。" })),
          h("li.settings-list__item", null,
            h("span.settings-list__name", { text: "提醒措辞" }),
            h("span.settings-list__desc", { text: "「你有 23 条内容未处理；5 条高优先级内容尚未归档。」两个数字不会相加。" }))
        )
      ),
      buildNotificationBlock(app, notice),
      h(
        "section.setting-block.setting-block--muted",
        null,
        h(
          "div.setting-block__head",
          null,
          h(
            "div",
            null,
            h("h3.setting-block__title", { text: "后台运行" }),
            h("p.setting-block__desc", { text: "关闭主窗口目前会退出应用，提醒随之停止。关闭窗口后在托盘常驻属于后续版本的能力，本期不自动开机启动。" })
          )
        )
      ),
    ];
    return children;
  }

  function buildNotificationBlock(app, notice) {
    var status = notice;
    var children = [
      h(
        "div.setting-block__head",
        null,
        h(
          "div",
          null,
          h("h3.setting-block__title", { text: "系统通知" }),
          h("p.setting-block__desc", { text: "提醒通过系统桌面通知发送。是否真的弹出取决于系统授权与专注模式。" })
        ),
        !status ? badge("读取中", "neutral") : status.supported ? badge("系统支持", "success") : badge("系统不支持", "danger")
      ),
    ];
    if (status) {
      children.push(h("p.field__hint", { text: status.detail }));
      if (status.permission === "unknown") {
        children.push(
          h("p.field__hint", { text: "无法读取系统的授权状态，显示为未知。发送一条测试通知是唯一可靠的确认方式。" })
        );
      }
    }
    children.push(
      h(
        "div.setting-block__foot",
        null,
        ui.btn("发送测试通知", {
          disabled: !status || !status.supported,
          onClick: function () {
            SF.app.act("notification:test", async function () {
              cache.notification = await app.client.sendTestNotification();
              ui.toast(cache.notification.message);
              paint(app);
            });
          },
        }),
        status && status.sent
          ? h("span.field__hint", { text: status.message })
          : null
      )
    );
    return h("section.setting-block", null, children);
  }

  function loadNotificationStatus(app) {
    if (cache.notification) return;
    app.client
      .getNotificationStatus()
      .then(function (status) {
        cache.notification = status;
        paint(app);
      })
      .catch(function (err) {
        cache.notification = { supported: false, permission: "unknown", detail: "读取通知支持情况失败：" + err.message };
        paint(app);
      });
  }

  /* ---------------- 面板 ---------------- */

  function buildNav(app) {
    return h(
      "aside.settings__nav",
      null,
      h(
        "div.settings__nav-top",
        null,
        ui.iconBtn("close", "关闭设置", function () {
          SF.app.navigate(app.settingsReturn || "inbox");
        }, { ariaLabel: "关闭设置" })
      ),
      h(
        "nav.settings__nav-list",
        { "aria-label": "设置导航" },
        SECTIONS.map(function (section) {
          var active = cache.section === section.id;
          return h(
            "button.settings-nav__item" + (active ? ".is-active" : ""),
            {
              type: "button",
              "aria-current": active ? "page" : null,
              onclick: function () {
                cache.section = section.id;
                cache.notice = null;
                paint(app);
              },
            },
            icon(section.icon, 18),
            h("span.settings-nav__label", { text: section.label }),
            isDirty(section.id) ? h("span.settings-nav__dot", { "aria-label": "有未保存的修改" }) : null
          );
        })
      )
    );
  }

  var footEl = null;

  function buildFoot(app) {
    var section = currentSection();
    var dirty = isDirty(section);
    var saving = cache.saving === section;
    footEl = h(
      "footer.settings__foot",
      null,
      h(
        "div.settings__foot-state",
        null,
        saving
          ? h("span.settings__foot-hint", { text: "正在保存…" })
          : dirty
          ? h("span.settings__foot-hint.is-dirty", { text: "有未保存的修改" })
          : h("span.settings__foot-hint", { text: "已保存的设置在下次启动后仍然生效" })
      ),
      h("div.spacer"),
      ui.btn("取消", {
        disabled: saving || !dirty,
        onClick: function () {
          cancelSection(app, section);
        },
      }),
      ui.btn("保存设置", {
        variant: "primary",
        disabled: saving || !dirty,
        onClick: function () {
          saveSection(app, section);
        },
      })
    );
    return footEl;
  }

  function buildHead() {
    var section = SECTIONS.filter(function (s) { return s.id === currentSection(); })[0];
    return h(
      "header.settings__head",
      null,
      h("h1.settings__title", { text: section.title }),
      h("p.settings__desc", { text: section.desc })
    );
  }

  function buildNotice() {
    if (!cache.notice) return null;
    return ui.notice({
      tone: cache.notice.tone === "success" ? "success" : "danger",
      title: cache.notice.tone === "success" ? "已保存" : "没有保存",
      text: cache.notice.tone === "success" ? "设置已经生效。" : cache.notice.text,
    });
  }

  function buildBody(app) {
    if (!cache.draft) {
      if (cache.error) {
        return ui.state({
          icon: "alert",
          tone: "danger",
          title: "无法读取设置",
          desc: cache.error,
          actions: [
            {
              label: "重新读取",
              onClick: function () {
                load(app, { force: true });
              },
            },
            {
              label: "返回",
              onClick: function () {
                SF.app.navigate(app.settingsReturn || "inbox");
              },
            },
          ],
        });
      }
      return ui.state({
        icon: "server",
        title: "正在读取设置",
        desc: "正在从本地核心服务读取当前设置。",
      });
    }
    var content = currentSection() === "reminder" ? buildReminder(app) : buildTagging(app);
    return [buildNotice(), content];
  }

  function render(app) {
    load(app);
    if (currentSection() === "reminder") loadNotificationStatus(app);
    return h(
      "div.settings",
      null,
      buildNav(app),
      h(
        "section.settings__main",
        null,
        buildHead(),
        h("div.settings__body.scroll-y", null, buildBody(app)),
        buildFoot(app)
      )
    );
  }

  /** 路由带 ?section= 时同步左栏选中项：直接改哈希进来也要落到对应分区。 */
  function setSection(section) {
    cache.section = section === "reminder" ? "reminder" : "tagging";
  }

  SF.views = SF.views || {};
  SF.views.settings = {
    render: render,
    reset: reset,
    setSection: setSection,
    isDirty: isDirty,
    dirtySections: dirtySections,
    currentSection: currentSection,
    confirmLeave: confirmLeave,
    SECTIONS: SECTIONS,
  };
})(window);
