/**
 * Floating-window machinery for the DR webapp's plotter-extension host
 * (work doc #27, window phase): the `ui.*Window` methods, the `window`
 * context kind, the floating chrome (host-owned title bar, close
 * control, drag/resize), the `window.*` events, the modal plane, the
 * remembered geometry, and the window-flavored toolbar button actions.
 *
 * Everything here is a method of `PlotterExtHost`, assigned onto its
 * prototype by dr-ext-host.js (`Object.assign(PlotterExtHost.prototype,
 * WINDOW_METHODS)`) — `this` is the host instance. The pure geometry
 * and policy lives in `dr-ext-host-core.js`; this module is the
 * DOM/bus glue.
 *
 * Contract (Plotter Extensions API v1, *Windows*): a window shows one
 * of the extension's own iframe panels floating over the chart;
 * windows belong to the extension (any of its contexts manages them,
 * several at once); the host owns the chrome — title bar and a close
 * control the extension cannot remove — and reports the truth in
 * `bounds`/`area`. What the extension sends is a request; what the
 * host reports back is the state. Windows never survive a host
 * reload, and an extension leaving the collection loses its windows
 * without events (its contexts are gone).
 *
 * @file dr-ext-host-windows.js
 */

import * as core from "./dr-ext-host-core.js";
import { RPC_ERRORS, RpcError } from "./vendor/plotterext-bus/host.js";

/** Baseline sandbox for every extension iframe (fault containment,
 * not an adversarial boundary — install time is the trust decision).
 * Defined in core so every context kind agrees. */
const IFRAME_SANDBOX = core.IFRAME_SANDBOX;

/** z-index plane where normal windows float (above the app's control
 * layer, .dr-overlay at 1100); raises cycle within the plane. */
const WINDOW_Z_BASE = 1200;
const WINDOW_Z_SPAN = 90;
/** The modal plane: backdrop above every normal window, the modal
 * window itself above the backdrop. */
const WINDOW_Z_BACKDROP = 1300;
const WINDOW_Z_MODAL = 1310;

/**
 * @param {string} message
 * @returns {RpcError} `windows.badRequest` — invalid params (malformed
 * geometry, unknown anchor, a modal window asked to hide)
 */
function badRequest(message) {
  return new RpcError(message, {
    code: RPC_ERRORS.INVALID_PARAMS,
    reason: "windows.badRequest",
  });
}

/**
 * @param {string} panelId
 * @returns {RpcError} `UNKNOWN_PANEL` — no iframe panel with that id
 * in the caller's manifest
 */
function unknownPanel(panelId) {
  return new RpcError(`no panel "${panelId}" in the caller's manifest`, {
    code: RPC_ERRORS.HOST_ERROR,
    reason: "UNKNOWN_PANEL",
  });
}

/**
 * @param {string} windowId
 * @returns {RpcError} `windows.unknownId` — no open window with that
 * id belongs to the caller
 */
function unknownWindow(windowId) {
  return new RpcError(`no window "${windowId}" belongs to the caller`, {
    code: RPC_ERRORS.HOST_ERROR,
    reason: "windows.unknownId",
  });
}

/**
 * @returns {RpcError} `windows.limit` — the host will not open more
 * windows
 */
function windowLimit() {
  return new RpcError(`the host will not open more windows`, {
    code: RPC_ERRORS.HOST_ERROR,
    reason: "windows.limit",
  });
}

/**
 * @returns {RpcError} `windows.modalOpen` — another modal window is
 * already open
 */
function modalOpen() {
  return new RpcError(`another modal window is already open`, {
    code: RPC_ERRORS.HOST_ERROR,
    reason: "windows.modalOpen",
  });
}

export const WINDOW_METHODS = {
  // ---- window area and chrome -------------------------------------------

  /**
   * The window area: the part of the screen the host makes available
   * to windows. Ours is the app viewport itself (full-bleed chart
   * app); injectable for tests via the host's `getArea` option.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {{width: number, height: number}}
   */
  windowArea() {
    return this.getArea();
  },

  /**
   * Injects the window chrome styles (once) and hooks the viewport
   * resize (once) — windows must survive a resize/rotation re-clamped
   * and possibly re-presented.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {void}
   */
  ensureWindowLayer() {
    if (this.mount && !this.windowStyle) {
      const style = document.createElement("style");
      style.id = "dr-ext-windows-style";
      style.textContent = `
        .ext-window {
          position: absolute;
          display: flex;
          flex-direction: column;
          background: color-mix(in srgb, var(--bg-panel, #111414) 94%, transparent);
          border: 1px solid rgba(255, 255, 255, 0.14);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
          min-width: 0;
          min-height: 0;
        }
        .ext-window.fullscreen { border: 0; box-shadow: none; }
        .ext-window-bar {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 6px 4px 10px;
          background: color-mix(in srgb, var(--bg-panel, #111414) 60%, black);
          border-bottom: 1px solid rgba(255, 255, 255, 0.12);
          cursor: move;
          user-select: none;
          touch-action: none;
          flex: 0 0 auto;
        }
        .ext-window-title {
          flex: 1;
          font-size: 0.8rem;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--color-teal, #4b8b99);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ext-window-close {
          width: 24px;
          height: 24px;
          padding: 0;
          background: transparent;
          border: 1px solid rgba(255, 255, 255, 0.2);
          color: var(--text-main, #c4c4c4);
          font-size: 0.8rem;
          line-height: 1;
          cursor: pointer;
        }
        .ext-window-close:hover {
          background: var(--color-teal, #4b8b99);
          color: var(--bg-base, #080a0c);
        }
        .ext-window iframe {
          flex: 1;
          width: 100%;
          border: 0;
          background: transparent;
          min-height: 0;
        }
        .ext-window-handle {
          position: absolute;
          right: 0;
          bottom: 0;
          width: 16px;
          height: 16px;
          cursor: nwse-resize;
          touch-action: none;
        }
        .ext-window-handle::before {
          content: "";
          position: absolute;
          right: 3px;
          bottom: 3px;
          width: 8px;
          height: 8px;
          border-right: 1px solid var(--theme-color, #4b8b99);
          border-bottom: 1px solid var(--theme-color, #4b8b99);
        }
        .ext-window-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.5);
        }
      `;
      this.mount.appendChild(style);
      this.windowStyle = style;
    }
    if (!this.windowResizeOff && typeof globalThis.addEventListener === "function") {
      const onResize = () => this.syncWindowsToArea();
      globalThis.addEventListener("resize", onResize);
      this.windowResizeOff = () =>
        globalThis.removeEventListener("resize", onResize);
    }
  },

  // ---- the ui.*Window methods ---------------------------------------------

  /**
   * `ui.openWindow`: opens one of the caller's own iframe panels in a
   * new window and returns its state.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} ctx - the calling context
   * @param {object} params - openWindow params
   * @returns {object} the window state
   */
  openWindow(ctx, params) {
    return this.openWindowFor(ctx.extId, params);
  },

  /**
   * The openWindow body, addressable by extension id — the bus method
   * path passes a context, the toolbar-button path passes the button's
   * extension. Shared validation: panel existence, geometry, modal
   * rules, the host's window limit; `single` adopts an existing
   * window; a `restoreKey` the host remembers wins over the requested
   * geometry.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} extId
   * @param {object} params
   * @returns {object} the window state
   */
  openWindowFor(extId, params) {
    if (!params || typeof params !== "object") {
      throw badRequest("openWindow requires params");
    }
    const ext = this.compatible.get(extId);
    const panel = ext?.panels.find((pn) => pn.id === params.panel);
    if (!panel) throw unknownPanel(params?.panel);
    let geometry = null;
    if (params.geometry !== undefined) {
      geometry = core.parseWindowGeometry(params.geometry);
      if (!geometry) throw badRequest("malformed geometry");
    }
    const modal = params.modal === true;
    if (modal && (params.visible === false || params.userClose === "hide")) {
      throw badRequest("a modal window cannot hide");
    }
    if (modal && this.modalWindowId != null) throw modalOpen();
    if (params.single === true) {
      const existing = [...this.windowRecords.values()].find(
        (r) => r.extId === extId && r.panel.id === panel.id,
      );
      if (existing) {
        // Shown and raised; params and geometry of the call ignored.
        if (!existing.visible) this.showWindow(existing);
        this.raiseWindow(existing);
        return this.windowState(existing);
      }
    }
    if (this.windowRecords.size >= core.WINDOW_LIMIT) throw windowLimit();

    // Remembered geometry (restoreKey) replaces the requested geometry.
    const restoreKey =
      typeof params.restoreKey === "string" && params.restoreKey !== ""
        ? params.restoreKey
        : null;
    if (restoreKey) {
      const stored = core.parseWindowGeometry(
        this.geometryStore.get(extId, restoreKey),
      );
      if (stored) geometry = stored;
    }
    geometry ??= core.parseWindowGeometry({
      anchor: "top-right",
      offset: { x: 16, y: 16 },
      width: "40%",
      height: "40%",
    });

    const area = this.windowArea();
    const presentation = core.presentationFor(area.width);
    const bounds =
      presentation === "fullscreen"
        ? { x: 0, y: 0, width: area.width, height: area.height }
        : core.resolveWindowGeometry(geometry, area);
    const windowId = `w-${++this.windowSeq}`;
    const record = {
      windowId,
      extId,
      panel,
      title:
        typeof params.title === "string" && params.title !== ""
          ? params.title
          : (panel.title ?? panel.id),
      // Plain JSON handed to the window in its handshake.
      params:
        params.params && typeof params.params === "object"
          ? JSON.parse(JSON.stringify(params.params))
          : {},
      modal,
      movable: params.movable !== false,
      resizable: params.resizable !== false,
      userClose: params.userClose === "hide" ? "hide" : "close",
      restoreKey,
      // The normalized request — what presentation changes re-resolve.
      geometry,
      bounds,
      area,
      presentation,
      visible: params.visible !== false,
      collapsed: false,
      poppedOut: false,
      el: null,
      titleEl: null,
      iframe: null,
    };

    this.makeWindowEl(record);
    const ctx = {
      kind: "window",
      extId,
      id: panel.id,
      instanceId: null,
      targetInstance: null,
      targetWidget: null,
      windowId,
      params: record.params,
      manifestEntry: panel,
      iframe: record.iframe,
      dialog: null,
      conn: null,
    };
    this.windowCtxs.set(windowId, ctx);
    this.allCtxs.add(ctx);
    this.connectCtx(ctx);
    this.windowRecords.set(windowId, record);
    if (modal) this.beginModal(record);
    if (record.visible) {
      this.raiseWindow(record);
    } else {
      this.applyVisibility(record);
    }
    return this.windowState(record);
  },

  /**
   * `ui.updateWindow`: changes a window — title, geometry (fields
   * given replace, others keep), visibility — and returns its state.
   * In a `window` context the windowId may be omitted to mean the
   * window itself.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} ctx
   * @param {object} params
   * @returns {object} the new window state
   */
  updateWindow(ctx, params) {
    const record = this.resolveWindow(ctx, params?.windowId);
    if (params.title !== undefined) {
      if (typeof params.title !== "string") {
        throw badRequest("title must be a string");
      }
      if (record.title !== params.title) {
        record.title = params.title;
        if (record.titleEl) record.titleEl.textContent = params.title;
        this.publishWindowState(record);
      }
    }
    if (params.geometry !== undefined) {
      const patch = core.parseWindowGeometry({
        ...geometryRequest(record.geometry),
        ...geometryPatch(params.geometry),
      });
      if (!patch) throw badRequest("malformed geometry");
      record.geometry = patch;
      if (record.presentation === "floating") {
        record.bounds = core.resolveWindowGeometry(patch, record.area);
        this.applyBounds(record);
        this.settleGeometry(record);
      }
      // Other presentations ignore geometry (the spec's rule); the
      // stored request still applies when floating resumes.
    }
    if (params.visible !== undefined) {
      if (typeof params.visible !== "boolean") {
        throw badRequest("visible must be a boolean");
      }
      if (record.modal && !params.visible) {
        throw badRequest("a modal window cannot hide");
      }
      record.visible = params.visible;
      this.applyVisibility(record);
      this.publishWindowState(record);
    }
    return this.windowState(record);
  },

  /**
   * `ui.focusWindow`: raises a window above the other windows. A
   * request — it does not show a hidden window.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} ctx
   * @param {object} params
   * @returns {{}}
   */
  focusWindow(ctx, params) {
    const record = this.resolveWindow(ctx, params?.windowId);
    this.raiseWindow(record);
    return {};
  },

  /**
   * `ui.closeWindow`: closes a window; its page unloads. In a
   * `window` context the windowId may be omitted — a window can close
   * itself.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} ctx
   * @param {object} params
   * @returns {{}}
   */
  closeWindow(ctx, params) {
    const record = this.resolveWindow(ctx, params?.windowId);
    this.teardownWindow(record.windowId, "extension");
    return {};
  },

  /**
   * `ui.listWindows`: every open window of the caller's extension,
   * hidden ones included.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} ctx
   * @returns {{windows: object[]}}
   */
  listWindows(ctx) {
    const windows = [];
    for (const record of this.windowRecords.values()) {
      if (record.extId !== ctx.extId) continue;
      windows.push(this.windowState(record));
    }
    return { windows };
  },

  // ---- window records -----------------------------------------------------

  /**
   * Resolves a windowId (or the omitted self-form) to a window record
   * belonging to the caller's extension.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} ctx - the calling context
   * @param {string|undefined|null} windowId
   * @returns {object} the window record
   */
  resolveWindow(ctx, windowId) {
    if (windowId === undefined || windowId === null) {
      if (ctx.kind === "window" && ctx.windowId != null) {
        const self = this.windowRecords.get(ctx.windowId);
        if (self && self.extId === ctx.extId) return self;
      }
      throw badRequest("no windowId and the caller is not a window");
    }
    const record = this.windowRecords.get(windowId);
    if (!record || record.extId !== ctx.extId) throw unknownWindow(windowId);
    return record;
  },

  /**
   * The public state of a window (the one shape openWindow,
   * updateWindow, listWindows and window.state all speak).
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} record
   * @returns {object}
   */
  windowState(record) {
    return {
      windowId: record.windowId,
      panel: record.panel.id,
      title: record.title,
      presentation: record.presentation,
      bounds: { ...record.bounds },
      area: { ...record.area },
      visible: record.visible,
      collapsed: false,
      poppedOut: false,
      modal: record.modal,
    };
  },

  // ---- chrome lifecycle ---------------------------------------------------

  /**
   * Builds the floating chrome for a window record: host-owned title
   * bar (title + the close control the extension cannot remove), the
   * panel iframe, the resize handle. Appends to the host mount — the
   * app's shadow root, so theme tokens apply.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} record
   * @returns {void}
   */
  makeWindowEl(record) {
    this.ensureWindowLayer();
    const el = document.createElement("div");
    el.className = "ext-window";
    const bar = document.createElement("div");
    bar.className = "ext-window-bar";
    const title = document.createElement("span");
    title.className = "ext-window-title";
    title.textContent = record.title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ext-window-close";
    // The host decides how the control looks in each mode: an en dash
    // reads as "send away" where a cross would read as "destroy".
    close.textContent = record.userClose === "hide" ? "–" : "✕";
    close.title = record.userClose === "hide" ? "Hide window" : "Close window";
    close.setAttribute(
      "aria-label",
      record.userClose === "hide" ? "Hide window" : "Close window",
    );
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.userCloseWindow(record);
    });
    bar.append(title, close);
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", IFRAME_SANDBOX);
    iframe.setAttribute("title", record.title);
    iframe.src = new URL(record.panel.url, this.origin).href;
    el.append(bar, iframe);
    if (record.resizable) {
      const handle = document.createElement("div");
      handle.className = "ext-window-handle";
      el.appendChild(handle);
      this.wireResize(record, handle);
      record.handle = handle;
    }
    // Any interaction raises the window.
    el.addEventListener("pointerdown", () => this.raiseWindow(record), true);
    if (record.movable) this.wireDrag(record, bar);
    this.mount.appendChild(el);
    record.el = el;
    record.titleEl = title;
    record.iframe = iframe;
    this.applyBounds(record);
    this.applyVisibility(record);
  },

  /**
   * The close control: what the user's close control does — close the
   * window, or hide it (`userClose: "hide"`), so a toolbar button can
   * bring it back as it was.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} record
   * @returns {void}
   */
  userCloseWindow(record) {
    if (record.userClose === "hide") {
      record.visible = false;
      this.applyVisibility(record);
      this.publishWindowState(record);
      return;
    }
    this.teardownWindow(record.windowId, "user");
  },

  /**
   * Shows a window (visible, raised) and reports the state change.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} record
   * @returns {void}
   */
  showWindow(record) {
    record.visible = true;
    this.applyVisibility(record);
    this.raiseWindow(record);
    this.publishWindowState(record);
  },

  /**
   * Raises a window above the other windows (a raise counter cycling
   * inside the window plane; the modal plane lives above both).
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} record
   * @returns {void}
   */
  raiseWindow(record) {
    if (!record.el) return;
    const z = record.modal
      ? WINDOW_Z_MODAL
      : WINDOW_Z_BASE + (this.windowZ++ % WINDOW_Z_SPAN);
    record.el.style.zIndex = String(z);
  },

  /**
   * Applies visibility to the chrome: hidden windows stay loaded and
   * running, out of sight.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} record
   * @returns {void}
   */
  applyVisibility(record) {
    if (!record.el) return;
    record.el.style.display = record.visible ? "flex" : "none";
  },

  /**
   * Applies the record's bounds to the chrome.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} record
   * @returns {void}
   */
  applyBounds(record) {
    if (!record.el) return;
    const { x, y, width, height } = record.bounds;
    record.el.style.left = `${x}px`;
    record.el.style.top = `${y}px`;
    record.el.style.width = `${width}px`;
    record.el.style.height = `${height}px`;
    record.el.classList.toggle("fullscreen", record.presentation === "fullscreen");
  },

  /**
   * A settled geometry change: persist the remembered geometry (when
   * the window has a restoreKey) and publish `window.bounds` — once
   * per change, never continuously during a drag.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} record
   * @returns {void}
   */
  settleGeometry(record) {
    if (record.restoreKey) {
      this.geometryStore.set(
        record.extId,
        record.restoreKey,
        core.geometryFromBounds(
          record.bounds,
          record.area,
          record.geometry.anchor,
        ),
      );
    }
    this.publishToExtension(record.extId, "window.bounds", {
      windowId: record.windowId,
      bounds: { ...record.bounds },
      area: { ...record.area },
    });
  },

  /**
   * Publishes the full window state (visibility, presentation or
   * title changed).
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} record
   * @returns {void}
   */
  publishWindowState(record) {
    this.publishToExtension(record.extId, "window.state", this.windowState(record));
  },

  /**
   * Wires the title-bar drag (floating, movable windows): the frame
   * follows the pointer live (clamped), `window.bounds` publishes once
   * when the pointer settles.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} record
   * @param {HTMLElement} bar - the title bar
   * @returns {void}
   */
  wireDrag(record, bar) {
    bar.addEventListener("pointerdown", (e) => {
      // The close control is not a drag handle.
      if (e.target.closest("button")) return;
      if (record.presentation !== "floating") return;
      const startX = e.clientX;
      const startY = e.clientY;
      const orig = { ...record.bounds };
      bar.setPointerCapture?.(e.pointerId);
      const move = (ev) => {
        const area = this.windowArea();
        record.area = area;
        record.bounds = core.clampWindowBounds(
          {
            x: orig.x + (ev.clientX - startX),
            y: orig.y + (ev.clientY - startY),
            width: orig.width,
            height: orig.height,
          },
          area,
        );
        this.applyBounds(record);
      };
      const up = () => {
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
        bar.removeEventListener("pointercancel", up);
        this.settleGeometry(record);
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
      bar.addEventListener("pointercancel", up);
    });
  },

  /**
   * Wires the south-east resize handle (floating, resizable windows):
   * same settle-then-publish rhythm as the drag.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} record
   * @param {HTMLElement} handle
   * @returns {void}
   */
  wireResize(record, handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (record.presentation !== "floating") return;
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const orig = { ...record.bounds };
      handle.setPointerCapture?.(e.pointerId);
      const move = (ev) => {
        const area = this.windowArea();
        record.area = area;
        record.bounds = core.clampWindowBounds(
          {
            x: orig.x,
            y: orig.y,
            width: orig.width + (ev.clientX - startX),
            height: orig.height + (ev.clientY - startY),
          },
          area,
        );
        this.applyBounds(record);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        this.settleGeometry(record);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  },

  /**
   * The viewport changed size/rotation: re-evaluate every window's
   * presentation, re-clamp floating bounds, publish what changed.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {void}
   */
  syncWindowsToArea() {
    if (this.windowRecords.size === 0) return;
    const area = this.windowArea();
    for (const record of this.windowRecords.values()) {
      const presentation = core.presentationFor(area.width);
      const wasVisibleBounds = { ...record.bounds };
      if (presentation !== record.presentation) {
        record.presentation = presentation;
        record.bounds =
          presentation === "fullscreen"
            ? { x: 0, y: 0, width: area.width, height: area.height }
            : core.resolveWindowGeometry(record.geometry, area);
        this.publishWindowState(record);
      } else if (presentation === "floating") {
        const clamped = core.clampWindowBounds(record.bounds, area);
        record.bounds = clamped;
      } else {
        record.bounds = { x: 0, y: 0, width: area.width, height: area.height };
      }
      record.area = area;
      this.applyBounds(record);
      if (
        wasVisibleBounds.x !== record.bounds.x ||
        wasVisibleBounds.y !== record.bounds.y ||
        wasVisibleBounds.width !== record.bounds.width ||
        wasVisibleBounds.height !== record.bounds.height
      ) {
        this.settleGeometry(record);
      }
    }
  },

  // ---- modal plane ----------------------------------------------------------

  /**
   * Puts a modal window up: a backdrop blocking the chart and every
   * other window, Escape dismissing the window (the user can always
   * dismiss it). The host's own controls stay above nothing we have —
   * this webapp carries no always-on safety UI, and the close control
   * plus Escape are always live.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} record
   * @returns {void}
   */
  beginModal(record) {
    this.modalWindowId = record.windowId;
    if (this.mount) {
      const backdrop = document.createElement("div");
      backdrop.className = "ext-window-backdrop";
      backdrop.style.zIndex = String(WINDOW_Z_BACKDROP);
      this.mount.appendChild(backdrop);
      this.modalBackdrop = backdrop;
    }
    if (typeof document !== "undefined") {
      const esc = (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        this.teardownWindow(record.windowId, "user");
      };
      document.addEventListener("keydown", esc, true);
      this.modalEscapeOff = () =>
        document.removeEventListener("keydown", esc, true);
    }
  },

  /**
   * Takes a modal window down (the backdrop and Escape handler ride
   * with it).
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {void}
   */
  endModal() {
    this.modalWindowId = null;
    this.modalBackdrop?.remove();
    this.modalBackdrop = null;
    this.modalEscapeOff?.();
    this.modalEscapeOff = null;
  },

  // ---- teardown -------------------------------------------------------------

  /**
   * Closes a window: its page unloads, its context dies.
   * `reason` publishes `window.closed` to the owning extension's
   * subscribed contexts (`user`, `extension` or `host`); null closes
   * silently (the extension left the collection — none of its
   * contexts remain).
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} windowId
   * @param {string|null} reason
   * @returns {void}
   */
  teardownWindow(windowId, reason) {
    const record = this.windowRecords.get(windowId);
    if (!record) return;
    this.windowRecords.delete(windowId);
    for (const [key, wid] of [...this.buttonWindows]) {
      if (wid === windowId) this.buttonWindows.delete(key);
    }
    if (this.modalWindowId === windowId) this.endModal();
    if (reason != null) {
      this.publishToExtension(record.extId, "window.closed", {
        windowId,
        reason,
      });
    }
    const ctx = this.windowCtxs.get(windowId);
    if (ctx) {
      this.releaseCtx(ctx);
      this.windowCtxs.delete(windowId);
    }
    record.el?.remove();
  },

  /**
   * Closes every window of an extension that left the collection —
   * silently, per the spec: its contexts are gone, no event is sent.
   * The remembered geometry goes with it (a returning extension
   * starts fresh, like the overlay state store).
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} extId
   * @returns {void}
   */
  closeWindowsFor(extId) {
    let any = false;
    for (const record of [...this.windowRecords.values()]) {
      if (record.extId !== extId) continue;
      any = true;
      this.teardownWindow(record.windowId, null);
    }
    if (any) this.geometryStore.dropExtension(extId);
  },

  // ---- toolbar buttons ------------------------------------------------------

  /**
   * Runs a manifest button's `openWindow` / `toggleWindow` action: a
   * button keeps track of the window it opened — while it is open,
   * pressing again shows and raises it (`openWindow`) or does what the
   * window's own close control does (`toggleWindow`).
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} extId
   * @param {object} button
   * @param {{type: string, panel: string}} action - the rest of the
   * action object is ui.openWindow options
   * @returns {void}
   */
  runWindowButton(extId, button, action) {
    const key = `${extId}/${button.id}`;
    const windowId = this.buttonWindows.get(key);
    const record = windowId != null ? this.windowRecords.get(windowId) : null;
    if (record) {
      if (!record.visible) {
        this.showWindow(record);
      } else if (action.type === "toggleWindow") {
        // What the window's own close control does.
        if (record.userClose === "hide") {
          record.visible = false;
          this.applyVisibility(record);
          this.publishWindowState(record);
        } else {
          this.teardownWindow(record.windowId, "user");
        }
      } else {
        this.raiseWindow(record);
      }
      return;
    }
    const { type: _type, ...rest } = action;
    try {
      const state = this.openWindowFor(extId, rest);
      this.buttonWindows.set(key, state.windowId);
    } catch (err) {
      // A button action has no reply channel; a bad manifest entry is
      // a console matter, not a crash.
      console.warn("[plotterext]", extId, button.id, err);
    }
  },
};

/**
 * A normalized geometry record back into request form (what a
 * geometry patch merges against).
 *
 * @param {object} g - normalized geometry
 * @returns {object}
 */
function geometryRequest(g) {
  const len = (l) => (l ? (l.unit === "pct" ? `${l.v}%` : l.v) : undefined);
  return {
    anchor: g.anchor,
    offset: { x: len(g.offsetX) ?? 0, y: len(g.offsetY) ?? 0 },
    width: len(g.width),
    height: len(g.height),
    minWidth: len(g.minWidth),
    minHeight: len(g.minHeight),
    maxWidth: len(g.maxWidth),
    maxHeight: len(g.maxHeight),
  };
}

/**
 * A `updateWindow` geometry patch: present fields only, absent ones
 * keep their current values (undefined drops out of the merge).
 *
 * @param {object} patch - the caller's partial geometry
 * @returns {object}
 */
function geometryPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw badRequest("malformed geometry");
  }
  if ("anchor" in patch) out.anchor = patch.anchor;
  if (patch.offset !== undefined) {
    out.offset = patch.offset;
  }
  for (const field of [
    "width",
    "height",
    "minWidth",
    "minHeight",
    "maxWidth",
    "maxHeight",
  ]) {
    if (patch[field] !== undefined) out[field] = patch[field];
  }
  return out;
}
