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
      desc: "配置 AI 接口的地址、模型与访问密钥。自动打标方式在「标签 → AI 自动识别」中设置。",
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
    {
      id: "summarization",
      label: "AI 总结",
      icon: "zap",
      title: "AI 总结",
      desc: "为「留下点什么」准备一段总结草稿。总结由你决定要不要用，与自动打标互不影响。",
    },
    {
      // M32：轻科幻层开关。只切界面效果，不影响任何业务行为。
      id: "appearance",
      label: "外观",
      icon: "sunmoon",
      title: "外观",
      desc: "选择界面的视觉风格。两种风格共用同一套配色与排版规则。",
    },
  ];

  // M29：总结的详细程度与语言。长度是「简略 · 一句话」与「复杂 · 300 字」，
  // 不是 token 数；语言是输出语言，与材料语言无关。
  var SUMMARY_LENGTHS = [
    { value: "brief", label: "简略 · 一句话" },
    { value: "detailed", label: "复杂 · 300 字" },
  ];
  var SUMMARY_LANGUAGES = [
    { value: "zh-CN", label: "中文" },
    { value: "original", label: "原文语言" },
  ];

  /* M20：三个等级固定，只有显示名可改。顺序与 Core 一致，不可增删调换。 */
  var PRIORITY_LEVELS = ["high", "medium", "low"];
  var PRIORITY_LABELS = { high: "高优先级", medium: "中优先级", low: "低优先级" };
  var PRIORITY_NONE_NAME = SF.catalog.PRIORITY_NONE_NAME;
  var PRIORITY_NAME_MAX = SF.catalog.PRIORITY_NAME_MAX;

  // M25：协议是连接的属性，能力由协议决定。同一个协议可以配多条连接。
  var PROTOCOLS = [
    { value: "openai_chat", label: "OpenAI 兼容聊天", capabilities: ["文本生成"] },
    { value: "jev_systemone", label: "Jev 候选分类", capabilities: ["候选分类"] },
  ];

  function protocolLabel(protocol) {
    var found = PROTOCOLS.filter(function (p) { return p.value === protocol; })[0];
    return found ? found.label : protocol;
  }

  function protocolCapabilities(protocol) {
    var found = PROTOCOLS.filter(function (p) { return p.value === protocol; })[0];
    return found ? found.capabilities : [];
  }

  function newProviderId() {
    return 'provider-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

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
      // M25：连接按稳定 ID 组织，页面按 ID 遍历。识别策略在标签管理页，不在这里。
      ai: { providers: {}, removed: [] },
      reminder: { enabled: false, preset: "60", interval: 60 },
      priority: { names: { high: "", medium: "", low: "" } },
      // M29：总结策略。默认开着但不选连接——没有连接就只是不生成，不打扰用户。
      summarization: { enabled: true, providerId: null, length: "brief", language: "zh-CN" },
    };
  }

  /** 草稿必须与保存基线一致；官方默认值由 Core 的初始设置提供。 */
  function draftFrom(settings) {
    var draft = emptyDraft();
    var providers = (settings.ai && settings.ai.providers) || {};
    Object.keys(providers).forEach(function (providerId) {
      var saved = providers[providerId] || {};
      draft.ai.providers[providerId] = {
        name: saved.name || "",
        protocol: saved.protocol || "openai_chat",
        endpoint: saved.endpoint || "",
        model: saved.model || "",
        secret: "",
        enabled: saved.enabled !== false,
        isNew: false,
      };
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
    // M29：总结策略。解除引用是明确的 null，不会被默认连接复活。
    var summary = settings.summarization || {};
    draft.summarization.enabled = summary.enabled !== false;
    draft.summarization.providerId = summary.providerId || null;
    draft.summarization.length = summary.length || "brief";
    draft.summarization.language = summary.language || "zh-CN";
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
    // M25：编辑态与清除标记按连接 ID 记，连接有多条时互不干扰。
    cache.editing = {};
    cache.cleared = {};
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
    if (cache.section === "summarization") return "summarization";
    /* M32：外观分区是纯前端设置，不进 Core 的草稿与保存流程。 */
    if (cache.section === "appearance") return "appearance";
    return "ai";
  }

  function sectionDraft(section) {
    return cache.draft ? cache.draft[section] : null;
  }

  /** 只比较当前分区：别的页有草稿不该让本页的保存按钮亮起来。 */
  function isDirty(section) {
    var target = section || currentSection();
    if (!cache.saved || !cache.draft) return false;
    /* M32：外观分区是纯前端设置，没有草稿，永远不是「已修改」。
       不显式排除的话会掉到下面的 AI 分支去比较连接，得出错误的脏标记。 */
    if (target === "appearance") return false;
    if (target === "priority") {
      var names = cache.draft.priority.names;
      var savedNames = (cache.saved.priority && cache.saved.priority.names) || {};
      return PRIORITY_LEVELS.some(function (level) {
        var saved = typeof savedNames[level] === "string" ? savedNames[level] : SF.catalog.PRIORITY_DEFAULT_NAMES[level];
        return (names[level] || "").trim() !== saved.trim();
      });
    }
    if (target === "summarization") {
      var sum = cache.draft.summarization;
      var savedSum = cache.saved.summarization || {};
      return sum.enabled !== (savedSum.enabled !== false) ||
        (sum.providerId || null) !== (savedSum.providerId || null) ||
        sum.length !== (savedSum.length || "brief") ||
        sum.language !== (savedSum.language || "zh-CN");
    }
    if (target === "reminder") {
      var r = cache.draft.reminder;
      var saved = cache.saved.reminder;
      return r.enabled !== !!saved.enabled || Number(r.interval) !== Number(saved.intervalMinutes);
    }
    // M25：按连接 ID 比较。有几条就比几条：新增、改名、停用、删除都算改动。
    return dirtyProviderIds().length > 0 || (cache.draft.ai.removed || []).length > 0;
  }

  /** 哪些连接改动了：只把这些提交，其它连接的配置不参与这次保存。 */
  function dirtyProviderIds() {
    var a = cache.draft.ai;
    var savedProviders = (cache.saved.ai && cache.saved.ai.providers) || {};
    return Object.keys(a.providers).filter(function (providerId) {
      var draft = a.providers[providerId];
      var saved = savedProviders[providerId] || {};
      return (
        draft.name !== (saved.name || "") ||
        draft.protocol !== (saved.protocol || "openai_chat") ||
        draft.endpoint !== (saved.endpoint || "") ||
        draft.model !== (saved.model || "") ||
        draft.enabled !== (saved.enabled !== false) ||
        !!draft.secret ||
        !!cache.cleared[providerId] ||
        !!draft.isNew
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
    if (section === "summarization") {
      var sum = cache.draft.summarization;
      return { section: "summarization", patch: {
        enabled: !!sum.enabled,
        providerId: sum.providerId || null,
        length: sum.length,
        language: sum.language,
      } };
    }
    if (section === "ai") {
      // M25：按连接 ID 提交。只带改动的连接；删除用 null 表示。
      var providers = {};
      var credentials = {};
      dirtyProviderIds().forEach(function (providerId) {
        var draft = cache.draft.ai.providers[providerId];
        var saved = (cache.saved.ai && cache.saved.ai.providers[providerId]) || {};
        var fields = {};
        if (draft.name !== (saved.name || "")) fields.name = draft.name;
        if (draft.protocol !== (saved.protocol || "openai_chat")) fields.protocol = draft.protocol;
        if (draft.endpoint !== (saved.endpoint || "")) fields.endpoint = draft.endpoint;
        if (draft.model !== (saved.model || "")) fields.model = draft.model;
        if (draft.enabled !== (saved.enabled !== false)) fields.enabled = draft.enabled;
        providers[providerId] = fields;
        if (draft.secret) credentials[providerId] = draft.secret;
        else if (cache.cleared[providerId]) credentials[providerId] = null;
      });
      (cache.draft.ai.removed || []).forEach(function (providerId) {
        providers[providerId] = null;
      });
      return { section: "ai", patch: { providers: providers }, credentials: credentials };
    }
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
        if (section === "summarization" && SF.noteUi && SF.noteUi.invalidateConfig) {
          // 总结策略变了：编辑区下次打开时重新读，不再拿旧的判断来决定要不要显示入口。
          SF.noteUi.invalidateConfig();
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
      // 丢弃的是整页草稿：编辑态与清除标记都要复位。
      Object.keys(cache.draft.ai.providers).forEach(function (providerId) {
        cache.editing[providerId] = false;
        cache.cleared[providerId] = false;
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

  /**
   * 一条连接一张卡片，按稳定 ID 遍历。
   *
   * M25：连接不再按「两种固定方式」排布，名称、协议、地址、模型、密钥与
   * 启用状态各自独立；业务功能（打标、总结）各自选择使用哪一条。
   */
  function buildProvider(app, providerId) {
    var draft = cache.draft.ai.providers[providerId];
    if (!draft) return null;
    var saved = (cache.saved && cache.saved.ai && cache.saved.ai.providers[providerId]) || {};
    var state = (cache.saved && cache.saved.credentials.providers[providerId]) ||
      { configured: false, usable: false, unresolved: false };
    var protection = (cache.saved && cache.saved.credentials.protection) ||
      { available: false, reason: "正在读取保护能力" };
    var status = providerStatus(state, protection, saved);
    var removed = (cache.draft.ai.removed || []).indexOf(providerId) >= 0;
    var capabilities = protocolCapabilities(draft.protocol);
    var children = [
      h(
        "div.setting-block__head",
        null,
        h(
          "div",
          null,
          h("h3.setting-block__title", { text: draft.name || providerId }),
          h("p.setting-block__desc", {
            text: protocolLabel(draft.protocol) + " · " +
              (draft.isNew ? "新增连接" : removed ? "标记删除，保存后生效" : "已保存的连接"),
          })
        ),
        h("div.spacer"),
        badge(state.configured ? "已配置" : "未配置完整", state.configured ? "success" : "neutral"),
        h("div.spacer"),
        ui.toggle(draft.enabled, function (on) {
          draft.enabled = on;
          refreshFoot(app);
        }, { label: "启用这条连接" })
      ),
      h(
        "div.setting-block__status",
        null,
        badge(status.text, status.tone),
        h("span.setting-block__status-note", { text: status.note })
      ),
      h(
        "div.setting-grid",
        null,
        field(
          "名称",
          textInput(draft.name, function (value) {
            draft.name = value;
            clearFieldError(providerId + ".name");
            refreshFoot(app);
          }, { placeholder: "给这条连接起个名字" }),
          {
            hint: "只是显示名。改名不影响已经打好的标签，也不会作废在途结果。",
            error: cache.errors[providerId + ".name"],
            errorKey: providerId + ".name",
          }
        ),
        field(
          "协议",
          ui.select(
            PROTOCOLS.map(function (item) { return { value: item.value, label: item.label }; }),
            draft.protocol,
            function (value) {
              draft.protocol = value;
              clearFieldError(providerId + ".protocol");
              refreshFoot(app);
            },
            { ariaLabel: "协议" }
          ),
          {
            hint: "协议决定这条连接能做什么。",
            error: cache.errors[providerId + ".protocol"],
            errorKey: providerId + ".protocol",
          }
        )
      ),
      field(
        "接口地址",
        textInput(draft.endpoint, function (value) {
          draft.endpoint = value;
          clearFieldError(providerId + ".endpoint");
          refreshFoot(app);
        }, { placeholder: "https://api.example.com/v1" }),
        {
          hint: "服务侧的接口地址。",
          error: cache.errors[providerId + ".endpoint"],
          errorKey: providerId + ".endpoint",
        }
      ),
      h(
        "div.setting-grid",
        null,
        field(
          "模型",
          textInput(draft.model, function (value) {
            draft.model = value;
            clearFieldError(providerId + ".model");
            refreshFoot(app);
          }, { placeholder: "模型名称" }),
          { hint: "服务侧的模型标识，不是显示别名。", error: cache.errors[providerId + ".model"], errorKey: providerId + ".model" }
        ),
        buildKeyField(app, providerId, state, protection, draft)
      ),
      buildProviderTest(app, providerId),
      h(
        "div.setting-block__foot",
        null,
        h("span.field__hint", { text: "能力：" + (capabilities.join("、") || "未指定") })
      ),
    ];
    if (!draft.isNew) {
      children.push(
        h(
          "div.setting-block__foot",
          null,
          ui.btn(removed ? "取消删除" : "删除这条连接", {
            size: "sm",
            danger: !removed,
            onClick: function () { toggleProviderRemoval(app, providerId); },
          })
        )
      );
    }
    return h("section.setting-block", { "data-provider-id": providerId }, children);
  }

  function buildAi(app) {
    var providerIds = Object.keys(cache.draft.ai.providers);
    var children = providerIds.map(function (providerId) { return buildProvider(app, providerId); });
    children.push(
      h(
        "div.setting-block__foot",
        null,
        ui.btn("新增连接", {
          icon: "plus",
          onClick: function () { addProvider(app); },
        })
      )
    );
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
            h("h3.setting-block__title", { text: "集中管理连接与模型" }),
            h("p.setting-block__desc", {
              text: "已配置的连接可供打标与其他功能调用。连接独立保存，业务功能各自选择使用哪一条。",
            })
          )
        )
      ),
      h("div.setting-stack", null, children),
    ];
  }

  /** 新增一条连接：先落在草稿里，保存后才真正存在。 */
  function addProvider(app) {
    var providerId = newProviderId();
    cache.draft.ai.providers[providerId] = {
      name: "",
      protocol: PROTOCOLS[0].value,
      endpoint: "",
      model: "",
      secret: "",
      enabled: true,
      isNew: true,
    };
    cache.editing[providerId] = true;
    paint(app);
  }

  /**
   * 删除连接：先标记，保存时才真正删。
   * 被业务引用的连接由 Core 拦下并说明使用方，界面不替它做决定。
   */
  function toggleProviderRemoval(app, providerId) {
    var removed = cache.draft.ai.removed || [];
    var index = removed.indexOf(providerId);
    if (index >= 0) {
      removed.splice(index, 1);
    } else {
      removed.push(providerId);
    }
    paint(app);
  }

  /**
   * 连接测试只验证这条连接能不能通：走公共 AI 层的协议最小探针，
   * 不打标签、不生成笔记，也不建立任何后台任务。
   */
  function buildProviderTest(app, providerId) {
    var running = !!cache.testingApi[providerId];
    var result = cache.testResultApi[providerId];
    return h(
      "div.setting-block__foot",
      null,
      ui.btn(running ? "正在测试…" : "测试连接", {
        disabled: running,
        icon: "refresh",
        onClick: function () {
          cache.testingApi[providerId] = true;
          cache.testResultApi[providerId] = null;
          SF.app.renderContent();
          app.client.testAiProvider(providerId).then(
            function (value) {
              cache.testingApi[providerId] = false;
              cache.testResultApi[providerId] = value;
              SF.app.renderContent();
            },
            function (err) {
              cache.testingApi[providerId] = false;
              cache.testResultApi[providerId] = {
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
              ? "连接正常：" + (result.model || providerId) + "。" + (result.message || "")
              : "测试失败：" + result.message,
          })
        : h("span.field__hint", { text: "测试针对已保存的配置：先保存再测试。只验证协议通不通，不打标签、不建立后台任务。" })
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

  function buildKeyField(app, providerId, state, protection, draft) {
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
    if ((state.unresolved || (state.configured && !state.usable)) && !cache.editing[providerId]) {
      return field(
        label,
        h("div.setting-key", null,
          h("span.setting-key__state.is-danger", { text: state.unresolved ? "已保存的密钥找不到" : "已保存的密钥无法解密" }),
          ui.btn("重新输入", {
            size: "sm",
            variant: "primary",
            onClick: function () {
              cache.editing[providerId] = true;
              paint(app);
            },
          })
        ),
        { hint: hint }
      );
    }
    if (state.configured && !cache.cleared[providerId] && !draft.secret && !cache.editing[providerId]) {
      return field(
        label,
        h("div.setting-key", null,
          h("span.setting-key__state", { text: "已保存（不回显）" }),
          ui.btn("替换", {
            size: "sm",
            onClick: function () {
              cache.editing[providerId] = true;
              paint(app);
            },
          }),
          ui.btn("清除", {
            size: "sm",
            danger: true,
            onClick: function () {
              cache.cleared[providerId] = true;
              cache.editing[providerId] = false;
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
      if (value) cache.cleared[providerId] = false;
      refreshFoot(app);
    }, { type: "password", placeholder: "粘贴 API Key" });
    var children = [control];
    if (cache.cleared[providerId]) {
      children.push(
        h("p.field__hint.field__hint--danger", {
          text: "保存后将清除已保存的密钥，该方式会变成未配置。",
        })
      );
    }
    if (cache.editing[providerId] && state.configured && !cache.cleared[providerId]) {
      children.push(
        ui.btn("取消替换", {
          size: "sm",
          onClick: function () {
            cache.editing[providerId] = false;
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
    /* M32：外观分区是纯前端设置，切换即时生效，没有草稿也没有保存动作。
       不显示保存条——留一个永远点不动的橙色主按钮会误导用户。 */
    if (section === "appearance") return null;
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

  /* ---------------- AI 总结 ---------------- */

  /**
   * 能用来做总结的连接：协议支持文本生成。
   * 已经选中的那条即使停用或没配完也列出来，并写清真实原因——
   * 不偷偷换成别的连接，也不让用户以为换个名字就好了。
   */
  function summaryProviderOptions() {
    var providers = (cache.saved.ai && cache.saved.ai.providers) || {};
    var selected = cache.draft.summarization.providerId;
    var options = [];
    Object.keys(providers).forEach(function (providerId) {
      var provider = providers[providerId] || {};
      var textCapable = (provider.capabilities || []).indexOf("text_generation") >= 0;
      var isSelected = selected === providerId;
      if (!textCapable && !isSelected) return;
      var notes = [];
      if (!textCapable) notes.push("不支持文本生成");
      if (provider.enabled === false) notes.push("已停用");
      if (provider.missing && provider.missing.length) notes.push("未配置完整");
      options.push({
        value: providerId,
        label: (provider.name || providerId) + (notes.length ? "（" + notes.join("、") + "）" : ""),
      });
    });
    return options;
  }

  function buildSummarization(app) {
    var draft = cache.draft.summarization;
    var options = [{ value: "", label: "不选择连接" }].concat(summaryProviderOptions());
    var picked = draft.providerId
      ? (cache.saved.ai && cache.saved.ai.providers || {})[draft.providerId]
      : null;
    var note = null;
    if (draft.providerId && picked) {
      var reasons = [];
      if (picked.enabled === false) reasons.push("这条连接已停用");
      if (picked.missing && picked.missing.length) reasons.push("还缺" + picked.missing.join("、"));
      if ((picked.capabilities || []).indexOf("text_generation") < 0) reasons.push("它不支持文本生成");
      if (reasons.length) note = reasons.join("；") + "。生成时会把原因说清楚，不会换成别的连接。";
    }
    return h(
      "section.setting-block",
      null,
      h(
        "div.setting-block__head",
        null,
        h(
          "div",
          null,
          h("h3.setting-block__title", { text: "总结策略" }),
          h("p.setting-block__desc", { text: "总结只在你点「AI 总结」时生成，生成的是草稿：写不写、怎么改都归你。它与自动打标互不影响。" })
        )
      ),
      h(
        "div.setting-fields",
        null,
        field(
          "启用 AI 总结",
          ui.toggle(draft.enabled, function (on) { draft.enabled = on; paint(app); }),
          { hint: "关掉后界面不再出现生成入口；已经写好的笔记不受影响。" }
        ),
        field(
          "用哪条连接",
          ui.select(options, draft.providerId || "", function (value) {
            draft.providerId = value || null;
            paint(app);
          }, { ariaLabel: "总结使用的连接" }),
          { hint: "只有支持文本生成的连接能用。", error: note }
        ),
        field(
          "详细程度",
          ui.select(SUMMARY_LENGTHS, draft.length, function (value) { draft.length = value; paint(app); },
            { ariaLabel: "总结详细程度" }),
          { hint: "简略是一句话；复杂会展开到 300 字左右。" }
        ),
        field(
          "输出语言",
          ui.select(SUMMARY_LANGUAGES, draft.language, function (value) { draft.language = value; paint(app); },
            { ariaLabel: "总结输出语言" }),
          { hint: "中文固定用中文回答；原文语言保持材料原本的语言。" }
        )
      )
    );
  }

  /* ---------------- 外观（M32） ---------------- */

  /* 轻科幻层是纯前端开关：不进 Core 设置、不走草稿与保存流程，
     切换即时生效并写进 localStorage（sf.fx）。 */
  function buildAppearance(app) {
    var on = SF.app.isFxOn();
    return h(
      "section.setting-block",
      null,
      field(
        "界面效果",
        h(
          "div.setting-row",
          null,
          h("span.setting-row__title", { text: on ? "轻科幻" : "简洁" }),
          ui.toggle(on, function (next) {
            SF.app.setFx(next);
            paint(app);
          }, { label: "轻科幻界面效果" })
        ),
        {
          hint: "轻科幻会在选中、焦点和容器边缘加上一点仪器感；简洁模式保持同一套配色与排版，只是没有这些效果。随时可切换。",
        }
      ),
      field(
        "主题",
        h(
          "div.setting-row",
          null,
          h("span.setting-row__title", { text: app.theme === "dark" ? "深色" : "浅色" }),
          ui.btn(app.theme === "dark" ? "切到浅色" : "切到深色", {
            size: "sm",
            onClick: function () {
              app.theme = app.theme === "dark" ? "light" : "dark";
              document.documentElement.setAttribute("data-theme", app.theme);
              try { global.localStorage.setItem("sf.theme", app.theme); } catch (e) {}
              paint(app);
            },
          })
        ),
        { hint: "两种主题共用同一套颜色规则，深色下部分强调色会换成更适合暗底的取值。" }
      )
    );
  }

  function buildBody(app) {
    /* M32：外观分区是纯前端设置，不读 Core、不用草稿。
       它必须在草稿门控之前渲染——否则本地读取慢或失败时，这一页会永远
       卡在「正在读取设置」，而它本来就不依赖任何本地数据。 */
    if (currentSection() === "appearance") return [buildNotice(), buildAppearance(app)];
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
      : currentSection() === "summarization"
      ? buildSummarization(app)
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
    cache.section = section === "reminder" ? "reminder" : section === "priority" ? "priority"
      : section === "summarization" ? "summarization" : section === "appearance" ? "appearance" : "ai";
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
