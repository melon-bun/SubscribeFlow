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
      id: "ai",
      label: "AI API 配置",
      icon: "zap",
      title: "AI API 配置",
      desc: "配置两类 AI 接口的连接参数。这里只管「怎么连」；是否启用、用哪种识别方式在「标签 → AI 自动识别」里决定。",
    },
    {
      id: "reminder",
      label: "提醒设置",
      icon: "clock",
      title: "提醒设置",
      desc: "按固定间隔提醒还有多少内容未处理。",
    },
    {
      id: "priority",
      label: "优先级名称",
      icon: "priority-set",
      title: "优先级名称",
      desc: "为固定的三个优先级分别起名。等级与顺序不变，只改显示名称。",
    },
  ];

  /* M20：三个等级固定，只有显示名可改。顺序与 Core 一致，不可增删调换。 */
  var PRIORITY_LEVELS = ["high", "medium", "low"];
  var PRIORITY_LABELS = { high: "高优先级", medium: "中优先级", low: "低优先级" };
  var PRIORITY_NONE_NAME = SF.catalog.PRIORITY_NONE_NAME;
  var PRIORITY_NAME_MAX = SF.catalog.PRIORITY_NAME_MAX;

  var MODE_META = {
    jev: {
      label: "Jev 已有标签分类",
      desc: "从你已经创建并启用的标签里挑选合适的，不新建标签。",
      apiLabel: "Jev",
      apiDesc: "Jev 已有标签分类服务的接口：接口地址、模型标识与 API Key。",
      defaults: { endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest" },
    },
    llm: {
      label: "LLM 自由生成标签",
      desc: "由模型判断该用哪些标签，必要时可以新建标签并挂载。",
      apiLabel: "LLM",
      apiDesc: "自由生成标签所用的模型接口：接口地址、模型标识与 API Key。",
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
    section: "ai",
    editing: { jev: false, llm: false }, // 是否正在替换密钥
    cleared: { jev: false, llm: false }, // 是否已勾选清除
    notification: null,
    testingApi: {}, // 正在测试连接的方式
    testResultApi: {}, // 各方式最近一次连接测试的真实结果（只有成败与模型标识，没有密钥）
    notificationLoading: false,
  };
  var generation = 0;
  var savePromise = null;

  function emptyDraft() {
    return {
      // M21：设置页只管连接参数。识别策略在标签管理页，不在这里。
      ai: {
        providers: {
          jev: { endpoint: "", model: "", secret: "" },
          llm: { endpoint: "", model: "", secret: "" },
        },
      },
      reminder: { enabled: false, preset: "60", interval: 60 },
      priority: { names: { high: "", medium: "", low: "" } },
    };
  }

  /** 草稿必须与保存基线一致；官方默认值由 Core 的初始设置提供。 */
  function draftFrom(settings) {
    var draft = emptyDraft();
    var providers = (settings.ai && settings.ai.providers) || {};
    MODES.forEach(function (mode) {
      var saved = providers[mode] || {};
      draft.ai.providers[mode].endpoint = saved.endpoint || "";
      draft.ai.providers[mode].model = saved.model || "";
    });
    var interval = settings.reminder.intervalMinutes;
    draft.reminder.enabled = !!settings.reminder.enabled;
    draft.reminder.interval = interval;
    draft.reminder.preset = INTERVAL_PRESETS.some(function (p) { return p.value === String(interval); })
      ? String(interval)
      : "custom";
    // 旧配置没有这一项时用默认名补齐：等级固定，只是名称回到出厂值。
    var names = (settings.priority && settings.priority.names) || {};
    PRIORITY_LEVELS.forEach(function (level) {
      var value = typeof names[level] === "string" ? names[level] : "";
      draft.priority.names[level] = value || SF.catalog.PRIORITY_DEFAULT_NAMES[level];
    });
    return draft;
  }

  function reset() {
    generation++;
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
    cache.notification = null;
    cache.notificationLoading = false;
    savePromise = null;
  }

  function load(app, opts) {
    opts = opts || {};
    if (cache.loading) return Promise.resolve();
    if ((cache.loaded || cache.error) && !opts.force) return Promise.resolve();
    var epoch = generation;
    cache.loading = true;
    cache.error = null;
    paint(app);
    return app.client
      .getSettings()
      .then(function (settings) {
        if (epoch !== generation) return;
        cache.saved = settings;
        cache.loaded = true;
        // 只有在没有草稿时才重新铺：加载失败后重试不能吃掉用户正在输入的内容。
        if (!cache.draft) cache.draft = draftFrom(settings);
        if (settings.warnings && settings.warnings.length) cache.notice = { tone: "warn", text: settings.warnings.join(" ") };
      })
      .catch(function (err) {
        if (epoch !== generation) return;
        cache.error = err.message;
      })
      .then(function () {
        if (epoch !== generation) return;
        cache.loading = false;
        paint(app);
      });
  }

  function paint(app) {
    if (app.route.name === "settings") SF.app.renderContent();
  }

  /* ---------------- 草稿与脏检查 ---------------- */

  function currentSection() {
    if (cache.section === "reminder") return "reminder";
    if (cache.section === "priority") return "priority";
    return "ai";
  }

  function sectionDraft(section) {
    return cache.draft ? cache.draft[section] : null;
  }

  /** 只比较当前分区：别的页有草稿不该让本页的保存按钮亮起来。 */
  function isDirty(section) {
    var target = section || currentSection();
    if (!cache.saved || !cache.draft) return false;
    if (target === "priority") {
      var names = cache.draft.priority.names;
      var savedNames = (cache.saved.priority && cache.saved.priority.names) || {};
      return PRIORITY_LEVELS.some(function (level) {
        var saved = typeof savedNames[level] === "string" ? savedNames[level] : SF.catalog.PRIORITY_DEFAULT_NAMES[level];
        return (names[level] || "").trim() !== saved.trim();
      });
    }
    if (target === "reminder") {
      var r = cache.draft.reminder;
      var saved = cache.saved.reminder;
      return r.enabled !== !!saved.enabled || Number(r.interval) !== Number(saved.intervalMinutes);
    }
    // M21：只比较连接参数。两类 API 各自独立，保存一类不牵动另一类。
    var a = cache.draft.ai;
    var savedProviders = (cache.saved.ai && cache.saved.ai.providers) || {};
    return MODES.some(function (mode) {
      var savedProvider = savedProviders[mode] || {};
      return (
        a.providers[mode].endpoint !== (savedProvider.endpoint || "") ||
        a.providers[mode].model !== (savedProvider.model || "") ||
        !!a.providers[mode].secret ||
        cache.cleared[mode]
      );
    });
  }

  /** 哪些 API 改动了：只把这些提交，其它类的配置不参与这次保存。 */
  function dirtyApiModes() {
    var a = cache.draft.ai;
    var savedProviders = (cache.saved.ai && cache.saved.ai.providers) || {};
    return MODES.filter(function (mode) {
      var savedProvider = savedProviders[mode] || {};
      return (
        a.providers[mode].endpoint !== (savedProvider.endpoint || "") ||
        a.providers[mode].model !== (savedProvider.model || "") ||
        !!a.providers[mode].secret ||
        cache.cleared[mode]
      );
    });
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
    if (section === "priority") {
      var names = {};
      PRIORITY_LEVELS.forEach(function (level) { names[level] = cache.draft.priority.names[level]; });
      return { section: "priority", patch: { names: names } };
    }
    // M21：只提交改动过的那类 API 的连接参数，不携带任何识别策略字段。
    var a = cache.draft.ai;
    var modes = dirtyApiModes();
    var providers = {};
    var credentials = {};
    modes.forEach(function (mode) {
      providers[mode] = { endpoint: a.providers[mode].endpoint, model: a.providers[mode].model };
      if (cache.cleared[mode]) credentials[mode] = null;
      else if (a.providers[mode].secret) credentials[mode] = a.providers[mode].secret;
    });
    return { section: "ai", patch: { providers: providers }, credentials: credentials };
  }

  /* M20 名称规则，与 Core 的校验一致：去首尾空格后 1–12 字符、三级不重名、
     不占用「未设置」。前端先校一次给出即时反馈，Core 仍会再校一遍。 */
  function priorityNameError(value) {
    var name = (value || "").trim();
    if (!name) return "优先级名称不能为空";
    if (name.length > PRIORITY_NAME_MAX) return "优先级名称不能超过 " + PRIORITY_NAME_MAX + " 个字符";
    if (name === PRIORITY_NONE_NAME) return "「" + PRIORITY_NONE_NAME + "」表示无优先级，不能用作优先级名称";
    return null;
  }

  function validatePriorityNames(names) {
    var errors = {};
    var seen = {};
    PRIORITY_LEVELS.forEach(function (level) {
      var name = (names[level] || "").trim();
      var message = priorityNameError(name);
      if (!message && seen[name]) message = "三个优先级名称不能相同";
      if (message) errors["names." + level] = message;
      else seen[name] = level;
    });
    return errors;
  }

  function saveSection(app, section) {
    if (savePromise) return savePromise;
    var epoch = generation;
    if (section === "priority") {
      var errors = validatePriorityNames(cache.draft.priority.names);
      if (Object.keys(errors).length) {
        // 不合法的名称不提交：输入原样保留，原因落到对应输入框下面。
        cache.errors = errors;
        cache.notice = { tone: "danger", text: "优先级名称不合法，请按提示修改后再保存。" };
        paint(app);
        return Promise.resolve(false);
      }
    }
    var params = buildSaveParams(section);
    cache.saving = section;
    cache.notice = null;
    cache.errors = {};
    paint(app);
    savePromise = app.client
      .saveSettings(params)
      .then(function (settings) {
        if (epoch !== generation) return false;
        cache.saved = settings;
        cache.loaded = true;
        // 只重建刚提交的分区，清除其中的密钥明文，并使用服务端规范化后的值。
        discardSection(section);
        if (section === "priority") {
          // 立即生效：公共目录换名后，看板／卡片／筛选／提醒文案一起变。
          SF.app.applyPriorityNames(settings.priority && settings.priority.names);
        }
        cache.notice = settings.warnings && settings.warnings.length
          ? { tone: "warn", text: settings.warnings.join(" ") }
          : { tone: "success", text: "设置已保存。" };
        return true;
      })
      .catch(function (err) {
        if (epoch !== generation) return false;
        // 保存失败保留全部输入，原因落到对应输入框下方，顶栏再给一条整体说明。
        cache.notice = { tone: "danger", text: err.message };
        // Core 用 scope_key 报错，跨桥后原样带过来；两种写法都认，避免只在横幅里报。
        var key = err.scopeKey || err.scope_key;
        if (err.scope === "field" && key) cache.errors[key] = err.message;
        return false;
      })
      .then(function (ok) {
        if (epoch !== generation) return false;
        cache.saving = null;
        savePromise = null;
        paint(app);
        return ok;
      });
    return savePromise;
  }

  function discardSection(section) {
    cache.draft[section] = draftFrom(cache.saved)[section];
    if (section === "ai") {
      MODES.forEach(function (mode) {
        cache.editing[mode] = false;
        cache.cleared[mode] = false;
      });
    }
  }

  function discardAll() {
    SECTIONS.forEach(function (section) { discardSection(section.id); });
    cache.errors = {};
    cache.notice = null;
  }

  function cancelSection(app, section) {
    if (cache.saving) return;
    discardSection(section);
    cache.errors = {};
    cache.notice = null;
    paint(app);
  }

  /* ---------------- 离开确认 ---------------- */

  function sectionLabel(id) {
    return SECTIONS.filter(function (s) { return s.id === id; })[0].label;
  }

  function confirmLeave(app) {
    if (savePromise) return savePromise.then(function (ok) { return ok ? confirmLeave(app) : false; });
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
        beforeClose: function () { return !cache.saving; },
        body: body,
        footer: [
          h("div.spacer"),
          ui.btn("继续编辑", { onClick: function () { if (cache.saving) return; done(false); layer.close(); } }),
          ui.btn("放弃修改", {
            variant: "danger",
            onClick: function () {
              if (cache.saving) return;
              discardAll();
              done(true);
              layer.close();
            },
          }),
          ui.btn("保存并离开", {
            variant: "primary",
            // 当前页没有草稿时不给可点的保存：按页保存，点了也写不进任何东西。
            disabled: !currentDirty || cache.saving === current,
            onClick: function () {
              if (cache.saving) return;
              layer.el.querySelectorAll("button").forEach(function (button) { button.disabled = true; });
              saveSection(app, current).then(function (ok) {
                if (ok) discardAll();
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

  /* ---------------- AI API 配置 ---------------- */

  function buildProvider(app, mode) {
    var meta = MODE_META[mode];
    var draft = cache.draft.ai.providers[mode];
    var state = (cache.saved && cache.saved.credentials.providers[mode]) || { configured: false, usable: false, unresolved: false };
    var protection = (cache.saved && cache.saved.credentials.protection) || { available: false, reason: "正在读取保护能力" };
    var savedProvider = (cache.saved && cache.saved.ai && cache.saved.ai.providers[mode]) || {};
    var status = providerStatus(state, protection, savedProvider);

    var keyRow = buildKeyField(app, mode, state, protection, draft);
    var children = [
      h(
        "div.setting-block__head",
        null,
        h(
          "div",
          null,
          h("h3.setting-block__title", { text: meta.apiLabel }),
          h("p.setting-block__desc", { text: meta.apiDesc })
        ),
        badge(state.configured ? "已配置" : "未配置完整", state.configured ? "success" : "neutral")
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
            ? "可以使用官方默认值，也可以改成你自己的地址。"
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
      buildProviderTest(app, mode),
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
    return h("section.setting-block", null, children);
  }

  /**
   * 连接测试只测这一类 API：不改当前打标方式、不启停自动打标，也不产生任何标签。
   * 走的是与后台打标完全相同的组装路径，因此这里通过不等于后台也能用，
   * 反之亦然——不存在只给界面演示的假通路。
   */
  function buildProviderTest(app, mode) {
    var running = !!cache.testingApi[mode];
    var result = cache.testResultApi[mode];
    return h(
      "div.setting-block__foot",
      null,
      ui.btn(running ? "正在测试…" : "测试连接", {
        disabled: running,
        icon: "refresh",
        onClick: function () {
          cache.testingApi[mode] = true;
          cache.testResultApi[mode] = null;
          SF.app.renderContent();
          app.client.testTaggingConnection(mode).then(
            function (value) {
              cache.testingApi[mode] = false;
              cache.testResultApi[mode] = value;
              SF.app.renderContent();
            },
            function (err) {
              cache.testingApi[mode] = false;
              cache.testResultApi[mode] = {
                ok: false,
                message: (err && err.message) || "连接测试失败，请检查接口地址、模型标识与 API Key。",
              };
              SF.app.renderContent();
            }
          );
        },
      }),
      result
        ? h("span.field__hint", {
            text: result.ok
              ? "连接正常：" + (result.provider || "") + " " +
                (result.model || result.requestedModel || "") +
                "，返回 " + result.candidates + " 个候选标签"
              : "测试失败：" + result.message,
          })
        : h("span.field__hint", { text: "测试会发出一次真实的模型请求，但不会保存任何标签。" })
    );
  }

  function providerStatus(state, protection, provider) {
    if (state.unresolved) {
      return { tone: "danger", text: "密钥缺失", note: "设置指向的密钥在凭据文件里找不到，请重新输入并保存。" };
    }
    if (state.configured && !state.usable) {
      return { tone: "danger", text: "密钥不可用", note: "已保存的密钥无法解密（系统密钥环可能已更换账户），请重新输入并保存。" };
    }
    if (state.configured && provider.configured) {
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
    if ((state.unresolved || (state.configured && !state.usable)) && !cache.editing[mode]) {
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
    document.querySelectorAll(".settings-nav__item").forEach(function (item, index) {
      var dot = item.querySelector(".settings-nav__dot");
      if (isDirty(SECTIONS[index].id) && !dot) item.appendChild(h("span.settings-nav__dot", { "aria-label": "有未保存的修改" }));
      else if (!isDirty(SECTIONS[index].id) && dot) dot.remove();
    });
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

  function buildAi(app) {
    // M21：这一页只管连接参数。开关与识别方式在标签管理页，两边互不覆盖。
    return [
      h(
        "section.setting-block",
        null,
        h(
          "div.setting-block__head",
          null,
          h(
            "div",
            null,
            h("h3.setting-block__title", { text: "两类接口各自独立" }),
            h("p.setting-block__desc", {
              text: "分别填写、分别保存，允许先保存没填齐的参数，缺项会在状态里如实标出。是否启用自动打标、使用哪一种识别方式，在「标签 → AI 自动识别」里设置。",
            })
          )
        )
      ),
      // 两种接口并排：各自独立，填好一类就能先存一类。
      h("div.setting-grid", null, buildProvider(app, "jev"), buildProvider(app, "llm")),
    ];
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
          "当前仅保存偏好；定时提醒接入后，按下面设置的间隔提醒未处理数量。",
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
            h("span.settings-list__name", { text: SF.catalog.priority("high").name + "未归档" }),
            h("span.settings-list__desc", { text: "最终优先级为「" + SF.catalog.priority("high").name + "」且尚未归档的内容，包含已读内容。" })),
          h("li.settings-list__item", null,
            h("span.settings-list__name", { text: "提醒措辞" }),
            h("span.settings-list__desc", { text: "「你有 23 条内容未处理；5 条" + SF.catalog.priority("high").name + "内容尚未归档。」两个数字不会相加。" }))
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
            h("p.setting-block__desc", { text: "定时提醒与托盘常驻已可用：关闭主窗口后应用继续在托盘运行，采集与提醒不中断；需要完全退出时，从托盘菜单或应用菜单选择「退出应用」。备份请在退出之后复制应用数据目录。" })
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
          disabled: cache.testing || !status || !status.supported,
          onClick: function () {
            if (cache.testing) return;
            var epoch = generation;
            cache.testing = true;
            paint(app);
            SF.app.act("notification:test", async function () {
              try {
                var result = await app.client.sendTestNotification();
                if (epoch !== generation) return;
                cache.notification = result;
                ui.toast(result.message);
              } finally {
                if (epoch === generation) { cache.testing = false; paint(app); }
              }
            });
          },
        }),
        status && status.message
          ? h("span.field__hint", { text: status.message })
          : null
      )
    );
    return h("section.setting-block", null, children);
  }

  function loadNotificationStatus(app) {
    if (cache.notification || cache.notificationLoading) return;
    cache.notificationLoading = true;
    var epoch = generation;
    app.client
      .getNotificationStatus()
      .then(function (status) {
        if (epoch !== generation) return;
        cache.notificationLoading = false;
        cache.notification = status;
        paint(app);
      })
      .catch(function (err) {
        if (epoch !== generation) return;
        cache.notificationLoading = false;
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
        }, { ariaLabel: "关闭设置", disabled: !!cache.saving })
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
              disabled: !!cache.saving,
              "aria-current": active ? "page" : null,
              onclick: function () {
                cache.section = section.id;
                app.route.params.section = section.id;
                history.replaceState(null, "", "#/settings?section=" + section.id);
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
    var saving = !!cache.saving;
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
      tone: cache.notice.tone,
      title: cache.notice.tone === "danger" ? "没有保存" : cache.notice.tone === "warn" ? "已保存，仍需处理" : "已保存",
      text: cache.notice.text,
    });
  }

  /* ---------------- 优先级名称 ---------------- */

  /**
   * 恢复默认只改草稿，不直接落库：用户仍要点保存才会生效，
   * 与本页其它分区的「先改草稿再保存」保持一致。
   */
  function restoreDefaultPriorityNames(app) {
    PRIORITY_LEVELS.forEach(function (level) {
      cache.draft.priority.names[level] = SF.catalog.PRIORITY_DEFAULT_NAMES[level];
      clearFieldError("names." + level);
    });
    paint(app);
  }

  function buildPriority(app) {
    var draft = cache.draft.priority.names;
    var rows = PRIORITY_LEVELS.map(function (level, index) {
      var key = "names." + level;
      return field(
        PRIORITY_LABELS[level],
        textInput(draft[level], function (value) {
          draft[level] = value;
          // 输入过程中只清错并刷新底部，不重建表单，焦点留在输入框。
          PRIORITY_LEVELS.forEach(function (other) { clearFieldError("names." + other); });
          refreshFoot(app);
        }, { placeholder: SF.catalog.PRIORITY_DEFAULT_NAMES[level] }),
        {
          hint: "固定第 " + (index + 1) + " 档，等级与顺序不变，只改显示名称。",
          error: cache.errors[key],
          errorKey: key,
        }
      );
    });
    return h(
      "section.setting-block",
      null,
      h(
        "div.setting-block__head",
        null,
        h(
          "div",
          null,
          h("h3.setting-block__title", { text: "三个优先级的名称" }),
          h("p.setting-block__desc", { text: "名称只影响显示：统计、筛选与提醒仍按固定等级计算，不会改动任何内容的优先级。" })
        )
      ),
      h("div.setting-fields", null, rows),
      h(
        "div.setting-block__foot",
        null,
        ui.btn("恢复默认名称", {
          size: "sm",
          onClick: function () { restoreDefaultPriorityNames(app); },
        })
      )
    );
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
    var content = currentSection() === "reminder"
      ? buildReminder(app)
      : currentSection() === "priority"
      ? buildPriority(app)
      : buildAi(app);
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
        h("fieldset.settings__body.scroll-y", { disabled: !!cache.saving }, buildBody(app)),
        buildFoot(app)
      )
    );
  }

  /** 路由带 ?section= 时同步左栏选中项：直接改哈希进来也要落到对应分区。 */
  function setSection(section) {
    cache.section = section === "reminder" ? "reminder" : section === "priority" ? "priority" : "ai";
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
