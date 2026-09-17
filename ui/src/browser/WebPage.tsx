import { useEffect, useRef } from "react";
import type { WebviewTag } from "electron";
import { updateTab, useBrowser, type BrowserTab } from "./store";
import { bindView } from "./views";
import { noteVisit, reportError } from "./data";

export function WebPage({ tab, active }: { tab: BrowserTab; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const initialURL = useRef(tab.url);
  useEffect(() => {
    const container = host.current;
    if (!container) {
      return;
    }
    const view = document.createElement("webview") as WebviewTag;
    view.setAttribute("partition", "persist:agentic-browser");
    view.setAttribute("allowpopups", "true");
    view.setAttribute("allowfullscreen", "true");
    view.setAttribute("webpreferences", "plugins=yes");
    view.src = initialURL.current;
    function sync() {
      updateTab(tab.id, {
        url: view.getURL(),
        canBack: view.canGoBack(),
        canForward: view.canGoForward(),
      });
    }
    function remember(visit: boolean) {
      const current = useBrowser.getState().tabs.find((item) => item.id === tab.id);
      if (current) {
        noteVisit(view.getURL(), view.getTitle(), current.icon, visit);
      }
    }
    view.addEventListener("did-attach", () => {
      void window.agenticDesktop?.register(tab.id, view.getWebContentsId()).catch(reportError);
    });
    view.addEventListener("dom-ready", () => {
      updateTab(tab.id, { ready: true, error: "", zoom: Math.round(view.getZoomFactor() * 100) });
      sync();
    });
    view.addEventListener("did-start-loading", () =>
      updateTab(tab.id, { loading: true, error: "" }),
    );
    view.addEventListener("did-stop-loading", () => {
      updateTab(tab.id, { loading: false });
      sync();
    });
    view.addEventListener("did-navigate", () => {
      sync();
      remember(true);
    });
    view.addEventListener("did-navigate-in-page", (event) => {
      if (event.isMainFrame) {
        sync();
        remember(true);
      }
    });
    view.addEventListener("page-title-updated", () => {
      updateTab(tab.id, { title: view.getTitle() || view.getURL() });
      remember(false);
    });
    view.addEventListener("page-favicon-updated", (event) => {
      const icon = event.favicons[0] || "";
      updateTab(tab.id, { icon });
      remember(false);
    });
    view.addEventListener("did-fail-load", (event) => {
      if (event.isMainFrame && event.errorCode !== -3) {
        updateTab(tab.id, { loading: false, error: `网页加载失败 · ${event.errorDescription}` });
      }
    });
    view.addEventListener("render-process-gone", () =>
      updateTab(tab.id, {
        ready: false,
        loading: false,
        error: "这个网页停止了运行，可以重新加载。",
      }),
    );
    view.addEventListener("found-in-page", (event) =>
      updateTab(tab.id, {
        findMatches: event.result.matches,
        findActive: event.result.activeMatchOrdinal,
      }),
    );
    container.appendChild(view);
    bindView(tab.id, view);
    return () => {
      bindView(tab.id, null);
      void window.agenticDesktop?.register(tab.id, null).catch(() => {});
      view.remove();
    };
  }, [tab.id]);
  return (
    <div className={`browser-webpage${active ? " active" : ""}`}>
      <div className="browser-webview" ref={host} />
      {tab.error && (
        <div className="browser-page-error">
          <span className="browser-error-mark">!</span>
          <h3>暂时无法显示这个网页</h3>
          <p>{tab.error}</p>
          <span className="browser-error-url">{tab.url}</span>
          <button
            className="btn btn-accent"
            onClick={() => {
              updateTab(tab.id, { error: "", loading: true });
              const view = host.current?.querySelector("webview") as WebviewTag | null;
              void view?.loadURL(tab.url).catch(reportError);
            }}
          >
            重新加载
          </button>
        </div>
      )}
    </div>
  );
}
