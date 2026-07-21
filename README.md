# ComfyUI Tab Cycle

Cycle through the number input fields on a node using Tab / Shift+Tab, as you would in your favorite software! No more click, type, hit Enter to apply, click the next one, repeat! 

<img width="460" height="513" alt="Tab-Cycle" src="https://github.com/user-attachments/assets/5234eab0-3be4-42b6-8ba9-ba5b01f67c05" />

## How to use

Click a number/slider input widget on a node, edit the value, hit Tab to apply (no Enter or clicking OK required) and go to the the next input on the node.

Shift+Tab goes backwards. If no number input field is active pressing Tab has the default behavior.

## What it doesn't do

- **Text/Boolean/Dropdown/etc. widgets are out of scope**. By design. The purpose is quick editing of numbers.
- **No cross-node tabbing.** Tab only cycles within whichever node you clicked into. Wraps around at the end.
- **This was NOT built for or Node 2.0.**

## Install

Drop this folder into `custom_nodes/`, restart ComfyUI, hard-refresh your browser. (Or install via ComfyUI-Manager once it's up on the registry.)

## How it works (for the curious)

litegraph's own widget-click handling doesn't route through anything node-level we can hook cleanly. Tried `node.onMouseDown` first, nope, widget clicks bypass it entirely. So instead: a `pointerdown` listener on the canvas does its own hit-test: screen coords → graph coords using the canvas pan/zoom transform, then which node's bounding box contains the click, then which widget row via `widget.last_y` (which litegraph sets during its own render pass, more reliable than guessing row-height constants). From there Tab just drives litegraph's built-in `canvas.prompt()` for each widget in sequence and fires a synthetic Enter to commit-and-close before opening the next one.

None of this is public API. It's reaching into litegraph/ComfyUI internals that could shift under a frontend update. Works today; no promises about tomorrow. If Tab stops doing anything after a ComfyUI update, that's probably why. Open an issue and I'll take a look.
