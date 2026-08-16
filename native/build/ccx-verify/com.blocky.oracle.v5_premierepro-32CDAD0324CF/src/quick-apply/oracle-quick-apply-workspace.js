"use strict";

(function exposeOracleQuickApplyWorkspace(globalScope, factory) {
  const api = factory(
    typeof module === "object" && module && module.exports
      ? require("./oracle-quick-apply-domain.js")
      : globalScope && Reflect.get(globalScope, "OracleQuickApplyDomain"),
  );
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OracleQuickApplyWorkspace", api);
})(typeof window !== "undefined" ? window : null, function createOracleQuickApplyWorkspaceApi(defaultDomainApi) {
  const DOM_IDS = Object.freeze({
    root: "quickApplyWorkspace",
    state: "quickApplyState",
    stateTitle: "quickApplyStateTitle",
    stateMessage: "quickApplyStateMessage",
    refresh: "quickApplyRefresh",
    content: "quickApplyContent",
    search: "quickApplySearch",
    searchClear: "quickApplySearchClear",
    selectionSummary: "quickApplySelectionSummary",
    resultsSummary: "quickApplyResultsSummary",
    results: "quickApplyResults",
    empty: "quickApplyEmpty",
    apply: "quickApplyApply",
    favorite: "quickApplyFavorite",
    status: "quickApplyStatus",
    recipeCreate: "quickApplyRecipeCreate",
    recipeAddEffect: "quickApplyRecipeAddEffect",
    recipeRename: "quickApplyRecipeRename",
    recipeDuplicate: "quickApplyRecipeDuplicate",
    recipeMoveUp: "quickApplyRecipeMoveUp",
    recipeMoveDown: "quickApplyRecipeMoveDown",
    recipeDelete: "quickApplyRecipeDelete",
    recipeImport: "quickApplyRecipeImport",
    recipeExport: "quickApplyRecipeExport",
    recipeBackdrop: "quickApplyRecipeBackdrop",
    recipeEditor: "quickApplyRecipeEditor",
    recipeEditorTitle: "quickApplyRecipeEditorTitle",
    recipeName: "quickApplyRecipeName",
    recipeApplyOnce: "quickApplyRecipeApplyOnce",
    recipeStageLabel: "quickApplyRecipeStageLabel",
    recipeStageEffects: "quickApplyRecipeStageEffects",
    recipeStageParameters: "quickApplyRecipeStageParameters",
    recipeStack: "quickApplyRecipeStack",
    recipeCatalogSearch: "quickApplyRecipeCatalogSearch",
    recipeCatalog: "quickApplyRecipeCatalog",
    recipeParameterList: "quickApplyRecipeParameterList",
    recipeEditorStatus: "quickApplyRecipeEditorStatus",
    recipeBack: "quickApplyRecipeBack",
    recipeNext: "quickApplyRecipeNext",
    recipeSave: "quickApplyRecipeSave",
    recipeCancel: "quickApplyRecipeCancel",
  });
  const ELEMENT_ALIASES = Object.freeze({
    root: ["root", "quickApplyWorkspace"],
    state: ["state", "quickApplyState"],
    stateTitle: ["stateTitle", "quickApplyStateTitle"],
    stateMessage: ["stateMessage", "quickApplyStateMessage"],
    refresh: ["refresh", "quickApplyRefresh"],
    content: ["content", "quickApplyContent"],
    search: ["search", "quickApplySearch"],
    searchClear: ["searchClear", "quickApplySearchClear"],
    selectionSummary: ["selectionSummary", "quickApplySelectionSummary"],
    resultsSummary: ["resultsSummary", "quickApplyResultsSummary"],
    results: ["results", "quickApplyResults"],
    empty: ["empty", "quickApplyEmpty"],
    apply: ["apply", "quickApplyApply"],
    favorite: ["favorite", "quickApplyFavorite"],
    status: ["status", "quickApplyStatus"],
    recipeCreate: ["recipeCreate", "quickApplyRecipeCreate"],
    recipeAddEffect: ["recipeAddEffect", "quickApplyRecipeAddEffect"],
    recipeRename: ["recipeRename", "quickApplyRecipeRename"],
    recipeDuplicate: ["recipeDuplicate", "quickApplyRecipeDuplicate"],
    recipeMoveUp: ["recipeMoveUp", "quickApplyRecipeMoveUp"],
    recipeMoveDown: ["recipeMoveDown", "quickApplyRecipeMoveDown"],
    recipeDelete: ["recipeDelete", "quickApplyRecipeDelete"],
    recipeImport: ["recipeImport", "quickApplyRecipeImport"],
    recipeExport: ["recipeExport", "quickApplyRecipeExport"],
    recipeBackdrop: ["recipeBackdrop", "quickApplyRecipeBackdrop"],
    recipeEditor: ["recipeEditor", "quickApplyRecipeEditor"],
    recipeEditorTitle: ["recipeEditorTitle", "quickApplyRecipeEditorTitle"],
    recipeName: ["recipeName", "quickApplyRecipeName"],
    recipeApplyOnce: ["recipeApplyOnce", "quickApplyRecipeApplyOnce"],
    recipeStageLabel: ["recipeStageLabel", "quickApplyRecipeStageLabel"],
    recipeStageEffects: ["recipeStageEffects", "quickApplyRecipeStageEffects"],
    recipeStageParameters: ["recipeStageParameters", "quickApplyRecipeStageParameters"],
    recipeStack: ["recipeStack", "quickApplyRecipeStack"],
    recipeCatalogSearch: ["recipeCatalogSearch", "quickApplyRecipeCatalogSearch"],
    recipeCatalog: ["recipeCatalog", "quickApplyRecipeCatalog"],
    recipeParameterList: ["recipeParameterList", "quickApplyRecipeParameterList"],
    recipeEditorStatus: ["recipeEditorStatus", "quickApplyRecipeEditorStatus"],
    recipeBack: ["recipeBack", "quickApplyRecipeBack"],
    recipeNext: ["recipeNext", "quickApplyRecipeNext"],
    recipeSave: ["recipeSave", "quickApplyRecipeSave"],
    recipeCancel: ["recipeCancel", "quickApplyRecipeCancel"],
  });
  const STATE_TITLES = Object.freeze({
    loading: "Indexing Premiere effects",
    empty: "No supported effects yet",
    error: "Quick Apply needs attention",
    unsupported: "Selection is not compatible",
    ready: "Quick Apply ready",
  });

  function cleanText(value, maximum = 1024) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, maximum);
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function normalizeElements(value = {}) {
    const output = {};
    for (const [name, aliases] of Object.entries(ELEMENT_ALIASES)) {
      output[name] = null;
      for (const alias of aliases) {
        if (value[alias]) {
          output[name] = value[alias];
          break;
        }
      }
    }
    return output;
  }

  function clearElement(element) {
    if (!element) return;
    element.innerHTML = "";
  }

  function appendTextElement(documentRef, parent, tagName, className, text) {
    const element = documentRef.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  }

  function setDisabled(control, disabled, reason = "") {
    if (!control) return;
    control.disabled = Boolean(disabled);
    control.setAttribute("aria-disabled", disabled ? "true" : "false");
    control.title = disabled ? cleanText(reason, 1024) : "";
  }

  function closest(event, selector) {
    return event && event.target && typeof event.target.closest === "function"
      ? event.target.closest(selector)
      : null;
  }

  function formatMediaType(target) {
    if (!target) return "Effect";
    if (target.kind === "recipe") return target.mediaType === "mixed" ? "Video + Audio Recipe" : `${target.mediaType === "audio" ? "Audio" : "Video"} Recipe`;
    return target.mediaType === "audio" ? "Audio" : "Video";
  }

  function option(documentRef, value, label) {
    const element = documentRef.createElement("option");
    element.value = value;
    element.textContent = label;
    return element;
  }

  function readParameterValue(control, valueType) {
    if (!control) return null;
    if (control.dataset && control.dataset.recipeParameterOptions === "true") {
      try { return JSON.parse(String(control.value)); } catch (error) { return null; }
    }
    if (valueType === "boolean") return Boolean(control.checked);
    if (["number", "float", "integer"].includes(valueType)) {
      const number = Number(control.value);
      return Number.isFinite(number) ? number : null;
    }
    return cleanText(control.value, 16384);
  }

  class QuickApplyWorkspaceController {
    constructor(elements, options = {}) {
      this.elements = normalizeElements(elements);
      this.document = options.document || (typeof document !== "undefined" ? document : null);
      if (!this.document) throw new TypeError("QuickApplyWorkspaceController requires a document.");
      if (options.domain) {
        this.domain = options.domain;
        this.ownsDomain = options.ownsDomain === true;
      } else {
        const Domain = options.domainApi && options.domainApi.QuickApplyDomain || defaultDomainApi && defaultDomainApi.QuickApplyDomain;
        if (typeof Domain !== "function") throw new TypeError("Quick Apply domain module is unavailable.");
        this.domain = new Domain({
          adapter: options.adapter,
          stateStore: options.stateStore,
          recipeStore: options.recipeStore,
          preferences: options.preferences,
          ownsAdapter: options.ownsAdapter,
          now: options.now,
          idFactory: options.idFactory,
        });
        this.ownsDomain = true;
      }
      this.onToast = typeof options.onToast === "function" ? options.onToast : () => undefined;
      this.onAnnounce = typeof options.onAnnounce === "function" ? options.onAnnounce : () => undefined;
      this.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : () => undefined;
      this.onRequestCloseTopLayer = typeof options.onRequestCloseTopLayer === "function" ? options.onRequestCloseTopLayer : () => undefined;
      this.requestRecipeName = typeof options.requestRecipeName === "function" ? options.requestRecipeName : null;
      this.confirmRecipeAction = typeof options.confirmRecipeAction === "function" ? options.confirmRecipeAction : null;
      this.importRecipeFile = typeof options.importRecipeFile === "function" ? options.importRecipeFile : null;
      this.exportRecipeFile = typeof options.exportRecipeFile === "function" ? options.exportRecipeFile : null;
      this.visible = options.visible === true;
      this.active = options.active === true;
      this.started = false;
      this.destroyed = false;
      this.snapshot = null;
      this.unsubscribe = null;
      this.focusGeneration = 0;
      this.recipeOpen = false;
      this.recipeStage = 1;
      this.recipeDraft = null;
      this.recipeRestoreFocus = null;
      this.recipeParameterDescriptors = new Map();
      this.recipeParameterValues = new Map();
      this.scopeFocusValue = "";
      this.handleClick = (event) => { void this.onClick(event); };
      this.handleInput = (event) => this.onInput(event);
      this.handleChange = (event) => this.onChange(event);
      this.handleKeyDown = (event) => { void this.onKeyDown(event); };
      this.handleDocumentKeyDown = (event) => { void this.onDocumentKeyDown(event); };
    }

    start() {
      if (this.started || this.destroyed) return this;
      this.started = true;
      const root = this.elements.root;
      if (!root) throw new TypeError("Quick Apply workspace root is required.");
      root.addEventListener("click", this.handleClick);
      root.addEventListener("input", this.handleInput);
      root.addEventListener("change", this.handleChange);
      root.addEventListener("keydown", this.handleKeyDown);
      this.document.addEventListener("keydown", this.handleDocumentKeyDown, true);
      if (typeof this.domain.start === "function") this.domain.start();
      this.unsubscribe = this.domain.subscribe((snapshot) => this.render(snapshot));
      this.domain.setVisible(this.visible);
      this.domain.setActive(this.active);
      this.scheduleSearchFocus();
      return this;
    }

    setVisible(value) {
      this.visible = Boolean(value);
      if (this.elements.root) this.elements.root.hidden = !this.visible;
      this.domain.setVisible(this.visible);
      if (!this.visible && this.recipeOpen) this.closeRecipeEditor(false);
      this.scheduleSearchFocus();
    }

    setActive(value) {
      this.active = Boolean(value);
      this.domain.setActive(this.active);
      this.scheduleSearchFocus();
    }

    setPreferences(value) {
      if (typeof this.domain.setPreferences === "function") this.domain.setPreferences(value || {});
    }

    scheduleSearchFocus() {
      const generation = ++this.focusGeneration;
      if (!this.started || !this.visible || !this.active || this.recipeOpen) return;
      Promise.resolve().then(() => {
        if (this.destroyed || generation !== this.focusGeneration || !this.visible || !this.active || this.recipeOpen) return;
        if (this.elements.search && typeof this.elements.search.focus === "function") this.elements.search.focus();
      });
    }

    render(snapshot) {
      if (this.destroyed) return;
      this.snapshot = snapshot;
      const state = cleanText(snapshot && snapshot.state, 32) || "loading";
      if (this.elements.root) this.elements.root.dataset.quickApplyState = state;
      if (this.elements.state) {
        this.elements.state.hidden = false;
        this.elements.state.dataset.state = state;
      }
      if (this.elements.stateTitle) this.elements.stateTitle.textContent = STATE_TITLES[state] || "Quick Apply";
      if (this.elements.stateMessage) this.elements.stateMessage.textContent = cleanText(snapshot && snapshot.message, 1024) || "Quick Apply is starting.";
      if (this.elements.content) this.elements.content.hidden = false;
      if (this.elements.search && this.elements.search.value !== snapshot.query) this.elements.search.value = snapshot.query || "";
      if (this.elements.searchClear) setDisabled(this.elements.searchClear, !snapshot.query, "Search is already clear.");
      if (this.elements.selectionSummary) this.elements.selectionSummary.textContent = snapshot.selection && snapshot.selection.message || "Premiere selection is unavailable.";
      this.renderScopes(snapshot.scope);
      this.renderResults(snapshot);
      this.renderActions(snapshot);
      this.renderStatus(snapshot.actionStatus);
      this.onStateChange(snapshot);
    }

    renderScopes(activeScope) {
      const root = this.elements.root;
      if (!root || typeof root.querySelectorAll !== "function") return;
      const controls = Array.from(root.querySelectorAll("[data-quick-apply-scope]"));
      const availableScopes = controls.map((control) => cleanText(control.dataset && control.dataset.quickApplyScope, 32));
      if (!availableScopes.includes(this.scopeFocusValue)) {
        this.scopeFocusValue = availableScopes.includes(activeScope) ? activeScope : availableScopes[0] || "";
      }
      for (const control of controls) {
        const selected = control.dataset.quickApplyScope === activeScope;
        control.classList.toggle("is-active", selected);
        control.setAttribute("aria-pressed", selected ? "true" : "false");
        control.tabIndex = control.dataset.quickApplyScope === this.scopeFocusValue ? 0 : -1;
      }
    }

    scopeControls() {
      const root = this.elements.root;
      return root && typeof root.querySelectorAll === "function"
        ? Array.from(root.querySelectorAll("[data-quick-apply-scope]"))
        : [];
    }

    focusScopeControl(control, controls = this.scopeControls()) {
      if (!control) return false;
      this.scopeFocusValue = cleanText(control.dataset && control.dataset.quickApplyScope, 32);
      for (const candidate of controls) candidate.tabIndex = candidate === control ? 0 : -1;
      if (typeof control.focus === "function") control.focus();
      return true;
    }

    onScopeKeyDown(event, scopeControl) {
      const controls = this.scopeControls();
      const current = controls.indexOf(scopeControl);
      if (current < 0) return false;
      let next = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % controls.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + controls.length) % controls.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = controls.length - 1;
      if (next !== null) {
        event.preventDefault();
        this.focusScopeControl(controls[next], controls);
        return true;
      }
      if (!["Enter", " ", "Spacebar"].includes(event.key)) return false;
      event.preventDefault();
      this.focusScopeControl(scopeControl, controls);
      this.domain.setScope(scopeControl.dataset.quickApplyScope);
      return true;
    }

    renderResults(snapshot) {
      const list = this.elements.results;
      if (!list) return;
      clearElement(list);
      const targets = Array.isArray(snapshot.targets) ? snapshot.targets : [];
      if (this.elements.resultsSummary) this.elements.resultsSummary.textContent = `${targets.length} result${targets.length === 1 ? "" : "s"}`;
      if (this.elements.empty) {
        this.elements.empty.hidden = targets.length > 0;
        this.elements.empty.textContent = snapshot.query
          ? "No supported effect or Oracle Recipe matches this search."
          : snapshot.state === "error"
            ? "Refresh the host-derived effect index after resolving the error above."
            : "No supported result is available in this view.";
      }
      for (const target of targets) list.appendChild(this.createResult(target, target.id === snapshot.selectedTargetId, snapshot.pendingTargetIds && snapshot.pendingTargetIds.includes(target.id)));
    }

    createResult(target, selected, pending) {
      // UXP's native button renderer flattens nested inline content, which
      // collapses the two-row result card into one unreadable label. A focused
      // listbox option keeps the exact same click/Enter/arrow behavior while
      // allowing ordinary DOM layout for the host-derived metadata.
      const control = this.document.createElement("div");
      control.className = `quick-apply-result${selected ? " is-selected" : ""}${target.compatible ? "" : " is-incompatible"}`;
      control.dataset.quickApplyTargetId = target.id;
      control.setAttribute("role", "option");
      control.setAttribute("aria-selected", selected ? "true" : "false");
      control.setAttribute("aria-disabled", target.compatible ? "false" : "true");
      control.setAttribute("aria-label", `${formatMediaType(target)}: ${target.name}. ${target.compatibility.reason || (target.compatible ? "Compatible" : "Incompatible")}`);
      control.tabIndex = selected ? 0 : -1;
      const header = this.document.createElement("span");
      header.className = "quick-apply-result__header";
      appendTextElement(this.document, header, "span", `quick-apply-result__type quick-apply-result__type--${target.mediaType}`, formatMediaType(target));
      appendTextElement(this.document, header, "strong", "quick-apply-result__name", target.name);
      if (target.favorite) appendTextElement(this.document, header, "span", "quick-apply-result__badge", "Favorite");
      if (target.recent) appendTextElement(this.document, header, "span", "quick-apply-result__badge quick-apply-result__badge--recent", "Recent");
      control.appendChild(header);
      const details = this.document.createElement("span");
      details.className = "quick-apply-result__details";
      const category = target.kind === "recipe"
        ? `${target.recipe.steps.length} ordered effect${target.recipe.steps.length === 1 ? "" : "s"}`
        : target.categoryAvailable ? target.category : "Category unavailable from Premiere";
      appendTextElement(this.document, details, "span", "quick-apply-result__category", category);
      appendTextElement(this.document, details, "span", `quick-apply-result__compatibility${target.compatible ? " is-compatible" : " is-incompatible"}`, pending ? "Applying…" : target.compatible ? target.compatibility.reason || "Compatible" : target.compatibility.reason || "Incompatible");
      control.appendChild(details);
      control.title = pending ? `${target.name} is being applied.` : target.compatibility.reason || target.name;
      return control;
    }

    renderActions(snapshot) {
      const target = snapshot.selectedTarget;
      const pending = Boolean(target && snapshot.pendingTargetIds && snapshot.pendingTargetIds.includes(target.id));
      const noSelectionReason = "Choose a supported effect or Oracle Recipe first.";
      setDisabled(this.elements.apply, !target || !target.compatible || pending, !target ? noSelectionReason : pending ? `${target.name} is already being applied.` : target.compatibility.reason);
      if (this.elements.apply) this.elements.apply.textContent = pending ? "Applying…" : target ? `Apply ${target.name}` : "Apply";
      setDisabled(this.elements.favorite, !target, noSelectionReason);
      if (this.elements.favorite) {
        this.elements.favorite.textContent = target && target.favorite ? "Unfavorite" : "Favorite";
        this.elements.favorite.setAttribute("aria-pressed", target && target.favorite ? "true" : "false");
      }
      const recipeSelected = Boolean(target && target.kind === "recipe");
      const effectSelected = Boolean(target && target.kind === "effect");
      setDisabled(this.elements.recipeAddEffect, !effectSelected, "Choose a supported effect to add it to an Oracle Recipe.");
      setDisabled(this.elements.recipeRename, !recipeSelected, "Choose an Oracle Recipe to rename it.");
      setDisabled(this.elements.recipeDuplicate, !recipeSelected, "Choose an Oracle Recipe to duplicate it.");
      setDisabled(this.elements.recipeDelete, !recipeSelected, "Choose an Oracle Recipe to delete it.");
      const recipeIndex = recipeSelected ? snapshot.library.recipes.findIndex((entry) => entry.id === target.recipeId) : -1;
      setDisabled(this.elements.recipeMoveUp, recipeIndex <= 0, recipeSelected ? "This Oracle Recipe is already first." : "Choose an Oracle Recipe to reorder it.");
      setDisabled(this.elements.recipeMoveDown, recipeIndex < 0 || recipeIndex >= snapshot.library.recipes.length - 1, recipeSelected ? "This Oracle Recipe is already last." : "Choose an Oracle Recipe to reorder it.");
      setDisabled(this.elements.recipeExport, !snapshot.library.recipes.length || !this.exportRecipeFile, !this.exportRecipeFile ? "Recipe export needs the UXP file picker integration." : "No Oracle Recipes exist yet.");
      setDisabled(this.elements.recipeImport, !this.importRecipeFile, "Recipe import needs the UXP file picker integration.");
    }

    renderStatus(status) {
      if (!this.elements.status) return;
      const visible = Boolean(status && status.message);
      this.elements.status.hidden = !visible;
      this.elements.status.dataset.tone = visible ? cleanText(status.tone, 32) || (status.ok ? "success" : "error") : "idle";
      this.elements.status.textContent = visible ? cleanText(status.message, 2048) : "";
      this.elements.status.setAttribute("role", status && status.ok === false ? "alert" : "status");
    }

    focusSelectedResult() {
      const list = this.elements.results;
      if (!list || !this.snapshot || !this.snapshot.selectedTargetId || typeof list.querySelectorAll !== "function") return;
      const values = Array.from(list.querySelectorAll("[data-quick-apply-target-id]"));
      const target = values.find((element) => element.dataset.quickApplyTargetId === this.snapshot.selectedTargetId);
      if (target && typeof target.focus === "function") target.focus();
    }

    async applySelected() {
      const before = this.snapshot && this.snapshot.selectedTarget;
      const result = await this.domain.applyTarget();
      if (result && result.message) {
        this.onToast(result.message, result.ok ? (result.skippedCount ? "warning" : "success") : "error");
        this.onAnnounce(result.message);
      }
      if (before && !result.ok && this.elements.search && typeof this.elements.search.focus === "function") this.elements.search.focus();
      return result;
    }

    async onClick(event) {
      const targetControl = closest(event, "[data-quick-apply-target-id]");
      if (targetControl) {
        event.preventDefault();
        this.domain.selectTarget(targetControl.dataset.quickApplyTargetId);
        return;
      }
      const scopeControl = closest(event, "[data-quick-apply-scope]");
      if (scopeControl) {
        event.preventDefault();
        this.scopeFocusValue = cleanText(scopeControl.dataset.quickApplyScope, 32);
        this.domain.setScope(scopeControl.dataset.quickApplyScope);
        this.scheduleSearchFocus();
        return;
      }
      if (closest(event, `#${DOM_IDS.searchClear}`) || closest(event, "[data-quick-apply-action='clear-search']")) {
        event.preventDefault();
        this.domain.setQuery("");
        this.scheduleSearchFocus();
        return;
      }
      if (closest(event, `#${DOM_IDS.refresh}`) || closest(event, "[data-quick-apply-action='refresh']")) {
        event.preventDefault();
        await this.domain.refreshIndex("user");
        return;
      }
      if (closest(event, `#${DOM_IDS.apply}`) || closest(event, "[data-quick-apply-action='apply']")) {
        event.preventDefault();
        await this.applySelected();
        return;
      }
      if (closest(event, `#${DOM_IDS.favorite}`) || closest(event, "[data-quick-apply-action='favorite']")) {
        event.preventDefault();
        this.domain.toggleFavorite();
        return;
      }
      if (closest(event, `#${DOM_IDS.recipeCreate}`) || closest(event, "[data-quick-apply-recipe-action='create']")) {
        event.preventDefault();
        this.openRecipeEditor(null, false);
        return;
      }
      if (closest(event, `#${DOM_IDS.recipeAddEffect}`) || closest(event, "[data-quick-apply-recipe-action='add-effect']")) {
        event.preventDefault();
        this.openRecipeEditor(null, true);
        return;
      }
      if (closest(event, `#${DOM_IDS.recipeRename}`) || closest(event, "[data-quick-apply-recipe-action='rename']")) {
        event.preventDefault();
        await this.renameSelectedRecipe();
        return;
      }
      if (closest(event, `#${DOM_IDS.recipeDuplicate}`) || closest(event, "[data-quick-apply-recipe-action='duplicate']")) {
        event.preventDefault();
        await this.duplicateSelectedRecipe();
        return;
      }
      if (closest(event, `#${DOM_IDS.recipeMoveUp}`) || closest(event, "[data-quick-apply-recipe-action='move-up']")) {
        event.preventDefault();
        await this.moveSelectedRecipe(-1);
        return;
      }
      if (closest(event, `#${DOM_IDS.recipeMoveDown}`) || closest(event, "[data-quick-apply-recipe-action='move-down']")) {
        event.preventDefault();
        await this.moveSelectedRecipe(1);
        return;
      }
      if (closest(event, `#${DOM_IDS.recipeDelete}`) || closest(event, "[data-quick-apply-recipe-action='delete']")) {
        event.preventDefault();
        await this.deleteSelectedRecipe();
        return;
      }
      if (closest(event, `#${DOM_IDS.recipeImport}`) || closest(event, "[data-quick-apply-recipe-action='import']")) {
        event.preventDefault();
        await this.importRecipes();
        return;
      }
      if (closest(event, `#${DOM_IDS.recipeExport}`) || closest(event, "[data-quick-apply-recipe-action='export']")) {
        event.preventDefault();
        await this.exportRecipes();
        return;
      }
      if (closest(event, `#${DOM_IDS.recipeBackdrop}`) || closest(event, `#${DOM_IDS.recipeCancel}`) || closest(event, "[data-recipe-editor-action='cancel']")) {
        event.preventDefault();
        this.closeRecipeEditor(true);
        return;
      }
      if (closest(event, `#${DOM_IDS.recipeNext}`) || closest(event, "[data-recipe-editor-action='next']")) {
        event.preventDefault();
        await this.advanceRecipeEditor();
        return;
      }
      if (closest(event, `#${DOM_IDS.recipeBack}`) || closest(event, "[data-recipe-editor-action='back']")) {
        event.preventDefault();
        this.recipeStage = 1;
        this.renderRecipeEditor();
        return;
      }
      if (closest(event, `#${DOM_IDS.recipeSave}`) || closest(event, "[data-recipe-editor-action='save']")) {
        event.preventDefault();
        await this.saveRecipeEditor();
        return;
      }
      const catalogAdd = closest(event, "[data-recipe-catalog-effect-id]");
      if (catalogAdd) {
        event.preventDefault();
        this.addEffectToDraft(catalogAdd.dataset.recipeCatalogEffectId);
        return;
      }
      const stepAction = closest(event, "[data-recipe-step-action]");
      if (stepAction) {
        event.preventDefault();
        this.editRecipeStep(stepAction.dataset.recipeStepAction, Number(stepAction.dataset.recipeStepIndex));
      }
    }

    onInput(event) {
      if (event.target === this.elements.search) {
        this.domain.setQuery(event.target.value);
        return;
      }
      if (event.target === this.elements.recipeCatalogSearch) this.renderRecipeCatalog();
      if (event.target === this.elements.recipeName && this.recipeDraft) this.recipeDraft.name = cleanText(event.target.value, 256);
    }

    onChange(event) {
      if (!this.recipeOpen || !this.recipeDraft) return;
      if (event.target === this.elements.recipeApplyOnce) {
        this.recipeDraft.applyOnce = Boolean(event.target.checked);
        return;
      }
      const toggle = closest(event, "[data-recipe-parameter-toggle]");
      if (toggle) {
        const key = toggle.dataset.recipeParameterToggle;
        if (toggle.checked) {
          const control = this.findParameterControl(key);
          const descriptor = this.findParameterDescriptor(key);
          this.recipeParameterValues.set(key, readParameterValue(control, descriptor && descriptor.valueType));
        } else this.recipeParameterValues.delete(key);
        this.syncParameterControl(key);
        return;
      }
      const control = closest(event, "[data-recipe-parameter-value]");
      if (control) {
        const key = control.dataset.recipeParameterValue;
        const descriptor = this.findParameterDescriptor(key);
        this.recipeParameterValues.set(key, readParameterValue(control, descriptor && descriptor.valueType));
      }
    }

    async onKeyDown(event) {
      if (event.defaultPrevented || this.recipeOpen) return;
      const scopeControl = closest(event, "[data-quick-apply-scope]");
      if (scopeControl) {
        this.onScopeKeyDown(event, scopeControl);
        return;
      }
      const inSearch = event.target === this.elements.search;
      const inResult = Boolean(closest(event, "[data-quick-apply-target-id]"));
      if (!inSearch && !inResult) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.domain.moveSelection(event.key === "ArrowUp" ? -1 : 1);
        Promise.resolve().then(() => this.focusSelectedResult());
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        await this.applySelected();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (this.snapshot && this.snapshot.query) {
          this.domain.setQuery("");
          this.scheduleSearchFocus();
        } else this.onRequestCloseTopLayer("quick-apply");
      }
    }

    async onDocumentKeyDown(event) {
      const root = this.elements.root;
      const target = event && event.target;
      const activeElement = this.document && this.document.activeElement;
      const ownsInteraction = !root || typeof root.contains !== "function" ||
        (target ? target === root || root.contains(target) : !activeElement || activeElement === root || root.contains(activeElement));
      if (
        !this.active ||
        !this.visible ||
        event.defaultPrevented ||
        event.key !== "Escape" ||
        !ownsInteraction
      ) return;
      if (this.recipeOpen) {
        event.preventDefault();
        event.stopPropagation();
        this.closeRecipeEditor(true);
        return;
      }
      if (this.snapshot && this.snapshot.query) {
        event.preventDefault();
        event.stopPropagation();
        this.domain.setQuery("");
        this.scheduleSearchFocus();
      }
    }

    selectedRecipe() {
      const target = this.snapshot && this.snapshot.selectedTarget;
      return target && target.kind === "recipe" ? target.recipe : null;
    }

    async renameSelectedRecipe() {
      const recipe = this.selectedRecipe();
      if (!recipe || !this.requestRecipeName) return;
      const name = await this.requestRecipeName({ mode: "rename", title: "Rename Oracle Recipe", value: recipe.name, recipe: clone(recipe) });
      if (!cleanText(name, 256)) return;
      const result = await this.domain.renameRecipe(recipe.id, name);
      this.reportRecipeResult(result, "Oracle Recipe renamed.");
    }

    async duplicateSelectedRecipe() {
      const recipe = this.selectedRecipe();
      if (!recipe || !this.requestRecipeName) return;
      const name = await this.requestRecipeName({ mode: "duplicate", title: "Duplicate Oracle Recipe", value: `${recipe.name} Copy`, recipe: clone(recipe) });
      if (!cleanText(name, 256)) return;
      const result = await this.domain.duplicateRecipe(recipe.id, name);
      this.reportRecipeResult(result, "Oracle Recipe duplicated.");
    }

    async moveSelectedRecipe(delta) {
      const recipe = this.selectedRecipe();
      if (!recipe) return;
      const result = await this.domain.moveRecipe(recipe.id, delta);
      this.reportRecipeResult(result, result.unchanged ? "Oracle Recipe order is unchanged." : "Oracle Recipe reordered.");
    }

    async deleteSelectedRecipe() {
      const recipe = this.selectedRecipe();
      if (!recipe) return;
      if (!this.confirmRecipeAction) return;
      const confirmed = await this.confirmRecipeAction({ mode: "delete", title: "Delete Oracle Recipe", message: `Delete “${recipe.name}”? This cannot be undone inside Oracle.`, recipe: clone(recipe) });
      if (!confirmed) return;
      const result = await this.domain.deleteRecipe(recipe.id);
      this.reportRecipeResult(result, "Oracle Recipe deleted.");
    }

    async importRecipes() {
      if (!this.importRecipeFile) return;
      try {
        const value = await this.importRecipeFile({ extensions: ["json"], label: "Import Oracle Recipes" });
        if (!value) return;
        const text = typeof value === "string" ? value : value.text;
        const result = await this.domain.importRecipes(text, { filename: typeof value === "object" ? value.filename : "" });
        this.reportRecipeResult(result, result.message || `${result.imported} Oracle Recipes imported.`);
      } catch (error) {
        this.reportRecipeResult({ ok: false, message: cleanText(error && error.message, 2048) || "Oracle Recipe import failed." });
      }
    }

    async exportRecipes() {
      if (!this.exportRecipeFile) return;
      try {
        const text = this.domain.exportRecipes();
        await this.exportRecipeFile({ text, suggestedName: "Oracle-Recipes.json", mimeType: "application/json" });
        this.reportRecipeResult({ ok: true }, "Oracle Recipes exported.");
      } catch (error) {
        this.reportRecipeResult({ ok: false, message: cleanText(error && error.message, 2048) || "Oracle Recipe export failed." });
      }
    }

    reportRecipeResult(result, successMessage = "Oracle Recipe updated.") {
      const message = result && result.ok ? cleanText(result.message, 2048) || successMessage : cleanText(result && result.message, 2048) || "Oracle Recipe action failed.";
      this.onToast(message, result && result.ok ? "success" : "error");
      this.onAnnounce(message);
      if (this.elements.status) {
        this.elements.status.hidden = false;
        this.elements.status.dataset.tone = result && result.ok ? "success" : "error";
        this.elements.status.textContent = message;
      }
    }

    openRecipeEditor(recipe = null, includeSelectedEffect = false) {
      if (!this.elements.recipeEditor) return false;
      const target = this.snapshot && this.snapshot.selectedTarget;
      const initialSteps = recipe ? clone(recipe.steps) : [];
      if (includeSelectedEffect && target && target.kind === "effect") initialSteps.push(this.stepFromTarget(target, initialSteps.length));
      this.recipeDraft = {
        id: recipe ? recipe.id : "",
        name: recipe ? recipe.name : "",
        favorite: recipe ? recipe.favorite : false,
        applyOnce: recipe ? recipe.applyOnce !== false : true,
        steps: initialSteps,
      };
      this.recipeStage = 1;
      this.recipeParameterDescriptors.clear();
      this.recipeParameterValues.clear();
      for (let stepIndex = 0; stepIndex < initialSteps.length; stepIndex += 1) {
        for (const parameter of initialSteps[stepIndex].parameters || []) this.recipeParameterValues.set(`${stepIndex}:${parameter.id}`, clone(parameter.value));
      }
      this.recipeRestoreFocus = this.document.activeElement;
      this.recipeOpen = true;
      this.focusGeneration += 1;
      this.elements.recipeEditor.hidden = false;
      if (this.elements.recipeBackdrop) this.elements.recipeBackdrop.hidden = false;
      this.renderRecipeEditor();
      Promise.resolve().then(() => {
        if (this.destroyed || !this.recipeOpen) return;
        const first = this.elements.recipeName || this.elements.recipeCatalogSearch || this.elements.recipeCancel;
        if (first && typeof first.focus === "function") first.focus();
      });
      return true;
    }

    closeRecipeEditor(restoreFocus = true) {
      if (!this.recipeOpen) return;
      this.recipeOpen = false;
      this.recipeStage = 1;
      this.recipeDraft = null;
      this.recipeParameterDescriptors.clear();
      this.recipeParameterValues.clear();
      if (this.elements.recipeEditor) this.elements.recipeEditor.hidden = true;
      if (this.elements.recipeBackdrop) this.elements.recipeBackdrop.hidden = true;
      const restore = this.recipeRestoreFocus;
      this.recipeRestoreFocus = null;
      if (restoreFocus && restore && typeof restore.focus === "function") restore.focus();
      else this.scheduleSearchFocus();
    }

    stepFromTarget(target, index) {
      return {
        id: `draft-step-${Date.now().toString(36)}-${index}`,
        effectId: target.effectId,
        effectIdentity: clone(target.identity),
        mediaType: target.mediaType,
        displayName: target.name,
        matchName: target.matchName || "",
        ordinal: target.identity && target.identity.ordinal || 0,
        applyOnce: true,
        parameters: [],
      };
    }

    renderRecipeEditor() {
      if (!this.recipeOpen || !this.recipeDraft) return;
      if (this.elements.recipeEditorTitle) this.elements.recipeEditorTitle.textContent = this.recipeDraft.id ? "Edit Oracle Recipe" : "Create Oracle Recipe";
      if (this.elements.recipeName && this.elements.recipeName.value !== this.recipeDraft.name) this.elements.recipeName.value = this.recipeDraft.name;
      if (this.elements.recipeApplyOnce) this.elements.recipeApplyOnce.checked = this.recipeDraft.applyOnce !== false;
      if (this.elements.recipeStageLabel) this.elements.recipeStageLabel.textContent = this.recipeStage === 1 ? "Step 1 of 2 · Effects" : "Step 2 of 2 · Supported parameters";
      if (this.elements.recipeStageEffects) this.elements.recipeStageEffects.hidden = this.recipeStage !== 1;
      if (this.elements.recipeStageParameters) this.elements.recipeStageParameters.hidden = this.recipeStage !== 2;
      if (this.elements.recipeBack) this.elements.recipeBack.hidden = this.recipeStage === 1;
      if (this.elements.recipeNext) this.elements.recipeNext.hidden = this.recipeStage === 2;
      if (this.elements.recipeSave) this.elements.recipeSave.hidden = this.recipeStage !== 2;
      if (this.elements.recipeEditorStatus) {
        this.elements.recipeEditorStatus.hidden = false;
        this.elements.recipeEditorStatus.textContent = this.recipeStage === 1
          ? `${this.recipeDraft.steps.length} ordered effect${this.recipeDraft.steps.length === 1 ? "" : "s"}. Add only host-indexed video or audio effects.`
          : "Only parameter values exposed as safely readable and writable by Premiere are available.";
      }
      this.renderRecipeStack();
      if (this.recipeStage === 1) this.renderRecipeCatalog();
      else this.renderRecipeParameters();
    }

    renderRecipeStack() {
      const list = this.elements.recipeStack;
      if (!list) return;
      clearElement(list);
      if (!this.recipeDraft.steps.length) {
        appendTextElement(this.document, list, "p", "quick-apply-recipe__empty", "No effects added. Choose a host-indexed effect below.");
        return;
      }
      this.recipeDraft.steps.forEach((step, index) => {
        const row = this.document.createElement("li");
        row.className = "quick-apply-recipe-step";
        appendTextElement(this.document, row, "span", "quick-apply-recipe-step__order", String(index + 1));
        const identity = this.document.createElement("span");
        identity.className = "quick-apply-recipe-step__identity";
        appendTextElement(this.document, identity, "strong", "", step.displayName);
        appendTextElement(this.document, identity, "small", "", `${step.mediaType === "audio" ? "Audio" : "Video"}${step.matchName ? ` · ${step.matchName}` : ""}`);
        row.appendChild(identity);
        const actions = this.document.createElement("span");
        actions.className = "quick-apply-recipe-step__actions";
        for (const [action, label, title, disabled] of [
          ["up", "↑", "Move effect earlier", index === 0],
          ["down", "↓", "Move effect later", index === this.recipeDraft.steps.length - 1],
          ["remove", "×", "Remove effect", false],
        ]) {
          const button = this.document.createElement("button");
          button.type = "button";
          button.className = "oracle-icon-button oracle-icon-button--compact";
          button.dataset.recipeStepAction = action;
          button.dataset.recipeStepIndex = String(index);
          button.textContent = label;
          button.title = title;
          button.setAttribute("aria-label", `${title}: ${step.displayName}`);
          button.disabled = disabled;
          actions.appendChild(button);
        }
        row.appendChild(actions);
        list.appendChild(row);
      });
    }

    renderRecipeCatalog() {
      const list = this.elements.recipeCatalog;
      if (!list || !this.snapshot) return;
      clearElement(list);
      const query = cleanText(this.elements.recipeCatalogSearch && this.elements.recipeCatalogSearch.value, 240).toLocaleLowerCase("en-US");
      const effects = this.snapshot.index.effects.filter((effect) => !query || `${effect.displayName} ${effect.matchName || ""}`.toLocaleLowerCase("en-US").includes(query)).slice(0, 80);
      if (!effects.length) {
        appendTextElement(this.document, list, "p", "quick-apply-recipe__empty", query ? "No host-indexed effect matches this recipe search." : "No host-indexed effects are available.");
        return;
      }
      for (const effect of effects) {
        const button = this.document.createElement("button");
        button.type = "button";
        button.className = "quick-apply-recipe-catalog__item";
        button.dataset.recipeCatalogEffectId = effect.id;
        appendTextElement(this.document, button, "span", `quick-apply-result__type quick-apply-result__type--${effect.mediaType}`, effect.mediaType === "audio" ? "Audio" : "Video");
        appendTextElement(this.document, button, "strong", "", effect.displayName);
        appendTextElement(this.document, button, "small", "", effect.categoryAvailable ? effect.category : "Category unavailable from Premiere");
        list.appendChild(button);
      }
    }

    addEffectToDraft(effectId) {
      if (!this.recipeDraft || !this.snapshot) return;
      const effect = this.snapshot.index.effects.find((entry) => entry.id === effectId);
      if (!effect) return;
      const target = {
        effectId: effect.id,
        identity: effect.identity,
        mediaType: effect.mediaType,
        name: effect.displayName,
        matchName: effect.matchName,
      };
      this.recipeDraft.steps.push(this.stepFromTarget(target, this.recipeDraft.steps.length));
      this.renderRecipeEditor();
    }

    editRecipeStep(action, index) {
      if (!this.recipeDraft || !Number.isInteger(index) || index < 0 || index >= this.recipeDraft.steps.length) return;
      if (action === "remove") this.recipeDraft.steps.splice(index, 1);
      else if (action === "up" && index > 0) {
        const [step] = this.recipeDraft.steps.splice(index, 1);
        this.recipeDraft.steps.splice(index - 1, 0, step);
      } else if (action === "down" && index < this.recipeDraft.steps.length - 1) {
        const [step] = this.recipeDraft.steps.splice(index, 1);
        this.recipeDraft.steps.splice(index + 1, 0, step);
      }
      this.renderRecipeEditor();
    }

    async advanceRecipeEditor() {
      if (!this.recipeDraft || !this.recipeDraft.steps.length) {
        this.setRecipeEditorError("Add at least one supported effect before choosing parameter values.");
        return;
      }
      this.recipeParameterDescriptors.clear();
      for (let index = 0; index < this.recipeDraft.steps.length; index += 1) {
        const step = this.recipeDraft.steps[index];
        try {
          const descriptors = await this.domain.getSupportedParameters(step.effectId);
          this.recipeParameterDescriptors.set(index, descriptors);
        } catch (error) {
          this.recipeParameterDescriptors.set(index, []);
        }
      }
      this.recipeStage = 2;
      this.renderRecipeEditor();
    }

    renderRecipeParameters() {
      const list = this.elements.recipeParameterList;
      if (!list || !this.recipeDraft) return;
      clearElement(list);
      let count = 0;
      this.recipeDraft.steps.forEach((step, stepIndex) => {
        const descriptors = this.recipeParameterDescriptors.get(stepIndex) || [];
        const section = this.document.createElement("section");
        section.className = "quick-apply-recipe-parameters__effect";
        appendTextElement(this.document, section, "h4", "", `${stepIndex + 1}. ${step.displayName}`);
        if (!descriptors.length) {
          appendTextElement(this.document, section, "p", "quick-apply-recipe__empty", "No parameter value is proven safe to set for this effect in the current Premiere selection.");
        }
        descriptors.forEach((descriptor) => {
          count += 1;
          const key = `${stepIndex}:${descriptor.id}`;
          const row = this.document.createElement("label");
          row.className = "quick-apply-recipe-parameter";
          const toggle = this.document.createElement("input");
          toggle.type = "checkbox";
          toggle.dataset.recipeParameterToggle = key;
          toggle.checked = this.recipeParameterValues.has(key);
          row.appendChild(toggle);
          appendTextElement(this.document, row, "span", "quick-apply-recipe-parameter__name", descriptor.displayName);
          const control = this.createParameterControl(descriptor, key);
          control.disabled = !toggle.checked;
          row.appendChild(control);
          section.appendChild(row);
        });
        list.appendChild(section);
      });
      if (!count && this.elements.recipeEditorStatus) this.elements.recipeEditorStatus.textContent = "No optional parameter values are proven safe. The ordered effect stack can still be saved and applied.";
    }

    createParameterControl(descriptor, key) {
      let control;
      if (descriptor.options && descriptor.options.length) {
        control = this.document.createElement("select");
        control.dataset.recipeParameterOptions = "true";
        for (const entry of descriptor.options) control.appendChild(option(this.document, JSON.stringify(entry.value), entry.label));
      } else {
        control = this.document.createElement("input");
        if (descriptor.valueType === "boolean") control.type = "checkbox";
        else if (["number", "float", "integer"].includes(descriptor.valueType)) {
          control.type = "number";
          if (descriptor.minimum !== null) control.min = String(descriptor.minimum);
          if (descriptor.maximum !== null) control.max = String(descriptor.maximum);
          control.step = descriptor.valueType === "integer" ? "1" : "any";
        } else control.type = "text";
      }
      control.className = "quick-apply-recipe-parameter__value";
      control.dataset.recipeParameterValue = key;
      const value = this.recipeParameterValues.has(key) ? this.recipeParameterValues.get(key) : descriptor.value;
      if (descriptor.valueType === "boolean") control.checked = Boolean(value);
      else if (descriptor.options && descriptor.options.length) control.value = JSON.stringify(value);
      else control.value = value == null ? "" : String(value);
      control.setAttribute("aria-label", `${descriptor.displayName} value`);
      return control;
    }

    findParameterDescriptor(key) {
      const separator = key.indexOf(":");
      const stepIndex = Number(key.slice(0, separator));
      const id = key.slice(separator + 1);
      return (this.recipeParameterDescriptors.get(stepIndex) || []).find((entry) => entry.id === id) || null;
    }

    findParameterControl(key) {
      const list = this.elements.recipeParameterList;
      if (!list || typeof list.querySelectorAll !== "function") return null;
      return Array.from(list.querySelectorAll("[data-recipe-parameter-value]")).find((entry) => entry.dataset.recipeParameterValue === key) || null;
    }

    syncParameterControl(key) {
      const control = this.findParameterControl(key);
      if (control) control.disabled = !this.recipeParameterValues.has(key);
    }

    async saveRecipeEditor() {
      if (!this.recipeDraft) return;
      let name = cleanText(this.recipeDraft.name, 256);
      if (!name && this.requestRecipeName) name = cleanText(await this.requestRecipeName({ mode: "create", title: "Name Oracle Recipe", value: "New Oracle Recipe", recipe: clone(this.recipeDraft) }), 256);
      if (!name) {
        this.setRecipeEditorError("Enter a name for this Oracle Recipe.");
        if (this.elements.recipeName && typeof this.elements.recipeName.focus === "function") this.elements.recipeName.focus();
        return;
      }
      const draft = clone(this.recipeDraft);
      draft.name = name;
      draft.steps.forEach((step, stepIndex) => {
        const descriptors = this.recipeParameterDescriptors.get(stepIndex) || [];
        step.parameters = [];
        for (const descriptor of descriptors) {
          const key = `${stepIndex}:${descriptor.id}`;
          if (!this.recipeParameterValues.has(key)) continue;
          step.parameters.push({ id: descriptor.id, index: descriptor.index, displayName: descriptor.displayName, valueType: descriptor.valueType, value: clone(this.recipeParameterValues.get(key)) });
        }
      });
      const result = await this.domain.saveRecipe(draft, draft.id || "");
      if (!result.ok) {
        this.setRecipeEditorError(result.message || "Oracle Recipe could not be saved.");
        return;
      }
      this.closeRecipeEditor(false);
      this.reportRecipeResult(result, "Oracle Recipe saved.");
      this.scheduleSearchFocus();
    }

    setRecipeEditorError(message) {
      if (!this.elements.recipeEditorStatus) return;
      this.elements.recipeEditorStatus.hidden = false;
      this.elements.recipeEditorStatus.dataset.tone = "error";
      this.elements.recipeEditorStatus.textContent = message;
      this.elements.recipeEditorStatus.setAttribute("role", "alert");
      this.onAnnounce(message);
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.focusGeneration += 1;
      const root = this.elements.root;
      if (root) {
        root.removeEventListener("click", this.handleClick);
        root.removeEventListener("input", this.handleInput);
        root.removeEventListener("change", this.handleChange);
        root.removeEventListener("keydown", this.handleKeyDown);
      }
      this.document.removeEventListener("keydown", this.handleDocumentKeyDown, true);
      if (typeof this.unsubscribe === "function") this.unsubscribe();
      this.unsubscribe = null;
      this.closeRecipeEditor(false);
      if (this.ownsDomain && this.domain && typeof this.domain.destroy === "function") this.domain.destroy();
      this.snapshot = null;
    }
  }

  return Object.freeze({
    DOM_IDS,
    ELEMENT_ALIASES,
    STATE_TITLES,
    normalizeElements,
    formatMediaType,
    QuickApplyWorkspaceController,
  });
});
