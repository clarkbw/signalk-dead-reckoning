/**
 * Plotter-extension host integration (Freeboard-SK and any Plotter
 * Extensions API v1 chart plotter).
 *
 * Two server-side responsibilities (see freeboard-sk
 * docs/api/plotter_extension_provider_plugins.md):
 *
 * 1. Register a read-only `plotterExtensions` resource provider whose
 *    single entry is this plugin's manifest — the host discovers the
 *    extension there. Presence in the collection *is* the enablement
 *    signal: hosts must not add a second per-extension gate, and the
 *    provider goes empty on plugin stop so the host tears the contexts
 *    down.
 * 2. Serve the extension's iframe assets at a publicly readable,
 *    non-admin-gated route. `/plugins/*` is admin-only on the server, so
 *    the manifest URLs point at a self-mounted namespaced prefix instead.
 *    The assets are inert UI code — all data flows over the host bus.
 *    Served by a minimal in-repo static handler rather than
 *    `express.static`: the plugin is zero-dependency by design (SPEC §2)
 *    and `express` is not resolvable from a plugin's own tree — only
 *    from inside the server. The handler only needs to serve the small,
 *    known-good set of files under `public/`.
 *
 * @file plotterext.js
 */

const path = require("node:path");
const fs = require("node:fs");
const pkg = require("../package.json");

/**
 * Directory holding the extension's iframe assets. The same `public/`
 * the standalone webapp is served from (the webapp keyword mounts it at
 * the package path); the extension entry pages live alongside the ES
 * modules they import, so relative imports keep working under either
 * mount.
 */
const PUBLIC_DIR = path.join(__dirname, "..", "public");

/** Content types for the extension's asset kinds (inert UI code). */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Builds the extension manifest.
 *
 * `requires` lists only what the extension cannot run without *at
 * all* — and stays at the Freeboard 3.0 surface so the status tile is
 * offered everywhere: on a host without a later capability the
 * contributions that need it are simply omitted (unknown sections
 * ignored, unsupported overlay types dropped) while the rest keeps
 * working. Concretely:
 *
 * - any host: `dr-status` widget
 * - Freeboard ≥ 3.0/3.3: + Sight/Fix panel (window on 3.3, drawer
 *   fallback earlier), toolbar buttons (override engage/release),
 *   the chartwork background runtime
 * - Freeboard ≥ 3.4: + `overlays.data` chartwork layer, context-menu
 *   sight actions, map picks, interactive overlay features
 *
 * Everything the runtime can probe is in `optional`; the code guards
 * each with `hasCapability`.
 *
 * @param {string} assetBase - server-relative URL prefix for assets
 * @param {string} version - plugin version for display metadata
 * @returns {object} manifest per the Plotter Extensions API v1
 */
function buildManifest(assetBase, version) {
  return {
    name: "Dead Reckoning",
    description:
      "Dead reckoning in the plotter: status tile, sight/LoP entry with fix resolution, chartwork overlay (tracks, LoPs, fixes, uncertainty) and DR override control.",
    version,
    apiVersion: "1",
    requires: [
      "widgets",
      "panels.iframe",
      "signalk.stream",
      "buttons",
      "background.iframe",
    ],
    optional: [
      "overlays.data",
      "actions",
      "actions.overlay",
      "map",
      "map.pick",
      "windows",
      "buttons.visibility",
      "events.publish",
      "nightMode",
      "units",
      "signalk.put",
    ],
    widgets: [
      {
        id: "dr-status",
        title: "Dead Reckoning",
        type: "iframe",
        url: `${assetBase}/dr-ext-widget.html`,
        size: "2x1",
        lifecycle: "whileEnabled",
      },
    ],
    background: [
      {
        id: "chartwork",
        title: "DR chartwork",
        type: "iframe",
        url: `${assetBase}/dr-ext-runtime.html`,
      },
    ],
    panels: [
      {
        id: "sight",
        title: "DR Sight / Fix",
        type: "iframe",
        url: `${assetBase}/dr-ext-panel.html`,
        lifecycle: "keepAlive",
      },
      {
        // The same page, pending-only: the split keeps sight entry and
        // the observation worklist apart (review feedback) — this one
        // only earns a toolbar button while observations are pending.
        id: "pending",
        title: "DR Pending observations",
        type: "iframe",
        url: `${assetBase}/dr-ext-panel.html?view=pending`,
        lifecycle: "keepAlive",
      },
    ],
    buttons: [
      {
        id: "open-sight",
        title: "DR Sight / Fix",
        slot: "mapToolbar",
        icon: "explore",
        action: {
          type: "toggleWindow",
          panel: "sight",
          title: "DR Sight / Fix",
          geometry: { anchor: "top-right", width: 400, height: "80%" },
          single: true,
          restoreKey: "sight",
        },
      },
      {
        id: "override-engage",
        title: "Engage DR override",
        slot: "mapToolbar",
        icon: "swap_horizontal_circle",
        visible: true,
        action: {
          type: "publish",
          topic: "signalk-dead-reckoning.override",
          params: { active: true },
          scope: "extension",
        },
      },
      {
        id: "override-release",
        title: "Release DR override",
        slot: "mapToolbar",
        icon: "gps_off",
        visible: false,
        action: {
          type: "publish",
          topic: "signalk-dead-reckoning.override",
          params: { active: false },
          scope: "extension",
        },
      },
      {
        id: "confirm-fix",
        title: "Confirm DR fix",
        slot: "mapToolbar",
        icon: "where_to_vote",
        visible: false,
        action: {
          type: "publish",
          topic: "signalk-dead-reckoning.confirm",
          scope: "extension",
        },
      },
      {
        id: "open-pending",
        title: "DR Pending observations",
        slot: "mapToolbar",
        icon: "fact_check",
        visible: false,
        action: {
          type: "toggleWindow",
          panel: "pending",
          title: "DR Pending observations",
          geometry: { anchor: "bottom-right", width: 380, height: "90%" },
          restoreKey: "pending-v2",
        },
      },
      {
        // The bootstrap fix: confirm the GNSS position as a fix, which
        // resets the DR origin (a months-old origin from a test server
        // must not veto the first real fix). Shown while a GNSS
        // position is available.
        id: "confirm-gnss",
        title: "Confirm GNSS fix",
        slot: "mapToolbar",
        icon: "my_location",
        visible: false,
        action: {
          type: "publish",
          topic: "signalk-dead-reckoning.confirm-gnss",
          scope: "extension",
        },
      },
    ],
    actions: [
      {
        id: "sight-bearing",
        title: "Bearing sight of this",
        icon: "explore",
        targets: ["position", "chartFeature", "waypoint", "aton"],
        action: {
          type: "openWindow",
          panel: "sight",
          params: { mode: "bearing" },
          geometry: { anchor: "top-right", width: 400, height: "90%" },
          restoreKey: "sight-bearing",
          single: true,
        },
      },
      {
        id: "sight-vertical",
        title: "Vertical angle to this",
        icon: "straighten",
        targets: ["position", "chartFeature", "waypoint", "aton"],
        action: {
          type: "openWindow",
          panel: "sight",
          params: { mode: "vertical" },
          geometry: { anchor: "top-right", width: 400, height: "90%" },
          restoreKey: "sight-vertical",
          single: true,
        },
      },
      {
        id: "sight-radar",
        title: "Radar range to this",
        icon: "radar",
        targets: ["position", "chartFeature", "waypoint", "aton"],
        action: {
          type: "openWindow",
          panel: "sight",
          params: { mode: "radar" },
          geometry: { anchor: "top-right", width: 400, height: "90%" },
          restoreKey: "sight-radar",
          single: true,
        },
      },
      {
        id: "sight-hangle",
        title: "Horizontal angle to this",
        icon: "architecture",
        targets: ["position", "chartFeature", "waypoint", "aton"],
        action: {
          type: "openWindow",
          panel: "sight",
          params: { mode: "hangle" },
          geometry: { anchor: "top-right", width: 400, height: "90%" },
          restoreKey: "sight-hangle",
          single: true,
        },
      },
      {
        id: "sight-edit",
        title: "Edit this observation",
        icon: "edit",
        targets: [
          {
            kind: "overlayFeature",
            overlays: ["chartwork"],
            match: [{ path: "id", op: "regex", value: "^(lop|cpl):" }],
          },
        ],
        action: {
          type: "openWindow",
          panel: "sight",
          geometry: { anchor: "top-right", width: 400, height: "90%" },
          single: true,
          restoreKey: "sight",
        },
      },
      {
        // The chart-driven confirm: right-click / popover action on the
        // candidate ring. (The ring's primary select opens the
        // resolution window — see review-fix below.)
        id: "confirm-fix",
        title: "Confirm fix here",
        icon: "where_to_vote",
        targets: [
          {
            kind: "overlayFeature",
            overlays: ["chartwork"],
            match: [{ path: "id", op: "regex", value: "^candidate$" }],
          },
        ],
        action: {
          type: "publish",
          topic: "signalk-dead-reckoning.confirm",
          scope: "extension",
        },
      },
      {
        // Clicking the candidate ring goes back to the fix resolution:
        // the pending window is where the candidate's numbers and the
        // confirm button live (work doc #38 review).
        id: "review-fix",
        title: "Review this fix",
        icon: "fact_check",
        default: true,
        targets: [
          {
            kind: "overlayFeature",
            overlays: ["chartwork"],
            match: [{ path: "id", op: "regex", value: "^candidate$" }],
          },
        ],
        action: {
          type: "openWindow",
          panel: "pending",
          geometry: { anchor: "bottom-right", width: 380, height: "90%" },
          single: true,
          restoreKey: "pending-v2",
        },
      },
      {
        // Chart-driven one-observation resolve (running fix): offered
        // only on unresolved observations; the runtime hides the whole
        // action when no previous confirmed fix exists to advance from.
        id: "resolve-from",
        title: "Resolve fix from this",
        icon: "gps_fixed",
        targets: [
          {
            kind: "overlayFeature",
            overlays: ["chartwork"],
            match: [
              { path: "id", op: "regex", value: "^(lop|cpl):" },
              { path: "properties.used", op: "eq", value: false },
              // Unresolved AND fresh — the runtime stamps stale on
              // features past the pending list's 24 h rule; a
              // month-old position line must not offer a month-long
              // advance.
              { path: "properties.stale", op: "eq", value: false },
            ],
          },
        ],
        action: {
          type: "publish",
          topic: "signalk-dead-reckoning.resolve",
          scope: "extension",
        },
      },
      {
        id: "delete-observation",
        title: "Delete this observation",
        icon: "delete",
        targets: [
          {
            kind: "overlayFeature",
            overlays: ["chartwork"],
            match: [{ path: "id", op: "regex", value: "^(lop|cpl):" }],
          },
        ],
        action: {
          type: "publish",
          topic: "signalk-dead-reckoning.delete",
          scope: "extension",
        },
      },
    ],
    overlays: [
      {
        id: "chartwork",
        title: "DR chartwork",
        type: "data",
        band: "aboveResources",
        visible: true,
        opacity: 1,
        interactive: true,
        interactiveLayers: [
          "dr-lop",
          "dr-lop-used",
          "dr-cpl",
          "dr-cpl-used",
          "dr-fix",
          "dr-candidate",
          "dr-candidate-dot",
        ],
        titleProperty: "name",
        style: `${assetBase}/dr-ext-overlay-style.json`,
      },
    ],
  };
}

/**
 * Minimal static-asset middleware for the extension's files. Not a
 * general file server: only regular files directly under `root` are
 * served (directory indexes and anything escaping `root` fall through).
 *
 * @param {string} root - absolute directory to serve
 * @param {string} assetBase - mount prefix, stripped when the host did
 *   not already strip it (Express strips it for `app.use(path, fn)`;
 *   other hosts may pass the full path)
 * @returns {(req: object, res: object, next: Function) => void}
 */
function staticAssetHandler(root, assetBase) {
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  return (req, res, next) => {
    let urlPath = req.path ?? req.url ?? "/";
    const q = urlPath.indexOf("?");
    if (q >= 0) urlPath = urlPath.slice(0, q);
    if (urlPath.startsWith(assetBase)) {
      urlPath = urlPath.slice(assetBase.length);
    }
    if (!urlPath.startsWith("/")) urlPath = `/${urlPath}`;

    let resolved;
    try {
      resolved = path.normalize(
        path.join(rootPrefix, decodeURIComponent(urlPath)),
      );
    } catch {
      next(); // malformed percent-encoding
      return;
    }
    // Traversal guard: the resolved path must stay inside root.
    if (!resolved.startsWith(rootPrefix)) {
      next();
      return;
    }

    fs.stat(resolved, (err, st) => {
      if (err || !st.isFile()) {
        next();
        return;
      }
      // Code assets must never be served stale: the manifest (fresh via
      // the resources API) can promise features the cached iframe code
      // behind it predates — a one-hour max-age once shipped a taller
      // window around last week's JS. `no-cache` revalidates every
      // load; the validators below make that a cheap 304 when nothing
      // changed. Only rarely-changing binaries keep a lifetime.
      const ext = path.extname(resolved);
      const cacheable = ext === ".png" || ext === ".svg" || ext === ".ico";
      const etag = `"${st.size}-${st.mtimeMs}"`;
      const lastModified = st.mtime.toUTCString();
      res.setHeader("ETag", etag);
      res.setHeader("Last-Modified", lastModified);
      res.setHeader(
        "Cache-Control",
        cacheable ? "public, max-age=3600" : "no-cache",
      );
      // Revalidation: a matching If-None-Match (any weak/strong
      // comparison — browsers send the ETag back verbatim) or an
      // If-Modified-Since no older than the file answers 304, body
      // skipped.
      const inm = req.headers?.["if-none-match"];
      const ims = req.headers?.["if-modified-since"];
      const imsTime = ims == null ? NaN : Date.parse(ims);
      const notModified =
        inm
          ?.split(",")
          .some((t) => t.trim() === etag || t.trim() === `W/${etag}`) ||
        (inm == null &&
          Number.isFinite(imsTime) &&
          st.mtime.getTime() <= imsTime);
      if (notModified) {
        res.statusCode = 304;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
      fs.readFile(resolved, (readErr, data) => {
        if (readErr) {
          next();
          return;
        }
        res.end(data);
      });
    });
  };
}

/**
 * Registers the plotter-extension provider and mounts the asset route.
 *
 * @param {import("@signalk/server-api").ServerAPI} app - Signal K server API
 * @param {{id: string, version?: string}} opts - plugin id (manifest key)
 *   and optional version override (defaults to the package version)
 * @returns {() => void} teardown — empties the provider's listing so
 *   hosts unload the extension's contexts. The static asset mount stays
 *   (Express has no unmount, and the files are inert); that matches the
 *   webapp keyword's behaviour for a disabled plugin.
 */
function registerPlotterExtension(app, opts) {
  const { id } = opts;
  const version = opts.version ?? pkg.version;
  const assetBase = `/plotterext/${id}`;
  const manifest = buildManifest(assetBase, version);
  let running = true;

  app.registerResourceProvider({
    type: "plotterExtensions",
    methods: {
      listResources: async () => (running ? { [id]: manifest } : {}),
      getResource: async (resourceId) => {
        if (!running || resourceId !== id) {
          throw new Error(`No such plotterExtensions resource: ${resourceId}`);
        }
        return manifest;
      },
      setResource: async () => {
        throw new Error(`${id} is a read-only provider`);
      },
      deleteResource: async () => {
        throw new Error(`${id} is a read-only provider`);
      },
    },
  });

  app.use(assetBase, staticAssetHandler(PUBLIC_DIR, assetBase));

  return () => {
    running = false;
  };
}

module.exports = {
  buildManifest,
  registerPlotterExtension,
  staticAssetHandler,
};
