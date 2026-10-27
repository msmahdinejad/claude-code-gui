// Drag handles for sidebar and inspector widths (persisted).
import { app, setPrefs } from "../core/state.js";

export function initResizers() {
  const root = document.documentElement;
  if (app.prefs.sidebarWidth) root.style.setProperty("--sidebar-w", `${app.prefs.sidebarWidth}px`);
  if (app.prefs.inspectorWidth) root.style.setProperty("--inspector-w", `${app.prefs.inspectorWidth}px`);
  wire(document.getElementById("sidebar-resizer"), "--sidebar-w", "sidebarWidth", 220, 460, () => document.documentElement.dir === "rtl");
  wire(document.getElementById("inspector-resizer"), "--inspector-w", "inspectorWidth", 300, 800, () => document.documentElement.dir !== "rtl");
}

function wire(handle, variable, prefKey, min, max, fromRight) {
  if (!handle) return;
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    const move = (e) => {
      const width = fromRight() ? window.innerWidth - e.clientX : e.clientX;
      const clamped = Math.min(max, Math.max(min, width));
      document.documentElement.style.setProperty(variable, `${clamped}px`);
      setPrefs({ [prefKey]: Math.round(clamped) });
    };
    const up = () => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}
