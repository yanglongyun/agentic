import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useLocation } from "react-router";
import { Icon } from "../icons/Icon";
import { useShell } from "../shell/layout";
import { Resizer } from "../shell/Resizer";
import { toast } from "../overlay/toast";
import {
  addTab,
  activateTab,
  closeTab,
  reopenTab,
  toggleBrowser,
  updateTab,
  useBrowser,
  addressURL,
} from "./store";
import { viewOf, navigatePage } from "./views";
import { loadBookmarks, reportError, useBookmarks, type Bookmark } from "./data";
import { WebPage } from "./WebPage";
import { TabBar } from "./TabBar";
import { NewTab, BookmarkEditor } from "./NewTab";
import { HistoryPanel, DownloadsPanel } from "./Records";
import { BrowserPreferences, ChromeImport } from "./Settings";
import { AuthPrompt } from "./AuthPrompt";
import { browserCommand } from "./control";
import type { AuthRequest, BrowserSettings, Download } from "./desktop";
import "./browser.css";

export function BrowserButton() {
  const open = useBrowser((state) => state.open);
  if (!window.agenticDesktop) {
    return null;
  }
  return (
    <button
      className={`icon-btn browser-toggle${open ? " on" : ""}`}
      title={open ? "收起浏览器" : "打开浏览器"}
      aria-label={open ? "收起浏览器" : "打开浏览器"}
      aria-pressed={open}
      onClick={toggleBrowser}
    >
      <Icon name="globe" size={18} />
    </button>
  );
}
export function BrowserPanel() {
  const { open, tabs, activeId } = useBrowser();
  const width = useShell((state) => state.browserWidth);
  const location = useLocation();
  const visible = open && (location.pathname === "/" || location.pathname.startsWith("/sessions/"));
  const active = tabs.find((tab) => tab.id === activeId);
  const bookmarks = useBookmarks((state) => state.items);
  const marked = bookmarks.find((item) => item.url === active?.url && item.kind === "link");
  const [settings, setSettings] = useState<BrowserSettings>({
    searchEngine: "https://www.bing.com/search?q={query}",
    downloadDirectory: "",
    permissions: {},
  });
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [auth, setAuth] = useState<AuthRequest[]>([]);
  const [panel, setPanel] = useState<"" | "history" | "downloads" | "settings" | "import">("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState(false);
  const [finding, setFinding] = useState(false);
  const [needle, setNeedle] = useState("");
  const [bookmark, setBookmark] = useState<Partial<Bookmark> | null>(null);
  const address = useRef<HTMLInputElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const command = useRef<(command: string, id?: string) => void>(() => {});
  const progress = downloads.find((item) => item.state === "progressing");
  const live = tabs
    .filter((tab) => tab.awake && tab.url !== "about:blank")
    .sort((a, b) => a.id.localeCompare(b.id));

  function newTab() {
    addTab();
    setEditing(true);
    setDraft("");
    requestAnimationFrame(() => address.current?.focus());
  }
  function focusAddress() {
    if (!open) {
      useBrowser.setState({ open: true });
    }
    setEditing(true);
    setDraft(active?.url === "about:blank" ? "" : active?.url || "");
    requestAnimationFrame(() => {
      address.current?.focus();
      address.current?.select();
    });
  }
  function openURL(url: string) {
    const id = activeId || addTab();
    void navigatePage(id, url).catch(reportError);
  }
  function submit() {
    try {
      const url = addressURL(draft, settings.searchEngine);
      openURL(url);
      setEditing(false);
      address.current?.blur();
    } catch (error) {
      reportError(error);
    }
  }
  function zoom(next: number) {
    const view = viewOf(activeId);
    if (!view || !active?.ready) {
      return;
    }
    const value = Math.max(25, Math.min(300, next));
    view.setZoomFactor(value / 100);
    updateTab(activeId, { zoom: value });
  }
  function find(text: string, forward = true) {
    const view = viewOf(activeId);
    if (!view || !active?.ready) {
      return;
    }
    if (text) {
      view.findInPage(text, { forward, findNext: true });
    } else {
      view.stopFindInPage("clearSelection");
      updateTab(activeId, { findMatches: 0, findActive: 0 });
    }
  }
  function closeFind() {
    setFinding(false);
    setNeedle("");
    viewOf(activeId)?.stopFindInPage("clearSelection");
  }
  function pageAction(action: "print" | "screenshot" | "devtools") {
    void window
      .agenticDesktop!.pageAction(activeId, action)
      .then((file) => {
        if (file) {
          toast(`截图已保存：${file}`);
        }
      })
      .catch(reportError);
  }
  function editBookmark() {
    if (!active || active.url === "about:blank") {
      return;
    }
    setBookmark(
      marked || { kind: "link", url: active.url, title: active.title, icon: active.icon },
    );
  }
  command.current = (name, id) => {
    if (id && id !== activeId) {
      activateTab(id);
    }
    const view = viewOf(id || activeId);
    switch (name) {
      case "address":
        focusAddress();
        break;
      case "new":
        newTab();
        break;
      case "close":
        if (activeId) {
          closeTab(activeId);
        }
        break;
      case "reopen":
        reopenTab();
        break;
      case "reload":
        view?.reload();
        break;
      case "back":
        if (view?.canGoBack()) {
          view.goBack();
        }
        break;
      case "forward":
        if (view?.canGoForward()) {
          view.goForward();
        }
        break;
      case "find":
        setFinding(true);
        requestAnimationFrame(() => findInput.current?.focus());
        break;
      case "print":
        if (active?.ready) {
          pageAction("print");
        }
        break;
      case "bookmark":
        editBookmark();
        break;
      case "zoom-in":
        zoom((active?.zoom || 100) + 10);
        break;
      case "zoom-out":
        zoom((active?.zoom || 100) - 10);
        break;
      case "zoom-reset":
        zoom(100);
        break;
      case "next-tab":
        if (tabs.length) {
          activateTab(tabs[(tabs.findIndex((tab) => tab.id === activeId) + 1) % tabs.length].id);
        }
        break;
      case "previous-tab":
        if (tabs.length) {
          activateTab(
            tabs[(tabs.findIndex((tab) => tab.id === activeId) - 1 + tabs.length) % tabs.length].id,
          );
        }
        break;
    }
  };
  useEffect(() => {
    const desktop = window.agenticDesktop;
    if (!desktop) {
      return;
    }
    void desktop
      .state()
      .then((state) => {
        setSettings(state.settings);
        setDownloads(state.downloads);
      })
      .catch(reportError);
    void loadBookmarks().catch(reportError);
    const offTab = desktop.onOpenTab(({ url, background, openerId }) => {
      if (new URL(url).origin === window.location.origin) {
        toast("这是 agentic 自己的地址");
        return;
      }
      addTab(url, background, openerId);
    });
    const offTool = desktop.onBrowserTool(async (request) => {
      try {
        const result = await browserCommand(request);
        await desktop.browserToolResult({ id: request.id, result });
      } catch (error) {
        await desktop.browserToolResult({
          id: request.id,
          error: error instanceof Error ? error.message : "浏览器操作失败",
        });
      }
    });
    const offDownload = desktop.onDownload((item) => {
      setDownloads((items) => [item, ...items.filter((one) => one.id !== item.id)]);
      if (item.state === "completed") {
        toast(`下载完成：${item.name}`);
      }
    });
    const offCommand = desktop.onCommand((event) => command.current(event.command, event.tabId));
    const offAuth = desktop.onAuth((request) => setAuth((items) => [...items, request]));
    const offClosed = desktop.onAuthClosed((id) =>
      setAuth((items) => items.filter((item) => item.id !== id)),
    );
    return () => {
      offTab();
      offTool();
      offDownload();
      offCommand();
      offAuth();
      offClosed();
    };
  }, []);
  useEffect(() => {
    void window.agenticDesktop?.visible(visible).catch(reportError);
  }, [visible]);
  useEffect(() => {
    setFinding(false);
    setNeedle("");
    setEditing(false);
    setMenu(false);
    if (visible && (!active || active.url === "about:blank")) {
      setEditing(true);
      setDraft("");
      requestAnimationFrame(() => address.current?.focus());
    }
    return () => {
      viewOf(activeId)?.stopFindInPage("clearSelection");
    };
  }, [activeId, visible]);
  useEffect(() => {
    if (!menu) {
      return;
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [menu]);
  if (!window.agenticDesktop) {
    return null;
  }
  let shownAddress = active?.url || "";
  if (shownAddress === "about:blank") {
    shownAddress = "";
  }
  return (
    <>
      <aside
        className={`browser-panel${visible ? " visible" : ""}`}
        style={{ "--browser-width": width ? `${width}px` : undefined } as CSSProperties}
        aria-label="浏览器"
      >
        <Resizer target="browser" />
        <TabBar onNew={newTab} />
        <div className="browser-navigation">
          <button
            className="icon-btn"
            title="后退"
            disabled={!active?.canBack}
            onClick={() => viewOf(activeId)?.goBack()}
          >
            <Icon name="back" size={16} />
          </button>
          <button
            className="icon-btn"
            title="前进"
            disabled={!active?.canForward}
            onClick={() => viewOf(activeId)?.goForward()}
          >
            <Icon name="forward" size={16} />
          </button>
          <button
            className="icon-btn"
            title={active?.loading ? "停止加载" : "刷新网页"}
            disabled={!active?.awake}
            onClick={() => {
              const view = viewOf(activeId);
              if (active?.loading) {
                view?.stop();
              } else {
                view?.reload();
              }
            }}
          >
            <Icon name={active?.loading ? "close" : "reload"} size={15} />
          </button>
          <form
            className="browser-address-form"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <input
              ref={address}
              aria-label="网址或搜索内容"
              placeholder="输入网址或搜索"
              spellCheck={false}
              value={editing ? draft : shownAddress}
              onFocus={(event) => {
                setEditing(true);
                setDraft(shownAddress);
                event.target.select();
              }}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => setEditing(false)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setDraft(shownAddress);
                  setEditing(false);
                  event.currentTarget.blur();
                }
              }}
            />
          </form>
          <button
            className={`icon-btn browser-star${marked ? " marked" : ""}`}
            title={marked ? "编辑书签" : "收藏当前网页 (⌘/Ctrl+D)"}
            disabled={!active || active.url === "about:blank"}
            onClick={editBookmark}
          >
            <Icon name="bookmark" size={16} />
          </button>
          <button
            className={`icon-btn browser-menu-toggle${menu ? " on" : ""}`}
            title="浏览器菜单"
            onClick={() => setMenu(!menu)}
          >
            <Icon name="more" size={17} />
            {progress && <i />}
          </button>
          {menu && (
            <>
              <div className="browser-menu-veil" onMouseDown={() => setMenu(false)} />
              <div className="browser-menu browser-more">
                <button
                  onClick={() => {
                    setMenu(false);
                    newTab();
                  }}
                >
                  新建标签页<kbd>⌘T</kbd>
                </button>
                <button
                  disabled={!useBrowser.getState().closed.length}
                  onClick={() => {
                    setMenu(false);
                    reopenTab();
                  }}
                >
                  恢复关闭的标签<kbd>⇧⌘T</kbd>
                </button>
                <hr />
                <button
                  disabled={!active?.ready}
                  onClick={() => {
                    setMenu(false);
                    command.current("find");
                  }}
                >
                  在网页中查找<kbd>⌘F</kbd>
                </button>
                <div className="browser-zoom-row">
                  <span>缩放</span>
                  <div>
                    <button
                      disabled={!active?.ready}
                      onClick={() => zoom((active?.zoom || 100) - 10)}
                    >
                      −
                    </button>
                    <button
                      disabled={!active?.ready}
                      title="恢复默认缩放"
                      onClick={() => zoom(100)}
                    >
                      {active?.zoom || 100}%
                    </button>
                    <button
                      disabled={!active?.ready}
                      onClick={() => zoom((active?.zoom || 100) + 10)}
                    >
                      ＋
                    </button>
                  </div>
                </div>
                <button
                  disabled={!active?.ready}
                  onClick={() => {
                    setMenu(false);
                    pageAction("print");
                  }}
                >
                  打印<kbd>⌘P</kbd>
                </button>
                <button
                  disabled={!active?.ready}
                  onClick={() => {
                    setMenu(false);
                    pageAction("screenshot");
                  }}
                >
                  保存网页截图
                </button>
                <hr />
                <button
                  onClick={() => {
                    setMenu(false);
                    setPanel("history");
                  }}
                >
                  浏览历史
                  <Icon name="history" size={14} />
                </button>
                <button
                  onClick={() => {
                    setMenu(false);
                    setPanel("downloads");
                  }}
                >
                  下载记录
                  <Icon name="download" size={14} />
                </button>
                <button
                  onClick={() => {
                    setMenu(false);
                    setPanel("import");
                  }}
                >
                  从 Chrome 导入
                </button>
                <hr />
                <button
                  disabled={!active || active.url === "about:blank"}
                  onClick={() => {
                    setMenu(false);
                    void window.agenticDesktop!.openExternal(active!.url).catch(reportError);
                  }}
                >
                  在系统浏览器打开
                  <Icon name="external" size={14} />
                </button>
                <button
                  disabled={!active?.ready}
                  onClick={() => {
                    setMenu(false);
                    pageAction("devtools");
                  }}
                >
                  开发者工具
                </button>
                <button
                  onClick={() => {
                    setMenu(false);
                    void window
                      .agenticDesktop!.state()
                      .then((state) => setSettings(state.settings))
                      .catch(reportError);
                    setPanel("settings");
                  }}
                >
                  浏览器设置
                  <Icon name="settings" size={14} />
                </button>
              </div>
            </>
          )}
        </div>
        {finding && (
          <form
            className="browser-find"
            onSubmit={(event) => {
              event.preventDefault();
              find(needle);
            }}
          >
            <Icon name="search" size={14} />
            <input
              ref={findInput}
              aria-label="页内查找"
              placeholder="查找网页文字"
              value={needle}
              onChange={(event) => {
                setNeedle(event.target.value);
                find(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  closeFind();
                }
                if (event.key === "Enter" && event.shiftKey) {
                  event.preventDefault();
                  find(needle, false);
                }
              }}
            />
            <span>
              {active?.findActive || 0}/{active?.findMatches || 0}
            </span>
            <button type="button" title="上一项" onClick={() => find(needle, false)}>
              <Icon name="back" size={13} />
            </button>
            <button type="submit" title="下一项">
              <Icon name="forward" size={13} />
            </button>
            <button type="button" title="关闭查找" onClick={closeFind}>
              <Icon name="close" size={14} />
            </button>
          </form>
        )}
        {progress && (
          <button className="browser-download-strip" onClick={() => setPanel("downloads")}>
            <Icon name="download" size={13} />
            <span>{progress.name}</span>
            <small>
              {progress.total
                ? `${Math.round((progress.received / progress.total) * 100)}%`
                : "下载中"}
            </small>
          </button>
        )}
        <div className="browser-viewport">
          {live.map((tab) => (
            <WebPage key={tab.id} tab={tab} active={tab.id === activeId} />
          ))}
          {(!active || active.url === "about:blank") && (
            <NewTab onOpen={openURL} onImport={() => setPanel("import")} />
          )}
        </div>
        {panel === "history" && <HistoryPanel onClose={() => setPanel("")} onOpen={openURL} />}
        {panel === "downloads" && (
          <DownloadsPanel
            items={downloads}
            onClose={() => setPanel("")}
            onClear={() => {
              void window
                .agenticDesktop!.downloadAction("clear")
                .then((items) => {
                  if (items) {
                    setDownloads(items);
                  }
                })
                .catch(reportError);
            }}
          />
        )}
        {panel === "settings" && (
          <BrowserPreferences
            settings={settings}
            onChange={setSettings}
            onClose={() => setPanel("")}
            onImport={() => setPanel("import")}
          />
        )}
        {panel === "import" && <ChromeImport onClose={() => setPanel("")} />}
        {bookmark && <BookmarkEditor item={bookmark} onClose={() => setBookmark(null)} />}
      </aside>
      {auth[0] && (
        <AuthPrompt
          key={auth[0].id}
          request={auth[0]}
          onDone={() => setAuth((items) => items.slice(1))}
        />
      )}
    </>
  );
}
