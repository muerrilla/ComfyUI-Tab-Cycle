import { app } from "../../scripts/app.js";

/**
 * Tab Cycle Enhanced - WASD node navigation + Q/E widget highlight + R action
 *
 * WASD: Navigate between nodes (W=up, A=left, S=down, D=right)
 *   Viewport auto-centers on the selected node.
 *
 * Q/E: Cycle highlight among eligible widgets (Q=prev, E=next).
 *   - number/slider: highlighted with orange dashed border
 *   - boolean/toggle, combo/dropdown: highlighted with orange dashed border
 *   - text/string: skipped entirely (not eligible)
 *
 * R: Execute action on the currently highlighted widget:
 *   - number/slider: open litegraph inline prompt dialog
 *   - boolean/toggle: toggle value
 *   - combo/dropdown: cycle to next option
 *   - when a dialog is already open: commit (Enter) and close
 *
 * Clicking a node/widget sets it as active and highlights the clicked widget.
 */

const DEBUG = false;
const log = (...args) => DEBUG && console.log("[tab-cycle]", ...args);

// ---- state ----
let currentNode = null;
let activeCycleIdx = 0; // index into getCycleWidgets(currentNode)

// Per-node highlight index (into getCycleWidgets). -1 = no highlight.
const highlightMap = new WeakMap();

function getHl(node) {
    const v = highlightMap.get(node);
    return v !== undefined ? v : -1;
}
function setHl(node, idx) {
    highlightMap.set(node, idx);
    node?.graph?.setDirtyCanvas(true, true);
}
function clearHl(node) {
    highlightMap.delete(node);
    node?.graph?.setDirtyCanvas(true, true);
}

// ---- widget type helpers ----
function isNumberWidget(w)   { const t = (w.type || "").toLowerCase(); return t === "number" || t === "slider" || t === "int" || t === "float"; }
function isTextWidget(w)     { const t = (w.type || "").toLowerCase(); return t === "text" || t === "string"; }
function isBooleanWidget(w)  { const t = (w.type || "").toLowerCase(); return t === "boolean" || t === "toggle"; }
function isComboWidget(w)    { const t = (w.type || "").toLowerCase(); return t === "combo" || t === "dropdown"; }
function isEditable(w)       { return !w.disabled && !w.hidden; }

/** True if the widget has a matching input slot that is connected (linked). */
function isWidgetConnected(node, widget) {
    if (!node?.inputs || !widget?.name) return false;
    const inp = node.inputs.find(i => i.name === widget.name);
    return inp ? inp.link != null : false;
}

function getAllWidgets(node) {
    return (node?.widgets || []).filter(w => isEditable(w));
}
/** Only these widget types participate in Q/E cycling. */
const CYCLE_TYPES = new Set(["number", "slider", "int", "float", "boolean", "toggle", "combo", "dropdown"]);

/** Eligible for Q/E cycling: only known types, not text, not connected. */
function getCycleWidgets(node) {
    return getAllWidgets(node).filter(w => {
        const t = (w.type || "").toLowerCase();
        return CYCLE_TYPES.has(t) && !isWidgetConnected(node, w);
    });
}
function nodeHasCycleWidgets(node) {
    return getCycleWidgets(node).length > 0;
}

// ---- dialog ----
function getDialog() {
    return document.querySelector(".graphdialog");
}
function commitDialog() {
    const d = getDialog();
    if (!d) return;
    const inp = d.querySelector("input, textarea");
    if (!inp) return;
    inp.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true
    }));
}
function closeDialog() {
    const d = getDialog();
    if (!d) return;
    if (typeof d.close === "function") d.close();
    else d.remove();
}

// ---- coordinate helpers ----
function screenToGraph(cx, cy) {
    const c = app.canvas;
    const r = c.canvas.getBoundingClientRect();
    const s = c.ds.scale, o = c.ds.offset;
    return [(cx - r.left) / s - o[0], (cy - r.top) / s - o[1]];
}

function findWidgetByLocalY(node, ly) {
    const a = getAllWidgets(node);
    if (!a.length) return null;
    const ok = a.every(w => typeof w.last_y === "number");
    if (ok) {
        let m = null;
        for (const w of a) { if (w.last_y <= ly) m = w; else break; }
        return m || a[0];
    }
    const th = (window.LiteGraph && LiteGraph.NODE_TITLE_HEIGHT) || 30;
    const rh = (window.LiteGraph && LiteGraph.NODE_WIDGET_HEIGHT) || 20;
    return a[Math.max(0, Math.min(Math.floor((ly - th) / rh), a.length - 1))];
}

function hitTest(cx, cy) {
    const g = app.canvas?.graph;
    if (!g) return null;
    const [gx, gy] = screenToGraph(cx, cy);
    for (const n of g._nodes || []) {
        const [nx, ny] = n.pos, [w, h] = n.size;
        if (gx >= nx && gx <= nx + w && gy >= ny && gy <= ny + h)
            return { node: n, widget: findWidgetByLocalY(n, gy - ny) };
    }
    return null;
}

function buildFakeEvent(node, widget) {
    const c = app.canvas;
    const r = c.canvas.getBoundingClientRect();
    const s = c.ds.scale, o = c.ds.offset;
    const ly = typeof widget.last_y === "number" ? widget.last_y : 40;
    const gx = node.pos[0] + node.size[0] / 2, gy = node.pos[1] + ly;
    return {
        clientX: r.left + (gx + o[0]) * s,
        clientY: r.top + (gy + o[1]) * s,
        target: c.canvas
    };
}

// ---- highlight drawing (onDrawForeground) ----
function hookForeground(node) {
    if (node.__tchFg) return;
    node.__tchFg = true;
    const orig = node.onDrawForeground;
    node.onDrawForeground = function (ctx, c) {
        if (orig) orig.call(this, ctx, c);
        const hi = getHl(this);
        if (hi < 0) return;
        const cw = getCycleWidgets(this);
        const w = cw[hi];
        if (!w) return;
        const y = typeof w.last_y === "number" ? w.last_y : 40;
        const h = (window.LiteGraph && LiteGraph.NODE_WIDGET_HEIGHT) || 20;
        const x = 1, w2 = this.size[0] - 2 * x;
        ctx.save();
        ctx.strokeStyle = "#FF8800";
        ctx.lineWidth = 2.5;
        ctx.setLineDash([5, 4]);
        ctx.lineDashOffset = 0;
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
            ctx.roundRect(x, y, w2, h, 4);
        } else {
            ctx.rect(x, y, w2, h);
        }
        ctx.stroke();
        ctx.restore();
    };
}

// ---- widget action (R key) ----
function doAction(node, widget) {
    const c = app.canvas;
    const fe = buildFakeEvent(node, widget);
    if (isNumberWidget(widget)) {
        c.prompt("Value", widget.value, v => {
            if (v === null) return;
            widget.value = Number(v);
            if (widget.callback) widget.callback(widget.value, c, node, fe);
            node.graph?.setDirtyCanvas(true, true);
        }, fe, false);
        requestAnimationFrame(() => {
            const d = getDialog();
            if (!d) return;
            const s = d.querySelector(".name");
            if (s) s.textContent = widget.name;
            const inp = d.querySelector("input");
            if (inp) { inp.focus(); inp.select(); }
        });
    } else if (isBooleanWidget(widget)) {
        const ov = widget.value;
        widget.value = !ov;
        if (widget.callback) widget.callback(widget.value, c, node, fe);
        node.graph?.setDirtyCanvas(true, true);
    } else if (isComboWidget(widget)) {
        const vals = widget.options?.values;
        if (vals && vals.length > 0) {
            const ci = vals.indexOf(widget.value);
            widget.value = vals[(ci + 1) % vals.length];
            if (widget.callback) widget.callback(widget.value, c, node, fe);
            node.graph?.setDirtyCanvas(true, true);
        }
    }
}

// ---- node navigation ----
function findNearest(from, dir) {
    const g = app.canvas?.graph;
    if (!g) return null;
    const ns = g._nodes || [];
    if (!ns.length) return null;

    const isHoriz = dir === "left" || dir === "right";
    // Source node edges
    const sL = from.pos[0], sR = from.pos[0] + from.size[0];
    const sT = from.pos[1], sB = from.pos[1] + from.size[1];
    const sCx = (sL + sR) / 2, sCy = (sT + sB) / 2;

    let best = null;
    let bestScore = Infinity;

    for (const n of ns) {
        if (n === from || !n.size || n.size[0] <= 0 || n.size[1] <= 0 || !nodeHasCycleWidgets(n)) continue;
        const nL = n.pos[0], nR = n.pos[0] + n.size[0];
        const nT = n.pos[1], nB = n.pos[1] + n.size[1];
        const nCx = (nL + nR) / 2, nCy = (nT + nB) / 2;
        const dx = nCx - sCx, dy = nCy - sCy;

        // Check general direction
        if (dir === "left" && dx >= 0) continue;
        if (dir === "right" && dx <= 0) continue;
        if (dir === "up" && dy >= 0) continue;
        if (dir === "down" && dy <= 0) continue;

        // Overlap in the perpendicular axis
        let perpOverlap;
        let primaryDist;
        if (isHoriz) {
            // left/right: prefer same vertical band
            perpOverlap = Math.min(sB, nB) - Math.max(sT, nT); // vertical overlap
            primaryDist = Math.abs(dx);
        } else {
            // up/down: prefer same horizontal band
            perpOverlap = Math.min(sR, nR) - Math.max(sL, nL); // horizontal overlap
            primaryDist = Math.abs(dy);
        }

        // Score: primary distance + penalty for non-overlap in perpendicular axis
        const penalty = perpOverlap > 0 ? 0 : (isHoriz ? Math.abs(dy) : Math.abs(dx)) * 4;
        const score = primaryDist + penalty;

        if (score < bestScore) {
            bestScore = score;
            best = n;
        }
    }
    return best;
}

function selectNode(node) {
    const c = app.canvas;
    if (!c || !c.graph) return;
    for (const n of c.graph._nodes || []) n.selected = false;
    node.selected = true;
    currentNode = node;
    activeCycleIdx = 0;
    clearHl(node);
    if (nodeHasCycleWidgets(node)) setHl(node, 0);
    c.selected_nodes = { [node.id]: node };
    c.setDirty(true, true);
}

function centerOn(node) {
    const c = app.canvas;
    const r = c.canvas.getBoundingClientRect();
    const s = c.ds.scale;
    const nx = node.pos[0] + node.size[0] / 2, ny = node.pos[1] + node.size[1] / 2;
    c.ds.offset[0] = r.width / (2 * s) - nx;
    c.ds.offset[1] = r.height / (2 * s) - ny;
    c.setDirty(true, true);
}

function hookMouseDown(node) {
    if (node.__tchMd) return;
    node.__tchMd = true;
    const orig = node.onMouseDown;
    node.onMouseDown = function (e, pos, c) {
        currentNode = this;
        clearHl(this);
        const ly = pos ? pos[1] : null;
        if (ly != null) {
            const cw = getCycleWidgets(this);
            if (cw.length > 0) {
                let bi = 0;
                for (let i = 0; i < cw.length; i++) {
                    const wy = typeof cw[i].last_y === "number" ? cw[i].last_y : 40;
                    if (wy <= ly) bi = i; else break;
                }
                activeCycleIdx = bi;
                setHl(this, bi);
            }
        }
        return orig?.apply(this, arguments);
    };
}

// ---- extension ----
app.registerExtension({
    name: "tab.widget.cycler",
    async nodeCreated(node) {
        hookMouseDown(node);
        hookForeground(node);
    },
    setup() {
        (app.graph?._nodes || []).forEach(n => {
            hookMouseDown(n);
            hookForeground(n);
        });

        app.canvas.canvas.addEventListener("pointerdown", e => {
            const h = hitTest(e.clientX, e.clientY);
            if (!h) return;
            currentNode = h.node;
            if (h.widget) {
                const cw = getCycleWidgets(h.node);
                const ci = cw.indexOf(h.widget);
                activeCycleIdx = ci !== -1 ? ci : 0;
                setHl(h.node, activeCycleIdx);
            }
        }, true);

        document.addEventListener("keydown", e => {
            const tag = e.target?.tagName?.toLowerCase();
            const isInp = tag === "input" || tag === "textarea" || tag === "select";
            const mod = e.ctrlKey || e.metaKey || e.altKey;
            const nav  = e.key === "w" || e.key === "a" || e.key === "s" || e.key === "d";
            const cyc  = e.key === "q" || e.key === "e";
            const act  = e.key === "r";

            if (mod) return;

            if (isInp) {
                if (!cyc) return;
                const d = getDialog();
                if (!d || !d.contains(e.target)) return;
            } else {
                if (!nav && !cyc && !act) return;
            }

            const g = app.canvas?.graph;
            if (!g) return;
            const ns = g._nodes || [];
            if (!ns.length) return;

            if (!currentNode || !ns.includes(currentNode)) {
                currentNode = ns[0];
                selectNode(currentNode);
            }

            // WASD
            if (nav) {
                e.preventDefault();
                e.stopPropagation();
                closeDialog();
                clearHl(currentNode);
                const map = { w: "up", a: "left", s: "down", d: "right" };
                const t = findNearest(currentNode, map[e.key]);
                if (t) { selectNode(t); centerOn(t); }
                return;
            }

            // Q/E
            if (cyc) {
                e.preventDefault();
                e.stopPropagation();
                const cw = getCycleWidgets(currentNode);
                if (!cw.length) return;
                if (getDialog()) commitDialog();
                const dir = e.key === "q" ? -1 : 1;
                activeCycleIdx = (activeCycleIdx + dir + cw.length) % cw.length;
                setHl(currentNode, activeCycleIdx);
                return;
            }

            // R
            if (act) {
                e.preventDefault();
                e.stopPropagation();
                if (getDialog()) { commitDialog(); return; }
                const cw = getCycleWidgets(currentNode);
                if (!cw.length) return;
                const w = cw[activeCycleIdx];
                if (w) doAction(currentNode, w);
            }
        }, true);
    },
});
