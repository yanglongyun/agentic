import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { useShell } from "./layout";

// 两侧只调整列宽，不移动列，也不重新挂载浏览器网页。
export function Resizer({ target }: { target: "sidebar" | "browser" }) {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  function start(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    const handle = event.currentTarget;
    const column = handle.parentElement;
    const container = column?.parentElement;
    if (!column || !container) {
      return;
    }
    event.preventDefault();
    cleanup.current?.();
    const startX = event.clientX;
    const startWidth = column.getBoundingClientRect().width;
    const available = container.getBoundingClientRect().width;
    const sidebar = container.querySelector(".sidebar")?.getBoundingClientRect().width || 0;
    const browser = container.querySelector(".browser-panel")?.getBoundingClientRect().width || 0;
    let minimum = 320;
    let maximum = available - sidebar - 320;
    if (target === "sidebar") {
      minimum = 200;
      maximum = Math.min(440, available - 320 - (browser > 0 ? 320 : 0));
    }

    function move(event: MouseEvent) {
      let width = startWidth + event.clientX - startX;
      if (target === "browser") {
        width = startWidth - event.clientX + startX;
      }
      width = Math.max(minimum, Math.min(maximum, width));
      if (target === "sidebar") {
        useShell.getState().setSidebarWidth(width);
      } else {
        useShell.getState().setBrowserWidth(width);
      }
    }
    function stop() {
      document.body.classList.remove("column-resizing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
      cleanup.current = null;
    }

    // 拖动时由透明遮罩接住鼠标，避免 webview 吞掉移动和松手事件。
    document.body.classList.add("column-resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    cleanup.current = stop;
  }

  return (
    <div
      className={`column-resizer ${target}-resizer`}
      role="separator"
      aria-orientation="vertical"
      aria-label={target === "sidebar" ? "调整左侧栏宽度" : "调整浏览器宽度"}
      onMouseDown={start}
    />
  );
}
