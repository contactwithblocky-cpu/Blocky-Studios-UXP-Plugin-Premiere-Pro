"use strict";

(function exposeOracleRuntimeRegistry(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OracleRuntimeRegistry", api);
})(typeof window !== "undefined" ? window : null, function createOracleRuntimeRegistryApi() {
  const MAX_DIAGNOSTICS = 100;

  class RuntimeCoordinationError extends Error {
    constructor(code, message, details = {}) {
      super(message || code || "Blocky Studios runtime coordination failed.");
      this.name = "RuntimeCoordinationError";
      this.code = String(code || "RUNTIME_COORDINATION_FAILED");
      this.details = details && typeof details === "object" ? { ...details } : {};
    }
  }

  function ownerLabel(value, fallback) {
    const label = String(value || "").trim().slice(0, 160);
    return label || fallback;
  }

  function isRejectedCloseResult(result) {
    if (result === false) return true;
    if (!result || typeof result !== "object") return false;
    if (result.ok === false) return true;
    return Object.prototype.hasOwnProperty.call(result, "closed") &&
      result.closed !== true && result.ownershipLost !== true;
  }

  class DiagnosticOwner {
    constructor(options = {}) {
      this.now = typeof options.now === "function" ? options.now : () => Date.now();
      this.logger = options.logger && typeof options.logger === "object" ? options.logger : null;
      this.diagnostics = [];
    }

    recordDiagnostic(code, details = {}) {
      const entry = Object.freeze({ code, at: this.now(), ...details });
      this.diagnostics.push(entry);
      if (this.diagnostics.length > MAX_DIAGNOSTICS) {
        this.diagnostics.splice(0, this.diagnostics.length - MAX_DIAGNOSTICS);
      }
      if (this.logger && typeof this.logger.warn === "function") {
        try { this.logger.warn(`[Blocky Studios Runtime][${code}]`, details); } catch (error) { /* diagnostics stay non-fatal */ }
      }
      return entry;
    }

    getDiagnostics() {
      return this.diagnostics.map((entry) => ({ ...entry }));
    }
  }

  class ActivationLeaseCoordinator extends DiagnosticOwner {
    constructor(adapter, options = {}) {
      super(options);
      if (!adapter || typeof adapter !== "object") {
        throw new TypeError("ActivationLeaseCoordinator requires an adapter object.");
      }
      this.adapter = adapter;
      this.leases = new Map();
      this.sequence = 0;
      this.observe = null;
      this.startAttempted = false;
      this.startResult = undefined;
      this.startError = null;
      this.destroyed = false;
      this.destroyPromise = null;
    }

    start() {
      if (this.startAttempted) {
        if (this.startError) throw this.startError;
        return this.startResult;
      }
      if (this.destroyed) {
        throw new RuntimeCoordinationError(
          "ACTIVATION_COORDINATOR_DESTROYED",
          "The activation coordinator has been destroyed.",
        );
      }
      this.startAttempted = true;
      try {
        const result = typeof this.adapter.start === "function"
          ? this.adapter.start()
          : this.adapter;
        this.startResult = result && typeof result.then === "function"
          ? Promise.resolve(result).catch((error) => {
            this.startError = error;
            throw error;
          })
          : result;
        return this.startResult;
      } catch (error) {
        this.startError = error;
        throw error;
      }
    }

    acquireLease(ownerId, options = {}) {
      if (this.destroyed) {
        throw new RuntimeCoordinationError(
          "ACTIVATION_COORDINATOR_DESTROYED",
          "Cannot acquire an activation lease after coordinator teardown.",
        );
      }
      const sequence = ++this.sequence;
      const label = ownerLabel(ownerId, `activation-owner-${sequence}`);
      const record = {
        id: `activation-lease-${sequence}`,
        ownerId: label,
        visible: options.visible === true,
        active: options.active === true,
        released: false,
      };
      this.leases.set(record.id, record);
      const leaseMethods = {
        leaseId: record.id,
        ownerId: label,
        start: () => this.start(),
        setVisible: (value) => this.updateLease(record, "visible", value),
        setActive: (value) => this.updateLease(record, "active", value),
        release: () => this.releaseLease(record),
        destroy: () => this.releaseLease(record),
        getLeaseState: () => this.leaseState(record),
      };
      const proxy = new Proxy(leaseMethods, {
        get: (target, property, receiver) => {
          if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
          const value = Reflect.get(this.adapter, property, this.adapter);
          return typeof value === "function" ? value.bind(this.adapter) : value;
        },
      });
      record.proxy = proxy;
      this.reconcileObservation("acquire");
      return proxy;
    }

    acquire(ownerId, options = {}) {
      return this.acquireLease(ownerId, options);
    }

    leaseState(record) {
      return Object.freeze({
        id: record.id,
        ownerId: record.ownerId,
        visible: record.visible,
        active: record.active,
        observing: !record.released && record.visible && record.active,
        released: record.released,
      });
    }

    updateLease(record, property, value) {
      if (record.released || !this.leases.has(record.id)) {
        this.recordDiagnostic("ACTIVATION_LEASE_UPDATE_AFTER_RELEASE", {
          leaseId: record.id,
          ownerId: record.ownerId,
          property,
        });
        return false;
      }
      const next = Boolean(value);
      if (record[property] === next) return false;
      record[property] = next;
      this.reconcileObservation(`lease-${property}`);
      return true;
    }

    releaseLease(record) {
      if (record.released || !this.leases.has(record.id)) {
        this.recordDiagnostic("ACTIVATION_LEASE_RELEASE_ALREADY_RELEASED", {
          leaseId: record.id,
          ownerId: record.ownerId,
          leaseCount: this.leases.size,
        });
        return false;
      }
      record.released = true;
      record.visible = false;
      record.active = false;
      this.leases.delete(record.id);
      this.reconcileObservation("release");
      return true;
    }

    reconcileObservation(reason) {
      const next = Array.from(this.leases.values()).some((lease) =>
        !lease.released && lease.visible && lease.active);
      if (next === this.observe) return next;
      try {
        if (next) {
          if (typeof this.adapter.setVisible === "function") this.adapter.setVisible(true);
          if (typeof this.adapter.setActive === "function") this.adapter.setActive(true);
        } else {
          if (typeof this.adapter.setActive === "function") this.adapter.setActive(false);
          if (typeof this.adapter.setVisible === "function") this.adapter.setVisible(false);
        }
        this.observe = next;
        return next;
      } catch (error) {
        this.recordDiagnostic("ACTIVATION_RECONCILE_FAILED", {
          reason,
          requestedObserve: next,
          message: String(error && error.message ? error.message : error),
        });
        throw error;
      }
    }

    getState() {
      return Object.freeze({
        observe: this.observe === true,
        leaseCount: this.leases.size,
        started: this.startAttempted && !this.startError,
        destroyed: this.destroyed,
        leases: Object.freeze(Array.from(this.leases.values()).map((record) => this.leaseState(record))),
      });
    }

    destroy() {
      if (this.destroyPromise) return this.destroyPromise;
      this.destroyPromise = (async () => {
        if (this.destroyed) return false;
        this.destroyed = true;
        for (const record of this.leases.values()) {
          record.released = true;
          record.visible = false;
          record.active = false;
        }
        this.leases.clear();
        try {
          if (typeof this.adapter.setActive === "function") this.adapter.setActive(false);
        } catch (error) {
          this.recordDiagnostic("ACTIVATION_DESTROY_DEACTIVATE_FAILED", {
            message: String(error && error.message ? error.message : error),
          });
        }
        try {
          if (typeof this.adapter.setVisible === "function") this.adapter.setVisible(false);
        } catch (error) {
          this.recordDiagnostic("ACTIVATION_DESTROY_HIDE_FAILED", {
            message: String(error && error.message ? error.message : error),
          });
        }
        this.observe = false;
        try {
          if (typeof this.adapter.destroy === "function") await this.adapter.destroy();
        } catch (error) {
          this.recordDiagnostic("ACTIVATION_RAW_DESTROY_FAILED", {
            message: String(error && error.message ? error.message : error),
          });
        }
        return true;
      })();
      return this.destroyPromise;
    }
  }

  class SourceMonitorViewerLeaseCoordinator extends DiagnosticOwner {
    constructor(adapter, options = {}) {
      super(options);
      if (!adapter || typeof adapter !== "object" || typeof adapter.open !== "function") {
        throw new TypeError("SourceMonitorViewerLeaseCoordinator requires a viewer adapter with open().");
      }
      this.adapter = adapter;
      this.leases = new Map();
      this.sequence = 0;
      this.owner = null;
      this.operationChain = Promise.resolve();
      this.destroyed = false;
      this.destroyPromise = null;
      this.unownedMethods = new Set(Array.isArray(options.unownedMethods) ? options.unownedMethods : ["isAvailable"]);
    }

    acquireLease(ownerId, options = {}) {
      if (this.destroyed) {
        throw new RuntimeCoordinationError(
          "VIEWER_COORDINATOR_DESTROYED",
          "Cannot acquire a Source Monitor lease after coordinator teardown.",
        );
      }
      const sequence = ++this.sequence;
      const label = ownerLabel(ownerId, `viewer-owner-${sequence}`);
      const record = {
        id: `viewer-lease-${sequence}`,
        ownerId: label,
        token: "",
        replayId: "",
        released: false,
        revoked: false,
        revokeReason: "",
        onRevoked: typeof options.onRevoked === "function" ? options.onRevoked : null,
      };
      this.leases.set(record.id, record);
      const leaseMethods = {
        leaseId: record.id,
        ownerId: label,
        open: (replay) => this.openFor(record, replay),
        close: (token) => this.closeFor(record, token),
        release: () => this.releaseLease(record),
        destroy: () => this.releaseLease(record),
        isOwner: () => this.owner === record && Boolean(record.token) && !record.released,
        getOwnershipToken: () => this.owner === record && !record.released ? record.token : "",
        getLeaseState: () => this.leaseState(record),
      };
      const proxy = new Proxy(leaseMethods, {
        get: (target, property, receiver) => {
          if (property === "ownershipToken") {
            return this.owner === record && !record.released ? record.token : "";
          }
          if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
          const value = Reflect.get(this.adapter, property, this.adapter);
          if (typeof value !== "function") return value;
          if (this.unownedMethods.has(String(property))) return value.bind(this.adapter);
          return (...args) => this.invokeOwned(record, String(property), args);
        },
      });
      record.proxy = proxy;
      return proxy;
    }

    acquire(ownerId, options = {}) {
      return this.acquireLease(ownerId, options);
    }

    leaseState(record) {
      return Object.freeze({
        id: record.id,
        ownerId: record.ownerId,
        owner: this.owner === record && Boolean(record.token) && !record.released,
        ownershipToken: this.owner === record && !record.released ? record.token : "",
        released: record.released,
        revoked: record.revoked,
        revokeReason: record.revokeReason,
      });
    }

    enqueue(operation) {
      const result = this.operationChain.catch(() => undefined).then(operation);
      this.operationChain = result.catch(() => undefined);
      return result;
    }

    assertUsable(record) {
      if (this.destroyed) {
        throw new RuntimeCoordinationError(
          "VIEWER_COORDINATOR_DESTROYED",
          "The Source Monitor coordinator has been destroyed.",
        );
      }
      if (record.released || !this.leases.has(record.id)) {
        throw new RuntimeCoordinationError(
          "VIEWER_LEASE_RELEASED",
          "This panel no longer owns a Source Monitor lease.",
          { leaseId: record.id, ownerId: record.ownerId },
        );
      }
    }

    assertOwner(record) {
      this.assertUsable(record);
      if (this.owner !== record || !record.token) {
        throw new RuntimeCoordinationError(
          "VIEWER_LEASE_NOT_OWNER",
          "Another Blocky Studios panel owns the Source Monitor viewer.",
          { leaseId: record.id, ownerId: record.ownerId, revoked: record.revoked },
        );
      }
    }

    notifyRevoked(record, reason, token) {
      if (!record.onRevoked) return;
      try {
        record.onRevoked(Object.freeze({
          leaseId: record.id,
          ownerId: record.ownerId,
          reason,
          ownershipToken: token,
        }));
      } catch (error) {
        this.recordDiagnostic("VIEWER_REVOKE_CALLBACK_FAILED", {
          leaseId: record.id,
          ownerId: record.ownerId,
          reason,
          message: String(error && error.message ? error.message : error),
        });
      }
    }

    revoke(record, reason, token = record.token) {
      if (this.owner === record) this.owner = null;
      record.token = "";
      record.replayId = "";
      record.revoked = true;
      record.revokeReason = reason;
      this.notifyRevoked(record, reason, token);
    }

    async closeOwner(record, reason) {
      if (this.owner !== record || !record.token) {
        return { ok: true, closed: false, ownershipLost: record.revoked };
      }
      const token = record.token;
      let result;
      try {
        result = typeof this.adapter.close === "function"
          ? await this.adapter.close(token)
          : { ok: true, closed: false, ownershipLost: true };
      } catch (error) {
        this.recordDiagnostic("VIEWER_OWNER_CLOSE_FAILED", {
          leaseId: record.id,
          ownerId: record.ownerId,
          reason,
          message: String(error && error.message ? error.message : error),
        });
        throw error;
      }
      if (isRejectedCloseResult(result)) {
        const error = new RuntimeCoordinationError(
          "VIEWER_OWNER_CLOSE_REJECTED",
          "Premiere rejected release of the currently owned Source Monitor item.",
          { leaseId: record.id, ownerId: record.ownerId, reason },
        );
        this.recordDiagnostic(error.code, error.details);
        throw error;
      }
      this.revoke(record, reason, token);
      return result === undefined ? { ok: true, closed: true, ownershipLost: false } : result;
    }

    openFor(record, replay) {
      return this.enqueue(async () => {
        this.assertUsable(record);
        if (this.owner) await this.closeOwner(this.owner, this.owner === record ? "replaced" : "superseded");
        this.assertUsable(record);
        const opened = await this.adapter.open(replay);
        const token = String(opened && opened.ownershipToken || "").trim();
        if (!token) {
          try {
            if (typeof this.adapter.close === "function") await this.adapter.close();
          } catch (error) {
            this.recordDiagnostic("VIEWER_TOKENLESS_OPEN_CLEANUP_FAILED", {
              leaseId: record.id,
              ownerId: record.ownerId,
              message: String(error && error.message ? error.message : error),
            });
          }
          throw new RuntimeCoordinationError(
            "VIEWER_OWNERSHIP_TOKEN_MISSING",
            "The Source Monitor adapter opened media without an ownership token.",
            { leaseId: record.id, ownerId: record.ownerId },
          );
        }
        if (record.released || this.destroyed) {
          try {
            if (typeof this.adapter.close === "function") await this.adapter.close(token);
          } finally {
            throw new RuntimeCoordinationError(
              record.released ? "VIEWER_LEASE_RELEASED" : "VIEWER_COORDINATOR_DESTROYED",
              "The Source Monitor lease ended while media was opening.",
              { leaseId: record.id, ownerId: record.ownerId },
            );
          }
        }
        record.token = token;
        record.replayId = String(replay && (replay.id || replay.replayId) || "").slice(0, 256);
        record.revoked = false;
        record.revokeReason = "";
        this.owner = record;
        return opened;
      });
    }

    closeFor(record, requestedToken) {
      return this.enqueue(async () => {
        if (record.released || !this.leases.has(record.id)) {
          return { ok: true, closed: false, ownershipLost: true };
        }
        if (this.owner !== record || !record.token) {
          return { ok: true, closed: false, ownershipLost: record.revoked };
        }
        const requested = String(requestedToken || "").trim();
        if (requested && requested !== record.token) {
          this.recordDiagnostic("VIEWER_CLOSE_TOKEN_MISMATCH", {
            leaseId: record.id,
            ownerId: record.ownerId,
          });
          return { ok: true, closed: false, ownershipLost: true };
        }
        return this.closeOwner(record, "closed");
      });
    }

    invokeOwned(record, methodName, args) {
      return this.enqueue(async () => {
        this.assertOwner(record);
        const method = this.adapter[methodName];
        if (typeof method !== "function") {
          throw new RuntimeCoordinationError(
            "VIEWER_METHOD_UNAVAILABLE",
            `The Source Monitor adapter does not expose ${methodName}().`,
            { methodName },
          );
        }
        return method.apply(this.adapter, args);
      });
    }

    releaseLease(record) {
      if (record.released || !this.leases.has(record.id)) {
        this.recordDiagnostic("VIEWER_LEASE_RELEASE_ALREADY_RELEASED", {
          leaseId: record.id,
          ownerId: record.ownerId,
          leaseCount: this.leases.size,
        });
        return Promise.resolve(false);
      }
      record.released = true;
      this.leases.delete(record.id);
      return this.enqueue(async () => {
        if (this.owner === record && record.token) await this.closeOwner(record, "released");
        return true;
      });
    }

    getState() {
      return Object.freeze({
        leaseCount: this.leases.size,
        ownerLeaseId: this.owner && !this.owner.released ? this.owner.id : "",
        ownerId: this.owner && !this.owner.released ? this.owner.ownerId : "",
        destroyed: this.destroyed,
        leases: Object.freeze(Array.from(this.leases.values()).map((record) => this.leaseState(record))),
      });
    }

    destroy() {
      if (this.destroyPromise) return this.destroyPromise;
      this.destroyed = true;
      for (const record of this.leases.values()) record.released = true;
      this.leases.clear();
      this.destroyPromise = this.enqueue(async () => {
        const owner = this.owner;
        if (owner && owner.token) {
          const token = owner.token;
          try {
            await this.closeOwner(owner, "coordinator-destroyed");
          } catch (error) {
            this.recordDiagnostic("VIEWER_DESTROY_OWNER_CLOSE_FAILED", {
              leaseId: owner.id,
              ownerId: owner.ownerId,
              message: String(error && error.message ? error.message : error),
            });
            if (this.owner === owner) this.revoke(owner, "coordinator-destroyed", token);
          }
        }
        try {
          if (typeof this.adapter.destroy === "function") await this.adapter.destroy();
        } catch (error) {
          this.recordDiagnostic("VIEWER_RAW_DESTROY_FAILED", {
            message: String(error && error.message ? error.message : error),
          });
        }
        return true;
      });
      return this.destroyPromise;
    }
  }

  function createActivationLeaseCoordinator(adapter, options) {
    return new ActivationLeaseCoordinator(adapter, options);
  }

  function createSourceMonitorViewerLeaseCoordinator(adapter, options) {
    return new SourceMonitorViewerLeaseCoordinator(adapter, options);
  }

  return Object.freeze({
    ActivationLeaseCoordinator,
    RuntimeCoordinationError,
    SourceMonitorViewerLeaseCoordinator,
    createActivationLeaseCoordinator,
    createSourceMonitorViewerLeaseCoordinator,
  });
});
