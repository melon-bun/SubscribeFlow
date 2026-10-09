/* ==========================================================================
   自主添加对话框（M13）
   --------------------------------------------------------------------------
   两步：粘贴链接识别 → 确认内容并保存。

   职责边界：只调用 AppClient 的 startIntake / getIntake / cancelIntake /
   saveIntake，不解析链接、不猜渠道、不自己判断重复。识别和查重都在 Core，
   界面只负责把 Core 返回的状态如实呈现出来，并保证迟到的结果不会覆盖
   当前的预览（每次识别带 ticket，晚到且 ticket 不符的结果直接丢弃）。

   状态机（与 Core 的 intake 任务状态一一对应）：
     input  → 用户输入链接，尚未识别
     busy   → queued / running
     preview→ 读取完成，等待确认（预览 5 分钟有效）
     exists → 稳定 ID 已收录，结束本次新增
     failed → 识别失败，可重试
     expired→ 预览失效/取消/连接变化，可重新识别
     saving → 正在保存
   ========================================================================== */
(function (global) {
  "use strict";

  var SF = global.SF;
  var h = SF.dom.h;
  var ui = SF.ui;
  var icon = SF.icon;
  var catalog = SF.catalog;

  /* Core 的识别上限 60 秒。界面不自己另设一个更长的等待，
     也不用「看起来还在动」的进度条掩盖它已经放弃。 */
  var RECOGNIZE_TIMEOUT = 60000;
  var POLL_INTERVAL = 400;

  /**
   * 把错误分成「发生了什么」和「下一步做什么」两段，不拼成一整句。
   * 平台返回的 reason 已经包含它自己的建议，再往上追加一句只会得到
   * 「请稍后重试 稍等片刻再试」这种重复文案。
   *
   * loginNeeded 按渠道区分：只支持单条读取的渠道（如微信）根本没有登录
   * 入口，把它提示成「请在应用内登录」会让用户去找一个不存在的按钮。
   */
  function failureText(error, loginNeeded) {
    var code = (error && error.code) || "";
    var message = (error && error.message) || "内容识别失败，请重试。";
    if ((code === "AUTH_REQUIRED" || code === "AUTH_EXPIRED" || code === "INTERACTION_REQUIRED") && loginNeeded) {
      return {
        title: code === "AUTH_EXPIRED" ? "登录已失效" : "需要登录后才能读取",
        message: message,
        hint: "请在应用内登录该平台，关闭登录窗口后重新识别。",
        tone: "warn",
        action: "login",
      };
    }
    if (code === "INTERACTION_REQUIRED") {
      return { title: "平台要求人工验证", message: message, hint: "本次采集已停止，没有保存任何内容。可更换网络或稍后重新识别。", tone: "warn", retry: true };
    }
    if (code === "ACCESS_FAILED") {
      return { title: "平台没有返回正文", message: message, hint: "本次采集已停止，没有保存任何内容。可以稍后重新识别。", tone: "warn", retry: true };
    }
    if (code === "AUTH_REQUIRED" || code === "AUTH_EXPIRED") {
      return { title: code === "AUTH_EXPIRED" ? "登录已失效" : "需要登录后才能读取", message: message, hint: "这个渠道暂不支持自动读取该链接。", tone: "warn" };
    }
    if (code === "RATE_LIMITED") {
      return { title: "平台访问过于频繁", message: message, hint: "等待一段时间后可以重新识别。", tone: "warn", retry: true };
    }
    if (code === "SCHEMA_CHANGED") {
      return { title: "平台页面结构已变化", message: message, hint: "这条链接暂时读不出来，稍后再试。", tone: "warn", retry: true };
    }
    if (code === "DEPENDENCY_UNAVAILABLE") {
      return { title: "采集依赖不可用", message: message, hint: "请到渠道管理检查连接。", tone: "warn", action: "channels" };
    }
    if (code === "UNSUPPORTED_OPERATION") {
      return { title: "暂不支持这个链接", message: message, hint: "换一个渠道已支持的内容链接再试。", tone: "warn" };
    }
    if (code === "PREVIEW_EXPIRED") {
      return {title:"预览已过期", message:message, hint:"重新识别后即可继续保存。", tone:"warn", retry:true};
    }
    if (code === "TIMEOUT") {
      return { title: "识别超时", message: message, hint: "平台响应慢，可以重新识别。", tone: "warn", retry: true };
    }
    if (code === "BUSY") {
      return { title: "当前任务较多", message: message, hint: "稍后再试。", tone: "warn", retry: true };
    }
    if (code === "INVALID_INPUT" || code === "NOT_FOUND" || code === "INVALID_RESULT") {
      return { title: "无法识别这个链接", message: message, hint: "检查链接是否完整，或换一个链接。", tone: "danger" };
    }
    if (!error) {
      return { title: "识别失败", message: "没有拿到识别结果。", hint: "可以重新识别。", tone: "danger", retry: true };
    }
    return { title: "识别失败", message: message, hint: "可以重新识别。", tone: "danger", retry: true };
  }

  /** 预览里的原始发布时间。只显示平台报告的事实，未知就说未知。 */
  function publishedText(preview) {
    if (!preview || !preview.published) return "发布时间未知";
    var published = preview.published;
    if (!published.value || published.precision === "unknown") return "发布时间未知";
    var value = String(published.value);
    if (published.precision === "date") return value.slice(0, 10) + "（仅日期）";
    return value.replace("T", " ").slice(0, 16);
  }

  /**
   * 这条内容的作者是否已有订阅。
   *
   * 不能凭空判断：app state 里没有订阅列表，只有平台计数，凑一个
   * app.channels 出来只会让「未订阅」永远成立。目录没读到之前一律返回
   * null，界面据此不显示徽标——宁可少说，也不要给一个可能错的结论。
   */
  function subscriptionState(subs, preview) {
    // 目录没读到、或读到的不是列表，一律当作「不知道」：界面不显示徽标，
    // 而不是把未知说成「未订阅」。
    if (!subs || !subs.loaded || !Array.isArray(subs.items)) return null;
    if (!preview || !preview.source) return false;
    return subs.items.some(function (item) {
      return item.platform === preview.channel && item.externalId === preview.source.external_id;
    });
  }

  /**
   * 声明了单条链接读取能力的渠道。
   * 从会话能力推导，不在界面里写死平台名：渠道增减时提示会自己跟着变，
   * 也不会出现「界面说支持、实际没有渠道支持」的空承诺。
   */
  function intakeChannels(app) {
    return ((app.session || {}).channels || []).filter(function (channel) {
      var ops = channel.operations || {};
      if (!((app.session || {}).connections || []).some(function(c) {return c.enabled && c.channel===channel.channel && c.backend===channel.backend;})) return false;
      return ["match_item_url", "resolve_item", "read_item"].every(function (op) {
        return ops[op] && ops[op].supported;
      });
    });
  }

  /**
   * 这个渠道有没有登录入口。只有支持 resolve_source 的渠道才有账号会话
   * 和登录窗口；只支持单条读取的渠道（如微信）对登录提示没有意义。
   */
  function loginNeeded(app, channelId) {
    if (!channelId) return true; // 还没识别出来时保持原有的登录提示
    return (app.session || {}).channels.some(function (channel) {
      var ops = channel.operations || {};
      return channel.channel === channelId && ops.resolve_source && ops.resolve_source.supported;
    });
  }

  function supportedHint(app) {
    var names = intakeChannels(app).map(function (channel) {
      return catalog.platform(channel.channel).name;
    });
    if (!names.length) return "当前没有支持单条链接收录的渠道";
    return "支持 " + names.join("、") + " 的内容链接";
  }

  /**
   * 打开「添加内容」对话框。
   * 返回 { close }，便于调用方（如菜单项）主动关闭。
   */
  function open(app) {
    // 入口按钮已按能力禁用，这里再挡一道：其他调用方（快捷键、菜单）不能
    // 绕过能力声明直接打开一个注定失败的对话框。
    if (!intakeChannels(app).length) {
      ui.toast("当前没有支持单条链接收录的渠道", "error");
      return null;
    }

    var state = {
      phase: "input",
      url: "",
      taskId: null,
      previewId: null,
      connectionId: null,
      channel: null,
      ticket: 0,
      preview: null,
      priority: null,
      tagIds: [],
      error: null,
      exists: null,
      expired: false,
      saving: false,
    };
    var pollTimer = null;
    var previewTimer = null;
    var unsubscribe = app.client.on("intake.changed", function (task) {
      if (!closed && task.task_id === state.taskId && !state.saving) applyTask(task, state.ticket);
    });
    var closed = false;
    var tagCache = { loaded: false, items: [] };
    var subsCache = { loaded: false, loading: false, items: [] };

    var body = h("div.intake");
    var footLeft = h("div.intake__foot-note");
    var cancelBtn = ui.btn("取消", { onClick: function () { close(); } });
    var primaryBtn = ui.btn("识别内容", { variant: "primary", onClick: onPrimary });

    var layer = ui.dialog({
      title: "添加内容",
      wide: false,
      body: body,
      footer: [footLeft, h("div.spacer"), cancelBtn, primaryBtn],
      beforeClose: function () { return !state.saving; },
      onClose: function () {
        closed = true;
        state.ticket++;
        stopPolling();
        if (unsubscribe) unsubscribe();
        // 关闭时释放平台资源：未完成的识别必须停掉，不能让它在后台继续跑。
        if (state.taskId && ["busy", "preview"].indexOf(state.phase) >= 0) {
          app.client.cancelIntake(state.taskId).catch(function () {});
        }
      },
    });
    layer.el.classList.add("dialog--intake");

    /* ---------------- 渲染 ---------------- */

    function paint() {
      if (closed) return;
      SF.dom.render(body, currentBody());
      SF.dom.render(footLeft, footNote());
      paintFooter();
      // 标签目录只在真正要选标签时才请求：识别成功前不需要它，
      // 失败重试也不该为一次用不到的请求多等一轮。
      if (state.phase === "preview") {
        ensureTags();
        ensureSubscriptions();
      }
    }

    /* 订阅目录只用于「未订阅」徽标。读不到时不显示徽标，而不是默认显示
       未订阅——把「不知道」说成「没有」会让用户以为要漏订一个作者。 */
    function ensureSubscriptions() {
      if (subsCache.loaded || subsCache.loading) return;
      subsCache.loading = true;
      app.client
        .listChannels({})
        .then(function (result) {
          subsCache = { loaded: true, loading: false, items: result.items || [] };
          if (!closed && state.phase === "preview") paint();
        })
        .catch(function () {
          subsCache = { loaded: true, loading: false, items: null };
          if (!closed && state.phase === "preview") paint();
        });
    }

    function paintFooter() {
      cancelBtn.disabled = state.saving;
      layer.el.querySelector("[aria-label=\"关闭对话框\"]").disabled = state.saving;
      cancelBtn.style.display = state.phase === "exists" ? "none" : "";
      if (state.phase === "input") {
        primaryBtn.textContent = "识别内容";
        primaryBtn.disabled = !state.url.trim() || state.saving;
      } else if (state.phase === "busy") {
        primaryBtn.textContent = "识别中…";
        primaryBtn.disabled = true;
      } else if (state.phase === "preview") {
        primaryBtn.textContent = "保存内容";
        primaryBtn.disabled = state.saving;
      } else if (state.phase === "saving") {
        primaryBtn.textContent = "保存中…";
        primaryBtn.disabled = true;
      } else if (state.phase === "exists") {
        primaryBtn.textContent = "完成";
        primaryBtn.disabled = false;
      } else {
        primaryBtn.textContent = "重新识别";
        primaryBtn.disabled = false;
      }
    }

    function footNote() {
      if (state.phase === "preview") {
        return [
          icon("info", 14),
          h("span", { text: "收录此条内容，不会订阅作者" }),
        ];
      }
      if (state.phase === "input") {
        return [icon("info", 14), h("span", { text: "识别成功前不会保存任何内容" })];
      }
      if (state.phase === "exists") {
        return [icon("info", 14), h("span", { text: "已存在的记录不会被修改" })];
      }
      return [];
    }

    function currentBody() {
      if (["input", "busy", "failed", "expired"].indexOf(state.phase) >= 0) return inputStep();
      if (state.phase === "preview" || state.phase === "saving") return confirmStep();
      if (state.phase === "exists") return existsStep();
      return problemStep();
    }

    /* ---------------- 第一步：粘贴链接 ---------------- */

    function inputStep() {
      var busy = state.phase === "busy";
      var input = h("input.intake__url-input", {
        type: "url",
        id: "intake-url",
        value: state.url,
        placeholder: "粘贴内容链接，例如 https://www.bilibili.com/video/BV…",
        "aria-label": "内容链接",
        autocomplete: "off",
        spellcheck: "false",
        disabled: busy,
        oninput: function (e) {
          state.url = e.target.value;
          clearBtn.hidden = !state.url;
          paintFooter();
        },
        onkeydown: function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            onPrimary();
          }
        },
      });

      var clearBtn = h(
        "button.intake__url-clear",
        {
          type: "button",
          "aria-label": "清空链接",
          hidden: !state.url,
          disabled: busy,
          onclick: function () {
            state.url = "";
            input.value = "";
            clearBtn.hidden = true;
            input.focus();
            paintFooter();
          },
        },
        icon("close", 12)
      );

      var urlRow = h(
        "div.intake__url" + (busy ? ".is-busy" : ""),
        null,
        h("span.intake__url-icon", null, icon("link", 16)),
        input,
        clearBtn
      );

      var children = [
        h("p.intake__lede", {
          text: "粘贴链接，读取后确认收录。相同内容已收录时会提示已有记录。",
        }),
        stepRail(1),
        h("div.field", null,
          h("label.field__label", { htmlFor: "intake-url", text: "内容链接" }),
          urlRow,
          h("p.field__hint", { text: supportedHint(app) })),
      ];

      if (busy) {
        children.push(
          h(
            "div.intake-status",
            { role: "status", "aria-live": "polite" },
            h(
              "div.intake-status__row",
              null,
              h("span", { text: state.url ? "正在识别这条内容…" : "正在识别…" }),
              ui.progress(0, true),
              ui.btn("取消识别", { size: "sm", onClick: cancelCurrent })
            ),
            h("p.field__hint", { text: "最长等待 60 秒，可随时取消。" })
          )
        );
      } else if (state.error) {
        children.push(problemBlock());
      }

      return children;
    }

    /* ---------------- 第二步：确认内容 ---------------- */

    function confirmStep() {
      var preview = state.preview || {};
      var source = preview.source || {};
      var channel = catalog.platform(preview.channel);

      var cover = preview.thumbnail
        ? h("img", { src: preview.thumbnail, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })
        : icon("file-text", 20);

      var subscribed = subscriptionState(subsCache, preview);
      // 不支持订阅的渠道（如微信）永远没有「订阅」这个状态，显示「未订阅」
      // 会让用户去找一个不存在的关系。
      var showUnsubscribed = subscribed === false && loginNeeded(app, preview.channel);

      var previewCard = h(
        "div.intake-preview",
        null,
        h("div.intake-preview__cover", null, cover),
        h(
          "div.intake-preview__body",
          null,
          h("h3.intake-preview__title", { text: preview.title || "（无标题）" }),
          h(
            "div.intake-preview__author",
            null,
            ui.avatar(source.name, source.avatar),
            h("span", { text: source.name || "未知作者" }),
            h("span.tag.tag--" + channel.id, { text: channel.name }),
            showUnsubscribed ? h("span.intake-preview__unsubscribed", {
              text: "未订阅",
              title: "收录这条内容不会订阅该作者",
            }) : null
          ),
          preview.summary ? h("p.intake-preview__summary", { text: preview.summary }) : null,
          h(
            "div.intake-preview__meta",
            null,
            h(
              "span.intake-preview__published",
              null,
              icon("clock", 13),
              h("span", { text: "原始发布 " + publishedText(preview) })
            ),
            h(
              "span.intake-preview__calendar",
              null,
              icon("calendar-sm", 13),
              h("span", { text: "日历将按保存成功的时间归档" })
            )
          )
        )
      );

      var priorities = [{ id: null, name: subscribed === false ? "未设置" : "跟随来源", icon: "minus" }].concat(
        catalog.PRIORITY_ORDER.map(function (id) {
          return { id: id, name: { high: "高", medium: "中", low: "低" }[id], icon: catalog.priority(id).icon };
        })
      );

      var priorityRow = h(
        "div.intake-priority",
        { role: "group", "aria-label": "内容优先级" },
        priorities.map(function (option) {
          var active = state.priority === option.id;
          return h(
            "button.intake-priority__opt" +
              (option.id ? ".intake-priority__opt--" + option.id : "") +
              (active ? ".is-active" : ""),
            {
              type: "button",
              "aria-pressed": String(active),
              "data-intake-priority": option.id === null ? "none" : option.id,
              disabled: state.saving,
              onclick: function () {
                state.priority = option.id;
                paint();
              },
            },
            h("span.intake-priority__icon", null, icon(option.icon, 13)),
            h("span.intake-priority__name", { text: option.name })
          );
        })
      );

      return [
        h("p.intake__lede", { text: "确认内容与整理设置，保存后进入收件箱。" }),
        stepRail(2),
        lockedUrlRow(),
        h("div.field", null, h("span.field__label", { text: "内容预览" }), previewCard),
        h(
          "div.field",
          null,
          h("span.field__label", { text: "优先级" }),
          priorityRow,
          h("p.field__hint", { text: "未指定时沿用已存在的来源默认值；无订阅时为未设置。" })
        ),
        h(
          "div.field",
          null,
          h("span.field__label", { text: "标签" }),
          tagRow(),
          h("p.field__hint", { text: "在这里选择的标签只作用于本次保存的这条内容。" })
        ),
      ];
    }

    function lockedUrlRow() {
      var input = h("input.intake__url-input", {
        type: "url",
        value: state.url,
        "aria-label": "已识别的内容链接",
        readonly: true,
        tabindex: "-1",
      });
      return h(
        "div.field",
        null,
        h("span.field__label", { text: "内容链接" }),
        h(
          "div.intake__url.is-locked",
          null,
          h("span.intake__url-icon", null, icon("link", 16)),
          input,
          ui.btn("更换链接", {
            size: "sm",
            disabled: state.saving,
            onClick: function () {
              resetToInput();
            },
          })
        )
      );
    }

    function tagRow() {
      var wrap = h("div.intake-tags");
      if (!SF.tagUi) {
        wrap.appendChild(h("span.muted", { text: "标签控件尚未加载，暂时无法添加标签。" }));
        return wrap;
      }

      var addBtn = ui.btn("添加标签", {
        icon: "plus", size: "sm", disabled: state.saving, onClick: openPicker,
      });
      addBtn.setAttribute("data-tag-add", "");
      addBtn.setAttribute("aria-label", "为这条内容添加标签");

      function chipFor(id) {
        return tagCache.items.filter(function (t) { return t.id === id; })[0] ||
          { id: id, name: id, color: "slate" };
      }

      wrap.appendChild(addBtn);
      /* state 是唯一事实来源：任何改动都走 paint() 重画整块，
         不就地修补某一行——就地修补会留在一次已经过期的闭包里，
         界面上看着没反应。 */
      if (!state.tagIds.length) {
        wrap.insertBefore(h("span.muted", { text: "还没有标签" }), addBtn);
      }
      state.tagIds.forEach(function (id) {
        wrap.insertBefore(
          SF.tagUi.tagChip(chipFor(id), {
            removable: !state.saving,
            onRemove: function () {
              if (state.saving) return;
              state.tagIds = state.tagIds.filter(function (x) { return x !== id; });
              paint();
            },
          }),
          addBtn
        );
      });

      function openPicker() {
        // 每次打开都取当前目录：目录可能在对话框打开之后才加载完成。
        ui.tagPicker({
          tags: tagCache.items,
          selected: state.tagIds.slice(),
          title: "为这条内容添加标签",
          onConfirm: function (ids) {
            state.tagIds = ids;
            paint();
          },
        });
      }

      return wrap;
    }

    /* ---------------- 已收录分支 ---------------- */

    function existsStep() {
      var content = state.exists || {};
      return [
        // 停在第 1 步：识别阶段就得出「已收录」，没有可供确认的内容。
        // 高亮第 2 步会让人以为还有东西要确认。
        stepRail(1),
        h(
          "div.intake-exists",
          { role: "status" },
          h("div.intake-exists__title", { text: "这条内容已经收录过了" }),
          h("p.field__hint", {
            text:
              (content.title ? content.title : "已有记录") +
              "。已存在的记录不会被修改，这里的标签和优先级也不会应用到它。",
          }),
          h(
            "div.intake-exists__actions",
            null,
            ui.btn("查看已有记录", {
              variant: "primary",
              onClick: function () {
                var id = content.id;
                close();
                if (id) {
                  viewSaved(id);
                }
              },
            }),
            ui.btn("查看全部内容", {
              onClick: function () {
                close();
                app.search = "";
                app.filters = { quick: "all", platform: null, channelId: null };
                SF.app.navigate("inbox");
                SF.app.render();
              },
            })
          )
        ),
      ];
    }

    /* ---------------- 失败 / 失效 ---------------- */

    function problemStep() {
      var info = failureText(state.error, loginNeeded(app, state.channel));
      return [
        stepRail(1),
        h(
          "div.intake-expired",
          null,
          ui.notice({
            tone: info.tone,
            icon: state.expired ? "clock" : "alert",
            title: state.expired ? "预览已失效" : info.title,
            text: state.expired
              ? "预览已过期、已取消或连接配置发生变化。"
              : info.message,
          }),
          h(
            "p.field__hint",
            { text: state.expired ? "请重新识别这条内容。" : info.hint }
          ),
          /* 「重新识别」是主操作，固定放在页脚，不在这里重复一次。
             区块内只放与当前错误相关的旁路操作。 */
          info.action === "login" || info.action === "channels"
            ? h(
                "div.row.row-gap-3",
                null,
                info.action === "login" ? ui.btn("应用内登录", { onClick: login }) : null,
                info.action === "channels"
                  ? ui.btn("查看连接", { onClick: function () { close(); SF.app.navigate("channels"); } })
                  : null
              )
            : null
        ),
      ];
    }

    function problemBlock() {
      var info = failureText(state.error, loginNeeded(app, state.channel));
      return h("div", null, [
        ui.notice({ tone: info.tone, icon: "alert", title: info.title, text: info.message }),
        h("p.field__hint", { text: info.hint }),
        h(
          "div.row.row-gap-3",
          { style: { "margin-top": "var(--s-4)" } },
          info.action === "login" ? ui.btn("应用内登录", { size: "sm", onClick: login }) : null,
          info.action === "channels"
            ? ui.btn("查看连接", { size: "sm", onClick: function () { close(); SF.app.navigate("channels"); } })
            : null
        ),
      ]);
    }

    /* ---------------- 步骤条 ---------------- */

    function stepRail(active) {
      return h(
        "div.steps",
        { role: "group", "aria-label": "收录步骤" },
        h(
          "div.steps__item" + (active === 1 ? ".is-active" : ".is-done"),
          { "aria-current": active === 1 ? "step" : null },
          h("span.steps__num", { text: "1" }),
          h("span", { text: "粘贴链接" })
        ),
        h("span.steps__arrow", { "aria-hidden": "true" }, icon("arrow-right", 16)),
        h(
          "div.steps__item" + (active === 2 ? ".is-active" : ""),
          { "aria-current": active === 2 ? "step" : null },
          h("span.steps__num", { text: "2" }),
          h("span", { text: "确认内容" })
        )
      );
    }

    /* ---------------- 行为 ---------------- */

    function onPrimary() {
      if (state.phase === "preview") return save();
      if (state.phase === "exists") return close();
      if (state.phase === "input" || state.phase === "failed" || state.phase === "expired") {
        return recognize(state.url);
      }
    }

    function resetToInput() {
      stopPolling();
      if (state.taskId) app.client.cancelIntake(state.taskId).catch(function () {});
      state.phase = "input";
      state.taskId = null;
      state.previewId = null;
      state.preview = null;
      state.error = null;
      state.expired = false;
      state.ticket++;
      paint();
      var input = body.querySelector("#intake-url");
      if (input) {
        input.focus();
        input.select();
      }
    }

    async function recognize(url) {
      var text = String(url || "").trim();
      if (!text) {
        state.error = { code: "INVALID_INPUT", message: "请粘贴内容链接" };
        state.phase = "failed";
        paint();
        return;
      }
      stopPolling();
      var ticket = ++state.ticket;
      state.url = text;
      state.phase = "busy";
      state.error = null;
      state.expired = false;
      state.previewId = null;
      state.connectionId = null;
      state.preview = null;
      state.exists = null;
      state.priority = null;
      state.tagIds = [];
      paint();

      var result;
      try {
        result = await app.client.startIntake({ url: text });
      } catch (err) {
        if (closed || ticket !== state.ticket) return;
        state.phase = "failed";
        state.error = err;
        paint();
        return;
      }
      if (closed || ticket !== state.ticket) {
        if (result.task_id) app.client.cancelIntake(result.task_id).catch(function () {});
        return;
      }
      state.taskId = result.task_id;
      state.connectionId = result.connection_id;
      applyTask(result, ticket);
      if (["queued", "running"].indexOf(result.state) >= 0) poll(ticket);
    }

    function applyTask(task, ticket) {
      if (closed || ticket !== state.ticket) return;
      if (task.connection_id) state.connectionId = task.connection_id;
      if (task.channel) state.channel = task.channel;
      if (task.state === "preview" && task.preview) {
        stopPolling();
        state.previewId = task.preview_id;
        state.preview = task.preview;
        previewTimer = setTimeout(async function () {
          if (closed || state.phase !== "preview") return;
          try { applyTask(await app.client.getIntake(state.taskId), ticket); } catch (_) {}
        }, 300000);
        state.phase = "preview";
        paint();
        return;
      }
      if (task.state === "exists") {
        state.exists = task.content || { id: task.item_id };
        state.phase = "exists";
        stopPolling();
        paint();
        return;
      }
      if (task.state === "failed" || task.state === "cancelled") {
        state.phase = "failed";
        state.error = task.error || { code: "INTERNAL_ERROR", message: "内容识别失败，请重试" };
        stopPolling();
        paint();
        return;
      }
      if (task.state === "expired") {
        state.expired = true;
        state.phase = "expired";
        state.error = task.error || null;
        stopPolling();
        paint();
      }
    }

    function poll(ticket) {
      stopPolling();
      var deadline = Date.now() + RECOGNIZE_TIMEOUT;
      async function tick() {
        if (closed || ticket !== state.ticket || state.phase !== "busy") return;
        if (Date.now() >= deadline) {
          if (state.taskId) app.client.cancelIntake(state.taskId).catch(function () {});
          state.ticket++;
          state.phase = "failed";
          state.error = {code:"TIMEOUT", message:"识别超过时间限制，请重试"};
          paint();
          return;
        }
        try {
          var task = await app.client.getIntake(state.taskId);
          if (closed || ticket !== state.ticket || state.phase !== "busy") return;
          applyTask(task, ticket);
          if (state.phase === "busy") pollTimer = setTimeout(tick, POLL_INTERVAL);
        } catch (err) {
          if (closed || ticket !== state.ticket || state.phase !== "busy") return;
          state.phase = "failed";
          state.error = err;
          paint();
        }
      }
      pollTimer = setTimeout(tick, POLL_INTERVAL);
    }

    function stopPolling() {
      clearTimeout(pollTimer);
      clearTimeout(previewTimer);
      pollTimer = previewTimer = null;
    }

    function cancelCurrent() {
      if (!state.taskId) return resetToInput();
      var ticket = state.ticket;
      app.client.cancelIntake(state.taskId).catch(function () {});
      stopPolling();
      if (closed || ticket !== state.ticket) return;
      state.ticket++;
      state.taskId = null;
      state.previewId = null;
      state.phase = "input";
      paint();
    }

    async function save() {
      if (state.saving || !state.preview) return;
      var previewId = state.previewId;
      state.saving = true;
      state.phase = "saving";
      paint();
      try {
        // 只提交 Core 给出的预览标识和允许的整理字段：平台内容本身由 Core 持有，
        // 前端不提交任何平台 payload。
        var result = await app.client.saveIntake(previewId, {
          priority: state.priority,
          tagIds: state.tagIds,
        });
        if (closed) return;
        state.saving = false;
        if (result.status === "exists") {
          state.exists = result.content || { id: result.item_id };
          state.phase = "exists";
          paint();
          ui.toast("这条内容已经收录过了");
          return;
        }
        close();
        ui.toast("已收录，可在收件箱查看");
        SF.views.inbox.invalidateTags();
        await SF.app.refreshData(true);
        // 保存后把新内容直接选中，用户接着就能整理它。
        if (result.item_id) {
          app.search = "";
          app.filters = { quick: "unread", platform: null, channelId: null };
          app.selectedId = result.item_id;
          SF.app.navigate("inbox");
          SF.app.render();
        }
      } catch (err) {
        if (closed) return;
        state.saving = false;
        if (err.code === "PREVIEW_EXPIRED" || err.code === "STALE_CONFIG" || err.code === "CANCELLED") {
          state.phase = "expired";
          state.error = err;
          paint();
          return;
        }
        state.phase = "preview";
        state.error = err;
        paint();
        ui.toast(err.message || "保存失败，请重试", "error");
      }
    }

    async function viewSaved(id) {
      try {
        var content = await app.client.getContent(id);
        var slot = h("div");
        function repaint(item) { SF.dom.render(slot, SF.views.inbox.detailBody(app, item, repaint)); }
        repaint(content);
        ui.dialog({title:"已有内容", wide:true, body:slot});
      } catch (err) { ui.toast(err.message || "读取内容失败", "error"); }
    }

    function login() {
      var connectionId = state.connectionId || (state.error && state.error.scope_key);
      if (!connectionId) {
        var channel = state.preview && state.preview.channel;
        var connection = (app.session.connections || []).filter(function (c) {
          return c.channel === channel;
        })[0];
        connectionId = connection && connection.id;
      }
      if (!connectionId) {
        ui.toast("找不到对应的平台连接", "error");
        return;
      }
      SF.app.act("login:" + connectionId, function () {
        return app.client.loginConnection(connectionId);
      });
    }

    function close() {
      if (closed || state.saving) return;
      closed = true;
      state.ticket++;
      stopPolling();
      if (unsubscribe) unsubscribe();
      if (state.taskId && ["busy", "preview"].indexOf(state.phase) >= 0) {
        app.client.cancelIntake(state.taskId).catch(function () {});
      }
      layer.close();
    }

    /* 标签目录按需加载：只有走到确认步骤、真的要选标签时才请求。 */
    function ensureTags() {
      if (tagCache.loaded || tagCache.loading) return;
      tagCache.loading = true;
      app.client
        .listTags({})
        .then(function (result) {
          tagCache = { loaded: true, loading: false, items: result.items || [] };
          if (state.phase === "preview") paint();
        })
        .catch(function () {
          tagCache = { loaded: true, loading: false, items: [] };
          if (state.phase === "preview") paint();
        });
    }

    paint();
    return { close: close };
  }

  SF.intakeDialog = { open: open };
})(window);
