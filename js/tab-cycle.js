import { app } from "../../scripts/app.js";

/**
 * Tab Cycle - Cycle through number/slider widgets (only), within a single node, using Tab / Shift+Tab
 * ------------------
 * Node/widget identity is found via a mousedown hit-test on the canvas:
 * screen coords -> graph coords (using canvas pan/zoom transform) -> which
 * node's bounding box contains that point -> which widget row (via
 * widget.last_y, set by litegraph's own render pass).
 */

const DEBUG = false; // flip to true if you need to debug again
const log = (...args) => DEBUG && console.log("[tab-cycler]", ...args);

const ALLOWED_TYPES = new Set(["number", "slider"]);

const activeIndexMap = new WeakMap(); // node -> last active widget index
const dialogXMap = new WeakMap(); // node -> screen clientX of the original click
let currentNode = null; // last node hit via pointerdown on canvas

function getEligibleWidgets(node) {
    if (!node || !node.widgets) return [];
    return node.widgets.filter((w) => ALLOWED_TYPES.has(w.type) && !w.disabled && !w.hidden);
}

function getOpenDialog() {
    return document.querySelector(".graphdialog");
}

function commitOpenDialog() {
    const dialog = getOpenDialog();
    if (!dialog) return;
    const input = dialog.querySelector("input");
    if (!input) return;
    input.dispatchEvent(
        new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
        })
    );
}

function screenToGraph(clientX, clientY) {
    const canvas = app.canvas;
    const rect = canvas.canvas.getBoundingClientRect();
    const scale = canvas.ds.scale;
    const offset = canvas.ds.offset;
    const gx = (clientX - rect.left) / scale - offset[0];
    const gy = (clientY - rect.top) / scale - offset[1];
    log("screenToGraph:", { clientX, clientY, rectLeft: rect.left, rectTop: rect.top, scale, offset, gx, gy });
    return [gx, gy];
}

function findWidgetByLocalY(node, localY) {
    const candidates = (node.widgets || []).filter((w) => !w.hidden);
    if (!candidates.length) return null;
    const hasLastY = candidates.every((w) => typeof w.last_y === "number");
    log("findWidgetByLocalY:", { nodeTitle: node.title, localY, hasLastY, widgetYs: candidates.map((w) => ({ name: w.name, last_y: w.last_y })) });
    if (hasLastY) {
        let match = null;
        for (const w of candidates) {
            if (w.last_y <= localY) match = w;
            else break;
        }
        return match || candidates[0];
    }
    const titleHeight = (window.LiteGraph && LiteGraph.NODE_TITLE_HEIGHT) || 30;
    const rowHeight = (window.LiteGraph && LiteGraph.NODE_WIDGET_HEIGHT) || 20;
    const idx = Math.floor((localY - titleHeight) / rowHeight);
    return candidates[Math.max(0, Math.min(idx, candidates.length - 1))];
}

function findNodeAndWidgetAtPoint(clientX, clientY) {
    const canvas = app.canvas;
    const graph = canvas?.graph;
    if (!graph) {
        log("no canvas.graph!");
        return null;
    }

    const [gx, gy] = screenToGraph(clientX, clientY);
    const nodes = graph._nodes || [];
    log("checking", nodes.length, "nodes for hit; first few:", nodes.slice(0, 3).map((n) => ({ title: n.title, pos: n.pos, size: n.size })));

    for (const node of nodes) {
        const [nx, ny] = node.pos;
        const [w, h] = node.size;
        if (gx >= nx && gx <= nx + w && gy >= ny && gy <= ny + h) {
            const localY = gy - ny;
            const widget = findWidgetByLocalY(node, localY);
            return { node, widget };
        }
    }
    log("no node bounding box contained the click point");
    return null;
}

function hookNodeMouseDown(node) {
    if (node.__tabCyclerHooked) return;
    node.__tabCyclerHooked = true;
    const original = node.onMouseDown;
    node.onMouseDown = function (e, pos, canvas) {
        currentNode = node;
        const localY = pos ? pos[1] : null;
        log("node.onMouseDown:", node.title, "localY:", localY);
        if (localY != null) {
            const widget = findWidgetByLocalY(node, localY);
            log("hit widget:", widget?.name, widget?.type);
            if (widget && ALLOWED_TYPES.has(widget.type)) {
                const widgets = getEligibleWidgets(node);
                const idx = widgets.indexOf(widget);
                if (idx !== -1) activeIndexMap.set(node, idx);
                log("set activeIndexMap idx:", idx);
            }
        }
        return original?.apply(this, arguments);
    };
}

function buildFakeEventForWidget(node, widget) {
    const canvas = app.canvas;
    const rect = canvas.canvas.getBoundingClientRect();
    const scale = canvas.ds.scale;
    const offset = canvas.ds.offset;

    const localX = node.size[0] / 2;
    const localY = typeof widget.last_y === "number" ? widget.last_y : 40;

    const graphX = node.pos[0] + localX;
    const graphY = node.pos[1] + localY;

    // Prefer the x-position of the original real click, so the dialog
    // doesn't jump around horizontally as we cycle through widgets.
    const clientX = dialogXMap.has(node)
        ? dialogXMap.get(node)
        : rect.left + (graphX + offset[0]) * scale;
    const clientY = rect.top + (graphY + offset[1]) * scale;

    return { clientX, clientY, target: canvas.canvas };
}

function activateWidget(node, widget) {
    const fakeEvent = buildFakeEventForWidget(node, widget);

    app.canvas.prompt(
        "Value",
        widget.value,
        (v) => {
            widget.value = v;
            if (widget.callback) {
                widget.callback(widget.value, app.canvas, node, fakeEvent);
            }
            node.graph?.setDirtyCanvas(true, true);
        },
        fakeEvent
    );

    requestAnimationFrame(() => {
        const dialog = getOpenDialog();
        if (!dialog) return;
        const nameSpan = dialog.querySelector(".name");
        if (nameSpan) nameSpan.textContent = widget.name;
        const input = dialog.querySelector("input");
        if (input) {
            input.focus();
            input.select();
        }
    });
}

app.registerExtension({
    name: "tab.widget.cycler",
    async nodeCreated(node) {
        hookNodeMouseDown(node);
    },
    setup() {
        log("extension setup() ran");

        // Nodes already present (e.g. loaded from a saved workflow before
        // this extension registered) won't have gone through nodeCreated
        // for us, so hook them retroactively too.
        const existing = app.graph?._nodes || [];
        log("retroactively hooking", existing.length, "existing nodes");
        existing.forEach(hookNodeMouseDown);

        app.canvas.canvas.addEventListener(
            "pointerdown",
            (e) => {
                log("pointerdown fired at", e.clientX, e.clientY);
                const hit = findNodeAndWidgetAtPoint(e.clientX, e.clientY);
                if (!hit) {
                    log("pointerdown: no hit");
                    return;
                }
                currentNode = hit.node;
                log("pointerdown hit node:", hit.node.title, "widget:", hit.widget?.name, "widget.type:", hit.widget?.type);
                if (hit.widget && ALLOWED_TYPES.has(hit.widget.type)) {
                    const widgets = getEligibleWidgets(hit.node);
                    const idx = widgets.indexOf(hit.widget);
                    if (idx !== -1) activeIndexMap.set(hit.node, idx);
                    dialogXMap.set(hit.node, e.clientX);
                    log("set activeIndexMap idx:", idx);
                }
            },
            true
        );

        document.addEventListener(
            "keydown",
            (e) => {
                if (e.key !== "Tab") return;
                log("Tab keydown captured. currentNode:", currentNode?.title);

                const node = currentNode;
                if (!node) return;

                const widgets = getEligibleWidgets(node);
                log("eligible widgets:", widgets.map((w) => w.name));
                if (!widgets.length) return;

                const dialogOpen = !!getOpenDialog();
                log("dialogOpen:", dialogOpen);
                if (!dialogOpen) {
                    log("bailing: no dialog open");
                    return;
                }

                log("intercepting Tab");
                e.preventDefault();
                e.stopPropagation();

                let idx = activeIndexMap.has(node) ? activeIndexMap.get(node) : 0;
                log("current idx:", idx);

                commitOpenDialog();

                const dir = e.shiftKey ? -1 : 1;
                const nextIdx = (idx + dir + widgets.length) % widgets.length;
                activeIndexMap.set(node, nextIdx);
                log("advancing to idx:", nextIdx, widgets[nextIdx]?.name);

                requestAnimationFrame(() => activateWidget(node, widgets[nextIdx]));
            },
            true
        );
    },
});
