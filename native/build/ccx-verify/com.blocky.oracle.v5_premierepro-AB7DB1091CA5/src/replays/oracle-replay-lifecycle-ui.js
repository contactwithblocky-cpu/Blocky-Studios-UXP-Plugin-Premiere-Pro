"use strict";

(function exposeReplayLifecycleUi(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OracleReplayLifecycleUI", api);
})(typeof window !== "undefined" ? window : null, function createReplayLifecycleUiApi() {
  const VIDEO_EXTENSIONS = new Set([
    ".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm", ".wmv",
  ]);
  const SMART_RULE_FIELDS = Object.freeze([
    ["date", "Date"],
    ["duration", "Duration"],
    ["root", "Path root"],
    ["tag", "Tag"],
    ["favorite", "Favorite"],
    ["missing", "Missing media"],
    ["name", "Name"],
  ]);
  const SMART_RULE_OPERATORS = Object.freeze({
    date: Object.freeze([
      ["before", "Before"],
      ["after", "After"],
      ["onOrBefore", "On or before"],
      ["onOrAfter", "On or after"],
      ["between", "Between"],
      ["withinDays", "Within the last days"],
    ]),
    duration: Object.freeze([
      ["lessThan", "Less than"],
      ["atMost", "At most"],
      ["greaterThan", "Greater than"],
      ["atLeast", "At least"],
      ["between", "Between"],
    ]),
    root: Object.freeze([["is", "Is direct parent"], ["isUnder", "Is under"]]),
    tag: Object.freeze([["contains", "Contains"], ["notContains", "Does not contain"]]),
    favorite: Object.freeze([["is", "Is"]]),
    missing: Object.freeze([["is", "Is"]]),
    name: Object.freeze([["contains", "Contains"], ["startsWith", "Starts with"], ["equals", "Equals"]]),
  });
  const SMART_DATE_SOURCES = Object.freeze([
    ["exportedAt", "Export date"],
    ["firstSeenAt", "First seen date"],
    ["modifiedAt", "Source modified date"],
  ]);

  function cleanText(value, limit = 240) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, limit);
  }

  function replaceElementChildren(element, nodes = []) {
    element.innerHTML = "";
    for (const node of nodes) element.appendChild(node);
  }

  function parseTags(value, limit = 64) {
    const seen = new Set();
    const tags = [];
    for (const part of String(value || "").split(/[,\n]/)) {
      const tag = cleanText(part, 80);
      const key = tag.toLocaleLowerCase("en-US");
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
      if (tags.length >= limit) break;
    }
    return tags;
  }

  function sourceNameParts(path) {
    const normalized = String(path || "").replace(/\//g, "\\");
    const name = normalized.slice(normalized.lastIndexOf("\\") + 1);
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return { name, stem: name, extension: "" };
    return { name, stem: name.slice(0, dot), extension: name.slice(dot).toLocaleLowerCase("en-US") };
  }

  function validateSourceStem(value, originalPath) {
    const stem = cleanText(value, 240);
    const parts = sourceNameParts(originalPath);
    if (!stem) return { ok: false, message: "Enter a source filename." };
    if (!parts.extension || !VIDEO_EXTENSIONS.has(parts.extension)) {
      return { ok: false, message: "The recorded source does not use a supported video extension." };
    }
    if (/[\\/:*?"<>|]/.test(stem) || /[. ]$/.test(stem) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) {
      return { ok: false, message: "The filename contains characters or a reserved name Windows cannot use." };
    }
    return { ok: true, stem, extension: parts.extension, filename: `${stem}${parts.extension}` };
  }

  function normalizeCollectionDraft(value = {}) {
    const name = cleanText(value.name, 120);
    const color = /^#[0-9a-f]{6}$/i.test(String(value.color || ""))
      ? String(value.color).toUpperCase()
      : "#D948D7";
    const rules = [];
    const nameRule = cleanText(value.ruleName, 240);
    const root = cleanText(value.root, 32767);
    const tag = cleanText(value.tag, 80);
    const dateFrom = cleanText(value.dateFrom, 32);
    const dateTo = cleanText(value.dateTo, 32);
    if (nameRule) rules.push({ field: "name", operator: "contains", value: nameRule });
    if (root) rules.push({ field: "root", operator: "isUnder", value: root });
    if (tag) rules.push({ field: "tag", operator: "contains", value: tag });
    const fromBoundary = /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) ? `${dateFrom}T00:00:00.000Z` : dateFrom;
    const toBoundary = /^\d{4}-\d{2}-\d{2}$/.test(dateTo) ? `${dateTo}T23:59:59.999Z` : dateTo;
    if (dateFrom && dateTo) rules.push({ field: "date", operator: "between", from: fromBoundary, to: toBoundary });
    else if (dateFrom) rules.push({ field: "date", operator: "onOrAfter", value: fromBoundary });
    else if (dateTo) rules.push({ field: "date", operator: "onOrBefore", value: toBoundary });
    const minimumDurationText = String(value.minimumDurationSeconds ?? "").trim();
    const maximumDurationText = String(value.maximumDurationSeconds ?? "").trim();
    const minimumDurationSeconds = minimumDurationText ? Number(minimumDurationText) : Number.NaN;
    const maximumDurationSeconds = maximumDurationText ? Number(maximumDurationText) : Number.NaN;
    if (minimumDurationText && Number.isFinite(minimumDurationSeconds) && minimumDurationSeconds >= 0) {
      if (maximumDurationText && Number.isFinite(maximumDurationSeconds) && maximumDurationSeconds >= minimumDurationSeconds) {
        rules.push({
          field: "duration",
          operator: "between",
          minimumMs: Math.round(minimumDurationSeconds * 1000),
          maximumMs: Math.round(maximumDurationSeconds * 1000),
        });
      } else {
        rules.push({ field: "duration", operator: "atLeast", valueMs: Math.round(minimumDurationSeconds * 1000) });
      }
    }
    if (
      Number.isFinite(maximumDurationSeconds) &&
      maximumDurationSeconds >= 0 &&
      !(minimumDurationText && Number.isFinite(minimumDurationSeconds) && minimumDurationSeconds >= 0)
    ) {
      rules.push({ field: "duration", operator: "atMost", valueMs: Math.round(maximumDurationSeconds * 1000) });
    }
    if (value.favorite === true) rules.push({ field: "favorite", operator: "is", value: true });
    if (value.missing === true) rules.push({ field: "missing", operator: "is", value: true });
    return { name, color, smartRules: rules.length ? { match: "all", rules } : null };
  }

  function optionLabel(options, value, fallback = "") {
    const match = options.find((entry) => entry[0] === value);
    return match ? match[1] : fallback || cleanText(value, 80);
  }

  function secondsLabel(milliseconds) {
    const seconds = Number(milliseconds) / 1000;
    return Number.isFinite(seconds) ? `${Number(seconds.toFixed(3))}s` : "invalid duration";
  }

  function smartRuleSummary(rule = {}) {
    const field = cleanText(rule.field, 32);
    const operator = cleanText(rule.operator, 32);
    const fieldLabel = optionLabel(SMART_RULE_FIELDS, field, "Unsupported field");
    const operatorLabel = optionLabel(SMART_RULE_OPERATORS[field] || [], operator, "unsupported operator").toLocaleLowerCase("en-US");
    if (field === "date") {
      const source = optionLabel(SMART_DATE_SOURCES, rule.source || "exportedAt", "Export date");
      if (operator === "withinDays") return `${source} within the last ${Number(rule.value)} day${Number(rule.value) === 1 ? "" : "s"}`;
      if (operator === "between") return `${source} between ${cleanText(rule.from, 64)} and ${cleanText(rule.to, 64)}`;
      return `${source} ${operatorLabel} ${cleanText(rule.value, 64)}`;
    }
    if (field === "duration") {
      if (operator === "between") return `${fieldLabel} between ${secondsLabel(rule.minimumMs)} and ${secondsLabel(rule.maximumMs)}`;
      return `${fieldLabel} ${operatorLabel} ${secondsLabel(rule.valueMs)}`;
    }
    if (field === "favorite" || field === "missing") return `${fieldLabel} is ${rule.value === true ? "yes" : "no"}`;
    return `${fieldLabel} ${operatorLabel} ${cleanText(rule.value, field === "root" ? 32767 : 260)}`;
  }

  function relinkAmbiguityReason(assignment = {}) {
    return cleanText(assignment.ambiguityReason || assignment.reason, 1000);
  }

  function relinkSelectionNeedsConfirmation(selection) {
    const assignments = selection && Array.isArray(selection.assignments) ? selection.assignments : [];
    return Boolean(selection && selection.ambiguous === true) || assignments.some((assignment) => assignment && assignment.ambiguous === true);
  }

  function focusableElements(container) {
    if (!container || typeof container.querySelectorAll !== "function") return [];
    return Array.from(container.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
  }

  function trapTab(event, container) {
    if (!event || event.key !== "Tab") return false;
    const focusable = focusableElements(container);
    if (!focusable.length) {
      event.preventDefault();
      if (container && typeof container.focus === "function") container.focus();
      return true;
    }
    const active = container.ownerDocument && container.ownerDocument.activeElement;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (active === first || !container.contains(active))) {
      event.preventDefault();
      last.focus();
      return true;
    }
    if (!event.shiftKey && (active === last || !container.contains(active))) {
      event.preventDefault();
      first.focus();
      return true;
    }
    return false;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function button(label, command, kind = "quiet") {
    const node = element("button", `oracle-button oracle-button--${kind}`, label);
    node.type = "button";
    node.dataset.lifecycleCommand = command;
    return node;
  }

  function field(labelText, control, hint = "") {
    const label = element("label", "oracle-field replay-lifecycle-field");
    label.append(element("span", "", labelText), control);
    if (hint) label.append(element("small", "replay-lifecycle-field__hint", hint));
    return label;
  }

  function textInput(name, value = "", options = {}) {
    const input = document.createElement(options.multiline ? "textarea" : "input");
    const textField = /** @type {HTMLInputElement} */ (input);
    if (!options.multiline) textField.type = options.type || "text";
    input.name = name;
    input.value = String(value === undefined || value === null ? "" : value);
    if (options.maxLength) input.maxLength = options.maxLength;
    if (!options.multiline && options.min !== undefined) textField.min = String(options.min);
    if (!options.multiline && options.max !== undefined) textField.max = String(options.max);
    if (!options.multiline && options.step !== undefined) textField.step = String(options.step);
    if (options.readOnly) input.readOnly = true;
    if (options.placeholder) input.placeholder = options.placeholder;
    return input;
  }

  function selectInput(name, values, selected) {
    const select = document.createElement("select");
    select.name = name;
    replaceSelectOptions(select, values, selected);
    return select;
  }

  function replaceSelectOptions(select, values, selected) {
    replaceElementChildren(select);
    for (const [value, label] of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = value === selected;
      select.appendChild(option);
    }
    select.value = values.some((entry) => entry[0] === selected)
      ? selected
      : values.length ? values[0][0] : "";
  }

  function checkInput(name, labelText, checked = false) {
    const label = element("label", "oracle-check replay-lifecycle-check");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = name;
    input.checked = checked === true;
    label.append(input, element("span", "", labelText));
    return label;
  }

  function replayList(replays, options = {}) {
    const list = element("ul", "replay-lifecycle-path-list");
    const values = Array.isArray(replays) ? replays : [];
    const maximum = Math.max(1, Number(options.maximum) || 12);
    for (const replay of values.slice(0, maximum)) {
      const item = element("li");
      item.append(
        element("strong", "", cleanText(replay.title || replay.displayNameOverride || replay.sourceName, 240)),
        element("code", "", cleanText(replay.filepath || replay.canonicalPath, 32767)),
      );
      list.appendChild(item);
    }
    if (values.length > maximum) list.appendChild(element("li", "", `+ ${values.length - maximum} more`));
    return list;
  }

  function readNamedControl(container, name) {
    return container && container.querySelector ? container.querySelector(`[name="${name}"]`) : null;
  }

  function valueOf(container, name) {
    const control = readNamedControl(container, name);
    return control ? String(control.value || "") : "";
  }

  function checkedOf(container, name) {
    const control = readNamedControl(container, name);
    return Boolean(control && control.checked);
  }

  function smartRuleTemplate(field = "name", operator = "") {
    const normalizedField = SMART_RULE_OPERATORS[field] ? field : "name";
    const operators = SMART_RULE_OPERATORS[normalizedField];
    const normalizedOperator = operators.some((entry) => entry[0] === operator) ? operator : operators[0][0];
    if (normalizedField === "date") {
      return normalizedOperator === "between"
        ? { field: normalizedField, operator: normalizedOperator, source: "exportedAt", from: "", to: "" }
        : { field: normalizedField, operator: normalizedOperator, source: "exportedAt", value: "" };
    }
    if (normalizedField === "duration") {
      return normalizedOperator === "between"
        ? { field: normalizedField, operator: normalizedOperator, minimumMs: 0, maximumMs: 0 }
        : { field: normalizedField, operator: normalizedOperator, valueMs: 0 };
    }
    if (normalizedField === "favorite" || normalizedField === "missing") {
      return { field: normalizedField, operator: normalizedOperator, value: true };
    }
    return { field: normalizedField, operator: normalizedOperator, value: "" };
  }

  function renderSmartRuleValueControls(ruleRow, rule = {}) {
    const values = ruleRow.querySelector("[data-smart-rule-values]");
    if (!values) return;
    replaceElementChildren(values);
    const fieldName = valueOf(ruleRow, "smartRuleField") || cleanText(rule.field, 32) || "name";
    const operator = valueOf(ruleRow, "smartRuleOperator") || cleanText(rule.operator, 32) || SMART_RULE_OPERATORS[fieldName][0][0];
    if (fieldName === "date") {
      values.append(field("Date source", selectInput("smartRuleDateSource", SMART_DATE_SOURCES, rule.source || "exportedAt")));
      if (operator === "withinDays") {
        values.append(field("Days", textInput("smartRuleDays", rule.value, { type: "number", min: 0, max: 36500, step: 1 })));
      } else if (operator === "between") {
        values.append(
          field("From (ISO date/time)", textInput("smartRuleDateFrom", rule.from, { maxLength: 64, placeholder: "2026-07-01T00:00:00.000Z" })),
          field("To (ISO date/time)", textInput("smartRuleDateTo", rule.to, { maxLength: 64, placeholder: "2026-07-31T23:59:59.999Z" })),
        );
      } else {
        values.append(field("Boundary (ISO date/time)", textInput("smartRuleDateValue", rule.value, { maxLength: 64, placeholder: "2026-07-15T00:00:00.000Z" })));
      }
      return;
    }
    if (fieldName === "duration") {
      if (operator === "between") {
        const minimumSeconds = Number.isFinite(Number(rule.minimumMs)) ? Number(rule.minimumMs) / 1000 : "";
        const maximumSeconds = Number.isFinite(Number(rule.maximumMs)) ? Number(rule.maximumMs) / 1000 : "";
        values.append(
          field("Minimum seconds", textInput("smartRuleDurationMin", String(minimumSeconds), { type: "number", min: 0, step: 0.001 })),
          field("Maximum seconds", textInput("smartRuleDurationMax", String(maximumSeconds), { type: "number", min: 0, step: 0.001 })),
        );
      } else {
        const seconds = Number.isFinite(Number(rule.valueMs)) ? Number(rule.valueMs) / 1000 : "";
        values.append(field("Seconds", textInput("smartRuleDurationValue", String(seconds), { type: "number", min: 0, step: 0.001 })));
      }
      return;
    }
    if (fieldName === "favorite" || fieldName === "missing") {
      values.append(field("Value", selectInput("smartRuleBooleanValue", [["true", "Yes"], ["false", "No"]], rule.value === false ? "false" : "true")));
      return;
    }
    const labels = { root: "Windows path", tag: "Tag", name: "Name text" };
    values.append(field(
      labels[fieldName] || "Value",
      textInput("smartRuleTextValue", rule.value, {
        maxLength: fieldName === "root" ? 32767 : fieldName === "tag" ? 240 : 260,
        placeholder: fieldName === "root" ? "D:\\Blocky Studios Replays" : "",
      }),
    ));
  }

  function createSmartRuleEditorRow(rule = smartRuleTemplate()) {
    const fieldName = SMART_RULE_OPERATORS[rule.field] ? rule.field : "name";
    const operatorValues = SMART_RULE_OPERATORS[fieldName];
    const operator = operatorValues.some((entry) => entry[0] === rule.operator) ? rule.operator : operatorValues[0][0];
    const row = element("article", "replay-collection-manager-row");
    row.dataset.smartRuleRow = "true";
    const controls = element("div", "replay-collection-create");
    controls.style.setProperty("grid-column", "1 / -1");
    controls.append(
      field("Field", selectInput("smartRuleField", SMART_RULE_FIELDS, fieldName)),
      field("Condition", selectInput("smartRuleOperator", operatorValues, operator)),
    );
    const values = element("div", "replay-collection-create");
    values.dataset.smartRuleValues = "true";
    values.style.setProperty("grid-column", "1 / -1");
    controls.append(values);
    const actions = element("div", "replay-collection-manager-row__actions");
    const remove = button("Remove rule", "smart-rule-remove", "danger");
    actions.append(remove);
    row.append(controls, actions);
    renderSmartRuleValueControls(row, { ...rule, field: fieldName, operator });
    return row;
  }

  function syncSmartRuleRemoveButtons(editor) {
    const rows = Array.from(editor.querySelectorAll("[data-smart-rule-row]"));
    for (const row of rows) {
      const remove = row.querySelector('[data-lifecycle-command="smart-rule-remove"]');
      if (!remove) continue;
      remove.disabled = rows.length <= 1;
      remove.title = remove.disabled ? "A smart collection requires at least one rule." : "Remove this smart rule";
    }
  }

  function readNonNegativeNumber(container, name, label, maximum = Number.POSITIVE_INFINITY) {
    const raw = valueOf(container, name).trim();
    const value = Number(raw);
    if (!raw) throw new Error(`${label} is required.`);
    if (!Number.isFinite(value) || value < 0 || value > maximum) throw new Error(`${label} must be a non-negative number.`);
    return value;
  }

  function readIsoValue(container, name, label) {
    const value = cleanText(valueOf(container, name), 64);
    const timestamp = Date.parse(value);
    if (!value || !Number.isFinite(timestamp)) throw new Error(`${label} must be a valid ISO date or date/time.`);
    return new Date(timestamp).toISOString();
  }

  function serializeSmartRuleRow(row) {
    const fieldName = cleanText(valueOf(row, "smartRuleField"), 32);
    const operator = cleanText(valueOf(row, "smartRuleOperator"), 32);
    const supported = SMART_RULE_OPERATORS[fieldName];
    if (!supported || !supported.some((entry) => entry[0] === operator)) throw new Error("Choose a supported smart-rule field and condition.");
    if (fieldName === "date") {
      const source = valueOf(row, "smartRuleDateSource") || "exportedAt";
      if (operator === "withinDays") return { field: fieldName, operator, source, value: readNonNegativeNumber(row, "smartRuleDays", "Date window", 36500) };
      if (operator === "between") {
        const from = readIsoValue(row, "smartRuleDateFrom", "From date");
        const to = readIsoValue(row, "smartRuleDateTo", "To date");
        if (from > to) throw new Error("Smart-rule date range must start before it ends.");
        return { field: fieldName, operator, source, from, to };
      }
      return { field: fieldName, operator, source, value: readIsoValue(row, "smartRuleDateValue", "Date boundary") };
    }
    if (fieldName === "duration") {
      if (operator === "between") {
        const minimum = readNonNegativeNumber(row, "smartRuleDurationMin", "Minimum duration");
        const maximum = readNonNegativeNumber(row, "smartRuleDurationMax", "Maximum duration");
        if (minimum > maximum) throw new Error("Smart-rule duration range must start below its maximum.");
        return { field: fieldName, operator, minimumMs: Math.round(minimum * 1000), maximumMs: Math.round(maximum * 1000) };
      }
      return { field: fieldName, operator, valueMs: Math.round(readNonNegativeNumber(row, "smartRuleDurationValue", "Duration") * 1000) };
    }
    if (fieldName === "favorite" || fieldName === "missing") {
      return { field: fieldName, operator, value: valueOf(row, "smartRuleBooleanValue") !== "false" };
    }
    const value = cleanText(valueOf(row, "smartRuleTextValue"), fieldName === "root" ? 32767 : fieldName === "tag" ? 240 : 260);
    if (!value) throw new Error(`${optionLabel(SMART_RULE_FIELDS, fieldName)} rule requires a value.`);
    return { field: fieldName, operator, value };
  }

  function serializeSmartRulesEditor(editor) {
    const rows = Array.from(editor.querySelectorAll("[data-smart-rule-row]"));
    if (!rows.length) throw new Error("A smart collection requires at least one rule.");
    if (rows.length > 32) throw new Error("Smart collections support at most 32 rules.");
    return {
      match: valueOf(editor, "smartRuleMatch") === "any" ? "any" : "all",
      rules: rows.map(serializeSmartRuleRow),
    };
  }

  class ReplayLifecycleDialogController {
    constructor(elements, callbacks = {}) {
      this.elements = elements;
      this.document = callbacks.document || (typeof document !== "undefined" ? document : null);
      this.interactionRoot = callbacks.root || elements.replayLifecycleBackdrop || null;
      this.onApply = typeof callbacks.onApply === "function" ? callbacks.onApply : async () => undefined;
      this.onChooseRelink = typeof callbacks.onChooseRelink === "function" ? callbacks.onChooseRelink : async () => null;
      this.onCollectionCommand = typeof callbacks.onCollectionCommand === "function"
        ? callbacks.onCollectionCommand
        : async () => null;
      this.onCancelBusy = typeof callbacks.onCancelBusy === "function"
        ? callbacks.onCancelBusy
        : async () => undefined;
      this.onAnnounce = typeof callbacks.onAnnounce === "function"
        ? callbacks.onAnnounce
        : () => undefined;
      this.mode = "";
      /** @type {any} */
      this.context = null;
      this.restoreFocus = null;
      this.started = false;
      this.busy = false;
      this.focusFrame = null;
      this.collectionDrag = null;
      this.onClose = () => this.close(true);
      this.onCancel = () => {
        if (this.busy) void this.onCancelBusy(this.mode, this.context);
        else this.close(true);
      };
      this.onBackdrop = (event) => {
        if (event.target === this.elements.replayLifecycleBackdrop) this.close(true);
      };
      this.onKeyDown = (event) => {
        if (!this.isOpen() || event.defaultPrevented || !this.ownsInteraction(event)) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.close(true);
          return;
        }
        trapTab(event, this.elements.replayLifecycleDialog);
      };
      this.onBodyClick = (event) => this.handleBodyCommand(event);
      this.onBodyKeyDown = (event) => this.handleCollectionReorderKeyDown(event);
      this.onBodyPointerDown = (event) => this.beginCollectionReorder(event);
      this.onBodyPointerMove = (event) => this.updateCollectionReorder(event);
      this.onBodyPointerUp = (event) => this.finishCollectionReorder(event, false);
      this.onBodyPointerCancel = (event) => this.finishCollectionReorder(event, true);
      this.onBodyChange = (event) => {
        if (this.mode === "delete" && event && event.target && event.target.name === "recycle") {
          this.syncDeleteAction();
        } else if (this.mode === "archive-restore" && event && event.target && event.target.name === "confirmLifecycle") {
          this.elements.replayLifecycleApply.disabled = !event.target.checked;
        } else if (this.mode === "relink" && event && event.target && event.target.name === "confirmAmbiguous") {
          this.syncRelinkAction();
        } else if (
          this.mode === "collection-manager" &&
          event && event.target &&
          (event.target.name === "smartRuleField" || event.target.name === "smartRuleOperator")
        ) {
          const row = event.target.closest && event.target.closest("[data-smart-rule-row]");
          if (!row) return;
          const fieldName = valueOf(row, "smartRuleField") || "name";
          let operator = valueOf(row, "smartRuleOperator");
          if (event.target.name === "smartRuleField") {
            const operatorControl = readNamedControl(row, "smartRuleOperator");
            replaceSelectOptions(operatorControl, SMART_RULE_OPERATORS[fieldName] || SMART_RULE_OPERATORS.name, "");
            operator = valueOf(row, "smartRuleOperator");
          }
          renderSmartRuleValueControls(row, smartRuleTemplate(fieldName, operator));
          this.setError("");
        }
      };
      this.onApplyClick = () => this.apply();
      this.onSecondaryClick = () => this.handleSecondary();
    }

    ownsInteraction(event) {
      const root = this.interactionRoot;
      if (!root || typeof root.contains !== "function") return true;
      const target = event && event.target;
      if (target) return target === root || root.contains(target);
      const active = this.document && this.document.activeElement;
      return !active || active === root || root.contains(active);
    }

    start() {
      if (this.started) return;
      this.started = true;
      this.elements.replayLifecycleClose.addEventListener("click", this.onClose);
      this.elements.replayLifecycleCancel.addEventListener("click", this.onCancel);
      this.elements.replayLifecycleBackdrop.addEventListener("click", this.onBackdrop);
      this.elements.replayLifecycleBody.addEventListener("click", this.onBodyClick);
      this.elements.replayLifecycleBody.addEventListener("keydown", this.onBodyKeyDown);
      this.elements.replayLifecycleBody.addEventListener("change", this.onBodyChange);
      this.elements.replayLifecycleBody.addEventListener("pointerdown", this.onBodyPointerDown);
      this.elements.replayLifecycleBody.addEventListener("pointermove", this.onBodyPointerMove);
      this.elements.replayLifecycleBody.addEventListener("pointerup", this.onBodyPointerUp);
      this.elements.replayLifecycleBody.addEventListener("pointercancel", this.onBodyPointerCancel);
      this.elements.replayLifecycleApply.addEventListener("click", this.onApplyClick);
      this.elements.replayLifecycleSecondary.addEventListener("click", this.onSecondaryClick);
      if (this.document) this.document.addEventListener("keydown", this.onKeyDown, true);
    }

    isOpen() {
      return Boolean(this.mode && !this.elements.replayLifecycleBackdrop.hidden);
    }

    open(mode, context = {}, restoreFocus = null) {
      if (!this.started) this.start();
      this.mode = String(mode || "");
      this.context = { ...context, replays: Array.isArray(context.replays) ? context.replays : [] };
      this.restoreFocus = restoreFocus || (this.document && this.document.activeElement);
      this.setError("");
      this.elements.replayLifecycleBackdrop.hidden = false;
      this.elements.replayLifecycleDialog.setAttribute("aria-busy", "false");
      this.render();
      if (this.focusFrame !== null) cancelAnimationFrame(this.focusFrame);
      this.focusFrame = requestAnimationFrame(() => {
        this.focusFrame = null;
        if (!this.isOpen()) return;
        const target = focusableElements(this.elements.replayLifecycleDialog)[0] || this.elements.replayLifecycleDialog;
        if (target && typeof target.focus === "function") target.focus();
      });
    }

    close(restore = true) {
      if (!this.isOpen() || this.busy) return;
      const target = this.restoreFocus;
      this.mode = "";
      this.context = null;
      this.restoreFocus = null;
      if (this.focusFrame !== null) {
        cancelAnimationFrame(this.focusFrame);
        this.focusFrame = null;
      }
      this.elements.replayLifecycleBackdrop.hidden = true;
      replaceElementChildren(this.elements.replayLifecycleBody);
      this.setError("");
      if (restore && target && typeof target.focus === "function") target.focus();
    }

    setError(message) {
      const text = cleanText(message, 1000);
      this.elements.replayLifecycleError.textContent = text;
      this.elements.replayLifecycleError.hidden = !text;
    }

    setChrome({ kicker = "Replay library", title, apply = "Apply", secondary = "", danger = false }) {
      this.elements.replayLifecycleKicker.textContent = kicker;
      this.elements.replayLifecycleTitle.textContent = title;
      this.elements.replayLifecycleApply.textContent = apply;
      this.elements.replayLifecycleApply.classList.toggle("oracle-button--danger", danger);
      this.elements.replayLifecycleApply.classList.toggle("oracle-button--primary", !danger);
      this.elements.replayLifecycleApply.disabled = false;
      this.elements.replayLifecycleApply.title = "";
      this.elements.replayLifecycleCancel.hidden = false;
      this.elements.replayLifecycleCancel.disabled = false;
      this.elements.replayLifecycleCancel.textContent = "Cancel";
      this.elements.replayLifecycleSecondary.textContent = secondary;
      this.elements.replayLifecycleSecondary.hidden = !secondary;
    }

    syncDeleteAction() {
      if (this.mode !== "delete" || (this.context && this.context.operationResult)) return;
      const recycle = checkedOf(this.elements.replayLifecycleBody, "recycle");
      const count = this.context && Array.isArray(this.context.replays) ? this.context.replays.length : 0;
      this.elements.replayLifecycleApply.textContent = recycle
        ? `Archive and recycle ${count === 1 ? "source" : `${count} sources`}`
        : "Archive";
      this.elements.replayLifecycleApply.classList.toggle("oracle-button--danger", recycle);
      this.elements.replayLifecycleApply.classList.toggle("oracle-button--primary", !recycle);
    }

    renderOperationResult(result) {
      const body = this.elements.replayLifecycleBody;
      const summary = element("p", result && result.ok ? "replay-lifecycle-success" : "replay-lifecycle-warning");
      const counts = result && result.counts || {};
      summary.textContent = `${Number(counts.success) || 0} succeeded · ${Number(counts.failed) || 0} failed · ${Number(counts.canceled) || 0} canceled · ${Number(counts.skipped) || 0} skipped`;
      const list = element("ul", "replay-operation-results");
      for (const item of Array.isArray(result && result.items) ? result.items : []) {
        const row = element("li", `replay-operation-result replay-operation-result--${cleanText(item.status, 24)}`);
        row.append(
          element("strong", "", cleanText(item.name || item.replayId, 240)),
          element("span", "", cleanText(item.status, 24)),
          element("code", "", cleanText(item.path || item.message || item.code, 32767)),
        );
        list.append(row);
      }
      body.append(summary, list);
    }

    render() {
      const body = this.elements.replayLifecycleBody;
      replaceElementChildren(body);
      const first = this.context && this.context.replays[0];
      if (this.mode === "rename-display") {
        this.setChrome({ title: "Rename display name", apply: "Save name" });
        body.append(
          field("Display name", textInput("displayName", first && first.title, { maxLength: 240 }), "This changes Blocky Studios metadata only. The source filename stays unchanged."),
          replayList(this.context.replays, { maximum: 1 }),
        );
      } else if (this.mode === "rename-source") {
        this.setChrome({ title: "Rename source file", apply: "Rename source", danger: true });
        const parts = sourceNameParts(first && first.filepath);
        body.append(
          element("p", "replay-lifecycle-warning", "Blocky Studios will revalidate the exact file identity immediately before the rename. The video extension is preserved."),
          field("New filename", textInput("sourceStem", parts.stem, { maxLength: 240 }), `Extension: ${parts.extension || "unavailable"}`),
          replayList(this.context.replays, { maximum: 1 }),
        );
        if (Number(this.context.premiereReferenceCount) > 0) {
          const warning = element("p", "replay-lifecycle-blocker", "Premiere currently references this path and Premiere 26.3 exposes no supported ProjectItem relink action. Rename is blocked to avoid breaking the project.");
          body.prepend(warning);
          this.elements.replayLifecycleApply.disabled = true;
          this.elements.replayLifecycleApply.title = warning.textContent;
        } else {
          this.elements.replayLifecycleApply.disabled = false;
          this.elements.replayLifecycleApply.title = "";
        }
      } else if (this.mode === "tags") {
        this.setChrome({ title: this.context.replays.length > 1 ? "Edit replay tags" : "Edit tags", apply: "Save tags" });
        const shared = this.context.sharedTags || (first && first.tags) || [];
        body.append(
          field("Tags", textInput("tags", shared.join(", "), { maxLength: 4000, placeholder: "hero, orbit, final" }), "Separate tags with commas."),
        );
        if (this.context.replays.length > 1) {
          body.append(field("Batch behavior", selectInput("batchMode", [["add", "Add tags"], ["remove", "Remove tags"], ["replace", "Replace tags"]], "add")));
        }
      } else if (this.mode === "rating-notes") {
        this.setChrome({ title: "Rating and notes", apply: "Save metadata" });
        body.append(
          field("Rating", textInput("rating", first && first.rating, { type: "number", min: 0, max: 5, step: 1 }), "0 is unrated; 5 is highest."),
          field("Notes", textInput("notes", first && first.notes, { multiline: true, maxLength: 16000 }), "Notes are searchable inside Blocky Studios."),
        );
      } else if (this.mode === "collections") {
        this.setChrome({ title: "Collections", apply: "Update membership", secondary: "Manage collections" });
        const collections = Array.isArray(this.context.collections) ? this.context.collections : [];
        const list = element("div", "replay-collection-checklist");
        if (!collections.length) {
          list.append(element("p", "replay-lifecycle-empty", "No collections yet. Open Manage collections to create one."));
        }
        for (const collection of collections) {
          const membership = new Set(this.context.sharedCollectionIds || []);
          const check = checkInput(`collection:${collection.id}`, collection.name, membership.has(collection.id));
          check.dataset.collectionId = collection.id;
          check.style.setProperty("--collection-color", collection.color || "#D948D7");
          if (collection.smartRules) {
            const input = check.querySelector("input");
            if (input) input.disabled = true;
            check.title = "Smart collection membership is controlled by its visible rules.";
            const rules = Array.isArray(collection.smartRules.rules) ? collection.smartRules.rules : [];
            const details = rules.length
              ? `Match ${collection.smartRules.match === "any" ? "any" : "all"}: ${rules.map(smartRuleSummary).join(" · ")}`
              : "Smart rules are unavailable";
            check.append(element("small", "replay-collection-rule-label", `Rule-driven · ${details}`));
          }
          list.appendChild(check);
        }
        body.append(list);
        if (this.context.replays.length > 1) {
          body.append(field("Batch behavior", selectInput("batchMode", [["add", "Add to selected collections"], ["remove", "Remove from selected collections"], ["replace", "Replace collection membership"]], "add")));
        }
      } else if (this.mode === "archive-restore") {
        const confirmation = this.context.lifecycleConfirmation || {};
        const action = confirmation.action === "restore" ? "restore" : "archive";
        const verb = action === "restore" ? "Restore" : "Archive";
        this.setChrome({
          title: `${verb} ${this.context.replays.length} replay${this.context.replays.length === 1 ? "" : "s"}`,
          apply: verb,
        });
        body.append(
          element("p", "replay-lifecycle-warning", action === "restore"
            ? "Restoring returns these records to the active Blocky Studios library. It does not modify source media or Premiere ProjectItems."
            : "Archiving hides these records from active views. It does not remove source media, sidecars, folders, or Premiere ProjectItems."),
          replayList(this.context.replays),
        );
        if (confirmation.requiresExplicitConfirmation) {
          body.append(checkInput(
            "confirmLifecycle",
            `I reviewed all ${confirmation.count || this.context.replays.length} exact source paths`,
            false,
          ));
          this.elements.replayLifecycleApply.disabled = true;
        }
      } else if (this.mode === "delete") {
        if (this.context.operationResult) {
          this.setChrome({ title: "Recycle Bin results", apply: "Done" });
          this.elements.replayLifecycleCancel.hidden = true;
          this.renderOperationResult(this.context.operationResult);
        } else {
          this.setChrome({ title: this.context.replays.length > 1 ? `Archive ${this.context.replays.length} replays` : "Archive replay", apply: "Archive", secondary: this.context.allMissing ? "Remove metadata" : "", danger: false });
          const recycleChoice = checkInput("recycle", "Also move the source file to the Windows Recycle Bin", false);
          if (this.context.nativeRecycleAvailable === false) {
            const input = recycleChoice.querySelector("input");
            if (input) input.disabled = true;
            const reason = cleanText(this.context.recycleUnavailableReason, 500) || "The verified native Windows Recycle Bin service is unavailable.";
            recycleChoice.title = `${reason} Archive remains safe and available.`;
            recycleChoice.append(element("small", "replay-lifecycle-blocker", `${reason} No source file will be removed.`));
          }
          body.append(
            element("p", "replay-lifecycle-warning", "The default action only archives the Blocky Studios library record. It does not remove media, sidecars, folders, or Premiere ProjectItems."),
            replayList(this.context.replays, { maximum: 256 }),
            recycleChoice,
          );
          this.syncDeleteAction();
        }
      } else if (this.mode === "relink") {
        this.setChrome({ title: this.context.replays.length > 1 ? `Relink ${this.context.replays.length} missing replays` : "Relink source", apply: "Relink", danger: false });
        body.append(replayList(this.context.replays));
        const chooseLabel = this.context.replays.length > 1 ? "Choose matching files…" : "Choose replacement file…";
        body.append(button(chooseLabel, "choose-relink", "primary"));
        const result = element("div", "replay-relink-result");
        result.dataset.relinkResult = "true";
        body.append(result);
        this.renderRelinkResult();
      } else if (this.mode === "collection-manager") {
        this.setChrome({ kicker: "Replay organization", title: "Manage collections", apply: "Done" });
        this.renderCollectionManager();
      } else {
        this.setChrome({ title: "Replay action", apply: "Apply" });
        body.append(element("p", "replay-lifecycle-blocker", "This replay action is unavailable."));
        this.elements.replayLifecycleApply.disabled = true;
      }
    }

    renderRelinkResult() {
      const result = this.elements.replayLifecycleBody.querySelector("[data-relink-result]");
      if (!result) return;
      replaceElementChildren(result);
      const selection = this.context.relinkSelection;
      if (!selection) {
        result.append(element("p", "replay-lifecycle-empty", "No replacement selected."));
        this.elements.replayLifecycleApply.disabled = true;
        return;
      }
      const assignments = Array.isArray(selection.assignments) ? selection.assignments : [];
      result.append(element("strong", "", `${assignments.length} of ${this.context.replays.length} replay${this.context.replays.length === 1 ? "" : "s"} matched`));
      const replayById = new Map(this.context.replays.map((replay) => [String(replay.id || ""), replay]));
      const explicitlyAmbiguous = assignments.filter((assignment) => assignment && assignment.ambiguous === true);
      const needsConfirmation = relinkSelectionNeedsConfirmation(selection);
      const ambiguousAssignments = explicitlyAmbiguous.length
        ? explicitlyAmbiguous
        : needsConfirmation ? assignments : [];
      let auditComplete = true;
      for (const assignment of assignments) {
        const replay = replayById.get(String(assignment && assignment.replayId || ""));
        const sourceName = cleanText(replay && (replay.title || replay.displayNameOverride || replay.sourceName) || assignment.replayId, 240);
        const sourcePath = cleanText(replay && (replay.filepath || replay.canonicalPath), 32767);
        const candidatePath = cleanText(assignment && (assignment.newPath || assignment.candidate && assignment.candidate.canonicalPath), 32767);
        const rawScore = assignment && assignment.score;
        const numericScore = Number(rawScore);
        const hasNumericScore = rawScore !== undefined && rawScore !== null && String(rawScore).trim() !== "" && Number.isFinite(numericScore);
        const reason = relinkAmbiguityReason(assignment);
        const card = element("article", "replay-operation-result");
        card.dataset.relinkAssignment = String(assignment && assignment.replayId || "");
        card.append(
          element("strong", "", sourceName || "Unknown replay"),
          element("span", "", hasNumericScore ? `Score ${numericScore}` : "Score unavailable"),
          element("code", "", sourcePath),
          element("small", "", "Candidate path"),
          element("code", "", candidatePath),
        );
        const evidence = Array.isArray(assignment && assignment.reasons)
          ? assignment.reasons.map((value) => cleanText(value, 80).replace(/-/g, " ")).filter(Boolean)
          : [];
        if (evidence.length) card.append(element("small", "", `Matching evidence: ${evidence.join(", ")}`));
        const requiresAssignmentReview = Boolean(assignment && assignment.ambiguous === true) || (needsConfirmation && explicitlyAmbiguous.length === 0);
        if (requiresAssignmentReview) {
          card.append(element("p", "replay-lifecycle-warning", reason || "Ambiguity reason was not supplied; this relink cannot be confirmed safely."));
          if (!hasNumericScore || !reason || !candidatePath || !sourceName) auditComplete = false;
        }
        result.append(card);
      }
      if (needsConfirmation) {
        if (!ambiguousAssignments.length || !auditComplete) {
          result.append(element("p", "replay-lifecycle-blocker", "Blocky Studios cannot apply this ambiguous relink until every affected replay includes its source, candidate path, numeric score, and ambiguity reason."));
        } else {
          result.append(element("p", "replay-lifecycle-warning", "One or more matches require manual confirmation. Review every source-to-candidate assignment, score, and reason before applying."));
          result.append(checkInput("confirmAmbiguous", "I verified every ambiguous source, candidate path, score, and reason", false));
        }
      }
      this.context.relinkAuditComplete = auditComplete && (!needsConfirmation || ambiguousAssignments.length > 0);
      this.syncRelinkAction();
    }

    syncRelinkAction() {
      if (this.mode !== "relink") return;
      const selection = this.context && this.context.relinkSelection;
      const assignments = selection && Array.isArray(selection.assignments) ? selection.assignments : [];
      const complete = assignments.length === this.context.replays.length;
      const confirmed = !relinkSelectionNeedsConfirmation(selection) || checkedOf(this.elements.replayLifecycleBody, "confirmAmbiguous");
      this.elements.replayLifecycleApply.disabled = !complete || this.context.relinkAuditComplete !== true || !confirmed;
    }

    renderCollectionManager() {
      const body = this.elements.replayLifecycleBody;
      const create = element("section", "replay-collection-create");
      create.append(
        field("Collection name", textInput("newCollectionName", "", { maxLength: 120, placeholder: "Selects" })),
        field("Color", textInput("newCollectionColor", "#D948D7", { type: "color" })),
        element("h3", "replay-lifecycle-subtitle", "Optional smart rules"),
        field("Name contains", textInput("newRuleName", "", { maxLength: 240 })),
        field("Path root", textInput("newRuleRoot", "", { maxLength: 32767 })),
        field("Tag", textInput("newRuleTag", "", { maxLength: 80 })),
        field("From date", textInput("newRuleDateFrom", "", { type: "date" })),
        field("To date", textInput("newRuleDateTo", "", { type: "date" })),
        field("Minimum duration (seconds)", textInput("newRuleDurationMin", "", { type: "number", min: 0, step: 0.01 })),
        field("Maximum duration (seconds)", textInput("newRuleDurationMax", "", { type: "number", min: 0, step: 0.01 })),
        checkInput("newRuleFavorite", "Favorites only", false),
        checkInput("newRuleMissing", "Missing media only", false),
        button("Create collection", "collection-create", "primary"),
      );
      const list = element("div", "replay-collection-manager-list");
      list.dataset.collectionManagerList = "true";
      const collections = Array.isArray(this.context.collections) ? this.context.collections : [];
      if (!collections.length) list.append(element("p", "replay-lifecycle-empty", "No collections yet."));
      collections.forEach((collection, index) => {
        const row = element("article", "replay-collection-manager-row");
        row.dataset.collectionId = collection.id;
        const smartRules = collection.smartRules && Array.isArray(collection.smartRules.rules) && collection.smartRules.rules.length
          ? collection.smartRules
          : null;
        const identity = element("div", "replay-collection-manager-row__identity");
        identity.append(
          textInput("collectionName", collection.name, { maxLength: 120 }),
          textInput("collectionColor", collection.color || "#D948D7", { type: "color" }),
        );
        const smartRuleCount = smartRules ? smartRules.rules.length : 0;
        const summary = smartRules
          ? `Smart collection · Match ${smartRules.match === "any" ? "any" : "all"} · ${smartRuleCount} rule${smartRuleCount === 1 ? "" : "s"}`
          : `${Array.isArray(collection.manualOrder) ? collection.manualOrder.length : 0} manually ordered replay${collection.manualOrder && collection.manualOrder.length === 1 ? "" : "s"}`;
        identity.append(element("small", "", summary));
        if (smartRules) {
          for (const [ruleIndex, rule] of smartRules.rules.entries()) {
            const detail = element("small", "", `Rule ${ruleIndex + 1}: ${smartRuleSummary(rule)}`);
            detail.dataset.smartRuleSummary = String(ruleIndex);
            identity.append(detail);
          }
        }
        const actions = element("div", "replay-collection-manager-row__actions");
        const reorder = button("⠿", "");
        delete reorder.dataset.lifecycleCommand;
        reorder.classList.add("replay-collection-reorder-handle");
        reorder.dataset.collectionReorderHandle = "true";
        reorder.setAttribute("aria-label", `Reorder ${collection.name}`);
        reorder.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown Home End");
        reorder.title = "Drag or use Arrow keys, Home, and End to reorder this collection";
        const up = button("↑", "collection-up");
        up.disabled = index === 0;
        up.title = "Move collection up";
        const down = button("↓", "collection-down");
        down.disabled = index === collections.length - 1;
        down.title = "Move collection down";
        actions.append(
          reorder,
          button("Save", "collection-save"),
          ...(smartRules ? [button("Edit rules", "smart-rules-toggle")] : []),
          up,
          down,
          button("Duplicate", "collection-duplicate"),
          button("Delete", "collection-delete", "danger"),
        );
        row.append(identity, actions);
        if (smartRules) {
          const editor = element("section", "replay-collection-create");
          editor.dataset.smartRulesEditor = "true";
          editor.hidden = true;
          editor.style.setProperty("grid-column", "1 / -1");
          editor.append(
            element("h3", "replay-lifecycle-subtitle", "Smart collection rules"),
            field("Match", selectInput("smartRuleMatch", [["all", "All rules"], ["any", "Any rule"]], smartRules.match || "all")),
          );
          const ruleList = element("div", "replay-collection-manager-list");
          ruleList.dataset.smartRuleList = "true";
          for (const rule of smartRules.rules) ruleList.append(createSmartRuleEditorRow(rule));
          editor.append(ruleList, button("Add rule", "smart-rule-add"));
          row.append(editor);
          syncSmartRuleRemoveButtons(editor);
        }
        list.appendChild(row);
      });
      body.append(create, list);
    }

    announce(message) {
      try { this.onAnnounce(cleanText(message, 1024)); } catch (error) { /* Callback isolation. */ }
    }

    collectionOrder() {
      return (Array.isArray(this.context && this.context.collections) ? this.context.collections : [])
        .map((collection) => cleanText(collection && collection.id, 160))
        .filter(Boolean);
    }

    focusCollectionReorderHandle(collectionId) {
      const rows = Array.from(this.elements.replayLifecycleBody.querySelectorAll("[data-collection-id]"));
      const row = rows.find((entry) => entry.dataset.collectionId === collectionId);
      const handle = row && row.querySelector("[data-collection-reorder-handle]");
      if (handle && typeof handle.focus === "function") handle.focus();
      return Boolean(handle);
    }

    commitCollectionReorder(order, collectionId) {
      if (this.busy || this.mode !== "collection-manager" || !this.context) return Promise.resolve(false);
      const activeContext = this.context;
      const collection = (activeContext.collections || []).find((entry) => entry.id === collectionId);
      const name = cleanText(collection && collection.name, 120) || "Collection";
      const position = order.indexOf(collectionId) + 1;
      this.busy = true;
      let operation;
      try {
        operation = this.onCollectionCommand("collection-reorder", { order }, activeContext);
      } catch (error) {
        operation = Promise.reject(error);
      }
      return Promise.resolve(operation)
        .then((collections) => {
          if (!this.started || this.mode !== "collection-manager" || this.context !== activeContext) return false;
          if (Array.isArray(collections)) activeContext.collections = collections;
          this.setError("");
          this.render();
          this.focusCollectionReorderHandle(collectionId);
          this.announce(`${name} moved to position ${position} of ${order.length}.`);
          return true;
        })
        .catch((error) => {
          if (this.started && this.mode === "collection-manager" && this.context === activeContext) {
            this.setError(error && error.message ? error.message : error);
            this.render();
            this.focusCollectionReorderHandle(collectionId);
            this.announce(`${name} order was unchanged.`);
          }
          return false;
        })
        .finally(() => { this.busy = false; });
    }

    handleCollectionReorderKeyDown(event) {
      const handle = event && event.target && event.target.closest
        ? event.target.closest("[data-collection-reorder-handle]")
        : null;
      if (!handle || this.mode !== "collection-manager" || this.busy) return false;
      const row = handle.closest("[data-collection-id]");
      const collectionId = cleanText(row && row.dataset.collectionId, 160);
      const order = this.collectionOrder();
      const current = order.indexOf(collectionId);
      if (current < 0) return false;
      if (["Enter", " ", "Spacebar"].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const collection = (this.context.collections || []).find((entry) => entry.id === collectionId);
        this.announce(`${cleanText(collection && collection.name, 120) || "Collection"}, position ${current + 1} of ${order.length}. Use Arrow keys, Home, or End to reorder.`);
        return true;
      }
      let target = null;
      if (event.key === "ArrowUp" || event.key === "ArrowLeft") target = current - 1;
      else if (event.key === "ArrowDown" || event.key === "ArrowRight") target = current + 1;
      else if (event.key === "Home") target = 0;
      else if (event.key === "End") target = order.length - 1;
      if (target === null) return false;
      event.preventDefault();
      event.stopPropagation();
      if (target < 0 || target >= order.length || target === current) {
        const boundary = target <= 0 ? "first" : "last";
        this.announce(`This collection is already ${boundary}.`);
        return true;
      }
      const nextOrder = order.filter((id) => id !== collectionId);
      nextOrder.splice(target, 0, collectionId);
      void this.commitCollectionReorder(nextOrder, collectionId);
      return true;
    }

    beginCollectionReorder(event) {
      const handle = event && event.target && event.target.closest
        ? event.target.closest("[data-collection-reorder-handle]")
        : null;
      if (!handle || this.mode !== "collection-manager" || this.busy || event.button !== 0 || event.isPrimary === false) return false;
      const row = handle.closest("[data-collection-id]");
      if (!row) return false;
      event.preventDefault();
      event.stopPropagation();
      this.collectionDrag = {
        pointerId: event.pointerId,
        handle,
        row,
        collectionId: String(row.dataset.collectionId || ""),
        targetId: String(row.dataset.collectionId || ""),
        placement: "before",
      };
      row.classList.add("is-collection-reorder-source");
      if (typeof handle.setPointerCapture === "function") {
        try { handle.setPointerCapture(event.pointerId); } catch (error) { /* UXP may omit capture. */ }
      }
      return true;
    }

    updateCollectionReorder(event) {
      const state = this.collectionDrag;
      if (!state || !event || event.pointerId !== state.pointerId) return false;
      event.preventDefault();
      event.stopPropagation();
      state.targetId = state.collectionId;
      const rows = Array.from(this.elements.replayLifecycleBody.querySelectorAll("[data-collection-id]"));
      rows.forEach((row) => row.classList.remove("is-collection-reorder-target"));
      const hit = this.document && typeof this.document.elementFromPoint === "function"
        ? this.document.elementFromPoint(Number(event.clientX) || 0, Number(event.clientY) || 0)
        : event.target;
      const row = hit && hit.closest ? hit.closest("[data-collection-id]") : null;
      if (row && row !== state.row) {
        const rect = row.getBoundingClientRect ? row.getBoundingClientRect() : { top: 0, height: 1 };
        state.targetId = String(row.dataset.collectionId || "");
        state.placement = Number(event.clientY) >= Number(rect.top) + Number(rect.height || 1) / 2 ? "after" : "before";
        row.classList.add("is-collection-reorder-target");
      }
      return true;
    }

    finishCollectionReorder(event, cancelled) {
      const state = this.collectionDrag;
      if (!state || (event && event.pointerId !== undefined && event.pointerId !== state.pointerId)) return false;
      this.collectionDrag = null;
      state.row.classList.remove("is-collection-reorder-source");
      for (const row of this.elements.replayLifecycleBody.querySelectorAll("[data-collection-id]")) {
        row.classList.remove("is-collection-reorder-target");
      }
      if (typeof state.handle.releasePointerCapture === "function") {
        try { state.handle.releasePointerCapture(state.pointerId); } catch (error) { /* Capture may already be gone. */ }
      }
      if (!cancelled && state.targetId && state.targetId !== state.collectionId) {
        const order = (Array.isArray(this.context.collections) ? this.context.collections : []).map((collection) => collection.id);
        const without = order.filter((id) => id !== state.collectionId);
        let index = without.indexOf(state.targetId);
        if (index >= 0) {
          if (state.placement === "after") index += 1;
          without.splice(index, 0, state.collectionId);
          void this.commitCollectionReorder(without, state.collectionId);
        }
      }
      return true;
    }

    serialize() {
      const body = this.elements.replayLifecycleBody;
      if (this.mode === "rename-display") return { displayName: cleanText(valueOf(body, "displayName"), 240) };
      if (this.mode === "rename-source") {
        const first = this.context.replays[0];
        const validated = validateSourceStem(valueOf(body, "sourceStem"), first && first.filepath);
        if (!validated.ok) throw new Error(validated.message);
        return validated;
      }
      if (this.mode === "tags") {
        return { tags: parseTags(valueOf(body, "tags")), batchMode: valueOf(body, "batchMode") || "replace" };
      }
      if (this.mode === "rating-notes") {
        const rating = Number(valueOf(body, "rating"));
        if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw new Error("Rating must be a whole number from 0 to 5.");
        return { rating, notes: cleanText(valueOf(body, "notes"), 16000) };
      }
      if (this.mode === "collections") {
        const collectionIds = Array.from(body.querySelectorAll("[data-collection-id]"))
          .filter((label) => {
            const input = label.querySelector("input");
            return Boolean(input && !input.disabled && input.checked);
          })
          .map((label) => String(label.dataset.collectionId));
        return { collectionIds, batchMode: valueOf(body, "batchMode") || "replace" };
      }
      if (this.mode === "archive-restore") {
        const confirmation = this.context.lifecycleConfirmation || {};
        return { confirmed: !confirmation.requiresExplicitConfirmation || checkedOf(body, "confirmLifecycle") };
      }
      if (this.mode === "delete") {
        if (this.context.operationResult) return { done: true };
        return { recycle: checkedOf(body, "recycle") };
      }
      if (this.mode === "relink") {
        if (!this.context.relinkSelection) throw new Error("Choose replacement media first.");
        if (this.context.relinkAuditComplete !== true) {
          throw new Error("Ambiguous relink details are incomplete. Choose the replacement media again before applying.");
        }
        if (relinkSelectionNeedsConfirmation(this.context.relinkSelection) && !checkedOf(body, "confirmAmbiguous")) {
          throw new Error("Verify every ambiguous match before relinking.");
        }
        return this.context.relinkSelection;
      }
      return {};
    }

    async apply() {
      if (!this.isOpen() || this.busy) return;
      if (this.mode === "collection-manager") {
        this.close(true);
        return;
      }
      let payload;
      try {
        payload = this.serialize();
      } catch (error) {
        this.setError(error && error.message ? error.message : error);
        return;
      }
      if (this.mode === "delete" && payload.done) {
        this.close(true);
        return;
      }
      this.busy = true;
      this.elements.replayLifecycleDialog.setAttribute("aria-busy", "true");
      this.elements.replayLifecycleApply.disabled = true;
      const cancelableFileOperation = this.mode === "delete" && payload.recycle === true;
      this.elements.replayLifecycleCancel.disabled = !cancelableFileOperation;
      this.elements.replayLifecycleCancel.textContent = cancelableFileOperation ? "Cancel operation" : "Working…";
      this.setError("");
      try {
        const outcome = await this.onApply(this.mode, payload, this.context);
        this.busy = false;
        this.elements.replayLifecycleDialog.setAttribute("aria-busy", "false");
        this.elements.replayLifecycleCancel.disabled = false;
        this.elements.replayLifecycleCancel.textContent = "Cancel";
        if (outcome && outcome.operationResult) {
          this.context.operationResult = outcome.operationResult;
          this.render();
          return;
        }
        this.close(true);
      } catch (error) {
        this.busy = false;
        this.elements.replayLifecycleDialog.setAttribute("aria-busy", "false");
        this.elements.replayLifecycleApply.disabled = false;
        this.elements.replayLifecycleCancel.disabled = false;
        this.elements.replayLifecycleCancel.textContent = "Cancel";
        this.setError(error && error.message ? error.message : error);
      }
    }

    async handleSecondary() {
      if (!this.isOpen() || this.busy) return;
      if (this.mode === "collections") {
        this.mode = "collection-manager";
        this.render();
        return;
      }
      if (this.mode === "delete" && this.context.allMissing) {
        this.busy = true;
        this.elements.replayLifecycleDialog.setAttribute("aria-busy", "true");
        try {
          await this.onApply("remove-metadata", {}, this.context);
          this.busy = false;
          this.elements.replayLifecycleDialog.setAttribute("aria-busy", "false");
          this.close(true);
        } catch (error) {
          this.busy = false;
          this.elements.replayLifecycleDialog.setAttribute("aria-busy", "false");
          this.setError(error && error.message ? error.message : error);
        }
      }
    }

    async handleBodyCommand(event) {
      const target = event && event.target && event.target.closest
        ? event.target.closest("[data-lifecycle-command]")
        : null;
      if (!target || target.disabled || this.busy) return;
      event.preventDefault();
      const command = String(target.dataset.lifecycleCommand || "");
      if (command === "choose-relink") {
        this.busy = true;
        try {
          const selection = await this.onChooseRelink(this.context);
          if (selection) this.context.relinkSelection = selection;
          this.renderRelinkResult();
        } catch (error) {
          this.setError(error && error.message ? error.message : error);
        } finally {
          this.busy = false;
        }
        return;
      }
      if (command === "smart-rules-toggle") {
        const collectionRow = target.closest("[data-collection-id]");
        const editor = collectionRow && collectionRow.querySelector("[data-smart-rules-editor]");
        if (!editor) return;
        editor.hidden = !editor.hidden;
        target.textContent = editor.hidden ? "Edit rules" : "Hide rules";
        return;
      }
      if (command === "smart-rule-add") {
        const editor = target.closest("[data-smart-rules-editor]");
        const list = editor && editor.querySelector("[data-smart-rule-list]");
        if (!editor || !list) return;
        if (list.querySelectorAll("[data-smart-rule-row]").length >= 32) {
          this.setError("Smart collections support at most 32 rules.");
          return;
        }
        list.append(createSmartRuleEditorRow());
        syncSmartRuleRemoveButtons(editor);
        this.setError("");
        return;
      }
      if (command === "smart-rule-remove") {
        const ruleRow = target.closest("[data-smart-rule-row]");
        const editor = target.closest("[data-smart-rules-editor]");
        const list = editor && editor.querySelector("[data-smart-rule-list]");
        if (!ruleRow || !editor || !list) return;
        const remaining = Array.from(list.querySelectorAll("[data-smart-rule-row]")).filter((row) => row !== ruleRow);
        if (!remaining.length) {
          this.setError("A smart collection requires at least one rule.");
          return;
        }
        replaceElementChildren(list, remaining);
        syncSmartRuleRemoveButtons(editor);
        this.setError("");
        return;
      }
      if (!command.startsWith("collection-")) return;
      const row = target.closest("[data-collection-id]");
      let draft;
      try {
        draft = command === "collection-create"
          ? normalizeCollectionDraft({
            name: valueOf(this.elements.replayLifecycleBody, "newCollectionName"),
            color: valueOf(this.elements.replayLifecycleBody, "newCollectionColor"),
            ruleName: valueOf(this.elements.replayLifecycleBody, "newRuleName"),
            root: valueOf(this.elements.replayLifecycleBody, "newRuleRoot"),
            tag: valueOf(this.elements.replayLifecycleBody, "newRuleTag"),
            dateFrom: valueOf(this.elements.replayLifecycleBody, "newRuleDateFrom"),
            dateTo: valueOf(this.elements.replayLifecycleBody, "newRuleDateTo"),
            minimumDurationSeconds: valueOf(this.elements.replayLifecycleBody, "newRuleDurationMin"),
            maximumDurationSeconds: valueOf(this.elements.replayLifecycleBody, "newRuleDurationMax"),
            favorite: checkedOf(this.elements.replayLifecycleBody, "newRuleFavorite"),
            missing: checkedOf(this.elements.replayLifecycleBody, "newRuleMissing"),
          })
          : {
            name: cleanText(valueOf(row, "collectionName"), 120),
            color: valueOf(row, "collectionColor"),
          };
        const smartEditor = row && row.querySelector("[data-smart-rules-editor]");
        if (smartEditor) draft.smartRules = serializeSmartRulesEditor(smartEditor);
      } catch (error) {
        this.setError(error && error.message ? error.message : error);
        return;
      }
      if (command === "collection-create" && !draft.name) {
        this.setError("Enter a collection name.");
        return;
      }
      this.busy = true;
      try {
        const collections = await this.onCollectionCommand(command, {
          id: row && row.dataset.collectionId,
          draft,
        }, this.context);
        if (Array.isArray(collections)) this.context.collections = collections;
        this.setError("");
        this.render();
      } catch (error) {
        this.setError(error && error.message ? error.message : error);
      } finally {
        this.busy = false;
      }
    }

    destroy() {
      if (!this.started) return;
      this.busy = false;
      if (this.collectionDrag) this.finishCollectionReorder(null, true);
      this.close(false);
      this.started = false;
      this.elements.replayLifecycleClose.removeEventListener("click", this.onClose);
      this.elements.replayLifecycleCancel.removeEventListener("click", this.onCancel);
      this.elements.replayLifecycleBackdrop.removeEventListener("click", this.onBackdrop);
      this.elements.replayLifecycleBody.removeEventListener("click", this.onBodyClick);
      this.elements.replayLifecycleBody.removeEventListener("keydown", this.onBodyKeyDown);
      this.elements.replayLifecycleBody.removeEventListener("change", this.onBodyChange);
      this.elements.replayLifecycleBody.removeEventListener("pointerdown", this.onBodyPointerDown);
      this.elements.replayLifecycleBody.removeEventListener("pointermove", this.onBodyPointerMove);
      this.elements.replayLifecycleBody.removeEventListener("pointerup", this.onBodyPointerUp);
      this.elements.replayLifecycleBody.removeEventListener("pointercancel", this.onBodyPointerCancel);
      this.elements.replayLifecycleApply.removeEventListener("click", this.onApplyClick);
      this.elements.replayLifecycleSecondary.removeEventListener("click", this.onSecondaryClick);
      if (this.document) this.document.removeEventListener("keydown", this.onKeyDown, true);
    }
  }

  return {
    ReplayLifecycleDialogController,
    cleanText,
    focusableElements,
    normalizeCollectionDraft,
    parseTags,
    sourceNameParts,
    trapTab,
    validateSourceStem,
  };
});
