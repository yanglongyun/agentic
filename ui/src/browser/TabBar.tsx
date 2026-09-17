import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Icon } from "../icons/Icon";
import { PageIcon } from "./PageIcon";
import { reportError } from "./data";
import { useBrowser, activateTab, closeTab, reorderTabs, reopenTab } from "./store";

export function TabBar({ onNew }: { onNew: () => void }) {
  const { tabs, activeId, closed } = useBrowser();
  const bar = useRef<HTMLDivElement>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const dragged = useRef(false);
  const [width, setWidth] = useState(190);
  const [all, setAll] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) {
      return;
    }
    const measure = () =>
      setWidth(
        Math.max(
          44,
          Math.min(190, (element.clientWidth - 30 - tabs.length * 2) / Math.max(1, tabs.length)),
        ),
      );
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [tabs.length]);
  useEffect(() => {
    bar.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length, width]);
  useEffect(() => {
    if (!menu && !all) {
      return;
    }
    const close = () => {
      setMenu(null);
      setAll(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", key);
    };
  }, [menu, all]);
  function start(event: ReactMouseEvent<HTMLDivElement>, index: number) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) {
      return;
    }
    event.preventDefault();
    cleanup.current?.();
    dragged.current = false;
    const nodes = [...bar.current!.querySelectorAll<HTMLElement>(".browser-tab")];
    const rects = nodes.map((node) => node.getBoundingClientRect());
    const startX = event.clientX;
    let to = index;
    function move(event: MouseEvent) {
      const delta = event.clientX - startX;
      if (!dragged.current && Math.abs(delta) < 4) {
        return;
      }
      dragged.current = true;
      document.body.classList.add("browser-tab-dragging");
      const center = rects[index].left + rects[index].width / 2 + delta;
      to = index;
      for (let i = 0; i < rects.length; i++) {
        if (i < index && center < rects[i].left + rects[i].width / 2) {
          to = Math.min(to, i);
        }
        if (i > index && center > rects[i].left + rects[i].width / 2) {
          to = Math.max(to, i);
        }
      }
      nodes.forEach((node, i) => {
        let shift = 0;
        if (i === index) {
          shift = delta;
        } else if (to > index && i > index && i <= to) {
          shift = -rects[index].width - 2;
        } else if (to < index && i >= to && i < index) {
          shift = rects[index].width + 2;
        }
        node.style.transform = `translateX(${shift}px)`;
        node.classList.toggle("dragging", i === index);
      });
    }
    function stop() {
      document.body.classList.remove("browser-tab-dragging");
      for (const node of nodes) {
        node.style.transform = "";
        node.classList.remove("dragging");
      }
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
      if (dragged.current && to !== index) {
        reorderTabs(index, to);
      }
      cleanup.current = null;
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    cleanup.current = stop;
  }
  return (
    <div className="browser-tabrow">
      <div
        ref={bar}
        className={`browser-tabbar${width < 120 ? " compact" : ""}${width < 66 ? " icons" : ""}`}
        role="tablist"
        aria-label="网页标签"
      >
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            role="tab"
            tabIndex={tab.id === activeId ? 0 : -1}
            aria-selected={tab.id === activeId}
            className={`browser-tab${tab.id === activeId ? " active" : ""}`}
            title={`${tab.title}\n${tab.url === "about:blank" ? "" : tab.url}`}
            onMouseDown={(event) => start(event, index)}
            onClick={() => {
              if (!dragged.current) {
                activateTab(tab.id);
              }
              dragged.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                activateTab(tab.id);
              }
              if (event.key === "ArrowRight") {
                activateTab(tabs[(index + 1) % tabs.length].id);
              }
              if (event.key === "ArrowLeft") {
                activateTab(tabs[(index - 1 + tabs.length) % tabs.length].id);
              }
            }}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                closeTab(tab.id);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setAll(false);
              setMenu({
                id: tab.id,
                x: Math.min(event.clientX, window.innerWidth - 254),
                y: Math.min(event.clientY, window.innerHeight - 230),
              });
            }}
          >
            <PageIcon icon={tab.icon} loading={tab.loading} />
            <span className="browser-tab-label">{tab.title}</span>
            <button
              className="browser-tab-close"
              title={`关闭 ${tab.title}`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.id);
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        <button className="browser-tab-add" title="新建标签页 (⌘/Ctrl+T)" onClick={onNew}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      {width < 66 && (
        <div className="browser-tab-actions">
          <button
            className="icon-btn"
            title="所有标签"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => setAll(!all)}
          >
            <Icon name="chev" size={15} />
          </button>
        </div>
      )}
      {all && (
        <div className="browser-tabs-all" onMouseDown={(event) => event.stopPropagation()}>
          {tabs.map((tab) => (
            <div key={tab.id} className={tab.id === activeId ? "active" : ""}>
              <button
                onClick={() => {
                  activateTab(tab.id);
                  setAll(false);
                }}
              >
                <PageIcon icon={tab.icon} loading={tab.loading} />
                <span>{tab.title}</span>
              </button>
              <button
                className="icon-btn"
                title={`关闭 ${tab.title}`}
                onClick={() => closeTab(tab.id)}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {menu && (
        <div
          className="browser-tab-menu browser-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            onClick={() => {
              closeTab(menu.id);
              setMenu(null);
            }}
          >
            关闭标签<kbd>⌘W</kbd>
          </button>
          <button
            onClick={() => {
              for (const tab of tabs) {
                if (tab.id !== menu.id) {
                  closeTab(tab.id);
                }
              }
              setMenu(null);
            }}
          >
            关闭其他标签
          </button>
          <button
            onClick={() => {
              const at = tabs.findIndex((tab) => tab.id === menu.id);
              for (const tab of tabs.slice(at + 1)) {
                closeTab(tab.id);
              }
              setMenu(null);
            }}
          >
            关闭右侧标签
          </button>
          <hr />
          <button
            disabled={!closed.length}
            onClick={() => {
              reopenTab();
              setMenu(null);
            }}
          >
            重新打开关闭的标签<kbd>⇧⌘T</kbd>
          </button>
          <button
            disabled={tabs.find((tab) => tab.id === menu.id)?.url === "about:blank"}
            onClick={() => {
              void navigator.clipboard
                .writeText(tabs.find((tab) => tab.id === menu.id)!.url)
                .catch(reportError);
              setMenu(null);
            }}
          >
            复制网址
          </button>
        </div>
      )}
    </div>
  );
}
