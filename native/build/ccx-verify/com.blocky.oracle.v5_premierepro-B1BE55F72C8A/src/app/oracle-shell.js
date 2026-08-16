"use strict";

(function exposeOracleShell(globalScope, factory) {
  const api = factory(globalScope);
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
  if (globalScope) {
    Reflect.set(globalScope, "OracleOverdriveShell", api);
  }
})(typeof window !== "undefined" ? window : null, function createOracleShellApi(globalScope) {
  const DRAWER_TRANSITION_MS = 160;

  function focusableElements(container) {
    if (!container || typeof container.querySelectorAll !== "function") return [];
    return Array.from(container.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => {
      for (let current = element; current && current !== container; current = current.parentElement) {
        if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
      }
      return !element.hidden && element.getAttribute("aria-hidden") !== "true";
    });
  }

  function trapTab(event, container) {
    if (!event || event.key !== "Tab") return false;
    const focusable = focusableElements(container);
    if (focusable.length === 0) {
      event.preventDefault();
      if (container && typeof container.focus === "function") container.focus();
      return true;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = container.ownerDocument && container.ownerDocument.activeElement;
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

  class OracleShellController {
    constructor(elements, options = {}) {
      this.elements = elements;
      const globalDocument = typeof document !== "undefined" ? document : null;
      const rootAnchor = elements && (elements.navigationDrawer || elements.navigationToggle);
      const inferredRoot = rootAnchor && typeof rootAnchor.closest === "function"
        ? rootAnchor.closest("[data-oracle-panel-root], .oracle-panel")
        : null;
      this.root = options.root || (elements && elements.root) || inferredRoot || options.document || globalDocument;
      this.document = options.document || (this.root && this.root.ownerDocument) || globalDocument;
      this.isInteractionOwner = typeof options.isInteractionOwner === "function"
        ? options.isInteractionOwner
        : null;
      this.onRouteChange = typeof options.onRouteChange === "function"
        ? options.onRouteChange
        : () => undefined;
      this.route = "replays";
      this.drawerOpen = false;
      this.drawerTimer = null;
      this.restoreFocus = null;
      this.started = false;
      this.onToggle = (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.toggleDrawer();
      };
      this.onBackdrop = (event) => {
        event.preventDefault();
        this.closeDrawer(true);
      };
      this.onNavigationClick = (event) => {
        const button = event.target && event.target.closest
          ? event.target.closest("[data-oracle-route]")
          : null;
        if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return;
        event.preventDefault();
        event.stopPropagation();
        // Premiere refuses focus requests for a routed text field while the
        // drawer still owns the visible top layer. Hide that layer in the
        // activation turn, then publish the route so workspace focus can land
        // on a genuinely visible control without a host warning.
        this.closeDrawer(false, true);
        this.setRoute(button.dataset.oracleRoute);
      };
      this.onKeyDown = (event) => {
        if (!this.drawerOpen || event.defaultPrevented || !this.ownsKeyboardInteraction(event)) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.closeDrawer(true);
          return;
        }
        trapTab(event, this.elements.navigationDrawer);
      };
      this.onPreferencesOpening = () => this.closeDrawer(false);
    }

    start() {
      if (this.started) return;
      this.started = true;
      this.elements.navigationToggle.addEventListener("click", this.onToggle);
      this.elements.navigationBackdrop.addEventListener("click", this.onBackdrop);
      this.elements.navigationDrawer.addEventListener("click", this.onNavigationClick);
      if (this.document) {
        this.document.addEventListener("keydown", this.onKeyDown, true);
        this.document.addEventListener("oracle:preferences-opening", this.onPreferencesOpening);
      }
      this.setRoute(this.route, false);
    }

    ownsKeyboardInteraction(event) {
      if (this.isInteractionOwner) return this.isInteractionOwner(event) === true;
      const root = this.root;
      const ownerDocument = this.document;
      if (!root || root === ownerDocument || typeof root.contains !== "function") return true;
      const target = event && event.target;
      if (target) return target === root || root.contains(target);
      const active = ownerDocument && ownerDocument.activeElement;
      return !active || active === root || root.contains(active);
    }

    toggleDrawer() {
      if (this.drawerOpen) this.closeDrawer(true);
      else this.openDrawer();
    }

    openDrawer() {
      if (this.drawerTimer !== null) {
        clearTimeout(this.drawerTimer);
        this.drawerTimer = null;
      }
      const active = this.document && this.document.activeElement;
      this.restoreFocus = active && this.root && typeof this.root.contains === "function" &&
        (active === this.root || this.root.contains(active))
        ? active
        : this.elements.navigationToggle;
      this.drawerOpen = true;
      this.elements.navigationDrawer.hidden = false;
      this.elements.navigationBackdrop.hidden = false;
      this.elements.navigationToggle.setAttribute("aria-expanded", "true");
      if (this.document) this.document.dispatchEvent(new CustomEvent("oracle:shell-drawer-opening"));
      // Premiere's UXP compositor may never deliver requestAnimationFrame for a
      // narrow docked panel. Commit the usable state in the input turn so the
      // drawer cannot remain visible-but-translated and pointer-inert.
      this.elements.navigationDrawer.classList.add("is-open");
      this.elements.navigationBackdrop.classList.add("is-open");
      const activeRoute = this.elements.navigationDrawer.querySelector(
        `[data-oracle-route="${this.route}"]:not([disabled])`,
      );
      const target = activeRoute || focusableElements(this.elements.navigationDrawer)[0];
      if (target && typeof target.focus === "function") target.focus();
    }

    closeDrawer(restoreFocus, immediate = false) {
      if (!this.drawerOpen && this.elements.navigationDrawer.hidden) return;
      this.drawerOpen = false;
      this.elements.navigationDrawer.classList.remove("is-open");
      this.elements.navigationBackdrop.classList.remove("is-open");
      this.elements.navigationToggle.setAttribute("aria-expanded", "false");
      if (this.drawerTimer !== null) clearTimeout(this.drawerTimer);
      const focusTarget = restoreFocus
        ? (this.restoreFocus || this.elements.navigationToggle)
        : null;
      if (immediate) {
        this.elements.navigationDrawer.hidden = true;
        this.elements.navigationBackdrop.hidden = true;
        this.restoreFocus = null;
        return;
      }
      this.drawerTimer = setTimeout(() => {
        this.drawerTimer = null;
        if (!this.drawerOpen) {
          this.elements.navigationDrawer.hidden = true;
          this.elements.navigationBackdrop.hidden = true;
          if (focusTarget && focusTarget.isConnected !== false && typeof focusTarget.focus === "function") {
            focusTarget.focus();
          }
        }
      }, DRAWER_TRANSITION_MS);
      this.restoreFocus = null;
    }

    setRoute(route, notify = true) {
      const nextRoute = String(route || "replays");
      const previousRoute = this.route;
      const button = this.elements.navigationDrawer.querySelector(
        `[data-oracle-route="${nextRoute}"]`,
      );
      if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") {
        return false;
      }
      this.route = nextRoute;
      for (const item of this.elements.navigationDrawer.querySelectorAll("[data-oracle-route]")) {
        const selected = item.dataset.oracleRoute === nextRoute;
        item.classList.toggle("is-active", selected);
        item.setAttribute("aria-current", selected ? "page" : "false");
      }
      const viewScope = this.root && typeof this.root.querySelectorAll === "function"
        ? this.root
        : this.document;
      const views = viewScope && typeof viewScope.querySelectorAll === "function"
        ? viewScope.querySelectorAll("[data-oracle-view]")
        : [];
      for (const view of views) {
        const viewElement = /** @type {HTMLElement} */ (view);
        viewElement.hidden = viewElement.dataset.oracleView !== nextRoute;
      }
      const telemetry = globalScope && Reflect.get(globalScope, "oraclePlatformTelemetry");
      if (previousRoute !== nextRoute && telemetry && typeof telemetry.tabSwitch === "function") {
        telemetry.tabSwitch({
          root: this.root,
          panelId: this.root && this.root.dataset && this.root.dataset.oraclePanelRoot || "oraclePanel",
          group: "workspace-route",
          from: previousRoute,
          to: nextRoute,
          trigger: notify ? "interaction-or-controller" : "bootstrap",
        });
      }
      if (notify) this.onRouteChange(nextRoute);
      return true;
    }

    destroy() {
      if (!this.started) return;
      this.started = false;
      if (this.drawerTimer !== null) clearTimeout(this.drawerTimer);
      this.drawerTimer = null;
      this.elements.navigationToggle.removeEventListener("click", this.onToggle);
      this.elements.navigationBackdrop.removeEventListener("click", this.onBackdrop);
      this.elements.navigationDrawer.removeEventListener("click", this.onNavigationClick);
      if (this.document) {
        this.document.removeEventListener("keydown", this.onKeyDown, true);
        this.document.removeEventListener("oracle:preferences-opening", this.onPreferencesOpening);
      }
      this.drawerOpen = false;
      this.elements.navigationDrawer.classList.remove("is-open");
      this.elements.navigationBackdrop.classList.remove("is-open");
      this.elements.navigationDrawer.hidden = true;
      this.elements.navigationBackdrop.hidden = true;
      this.elements.navigationToggle.setAttribute("aria-expanded", "false");
      this.restoreFocus = null;
    }
  }

  return {
    DRAWER_TRANSITION_MS,
    OracleShellController,
    focusableElements,
    trapTab,
  };
});
