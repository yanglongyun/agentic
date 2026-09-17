import { useEffect, useState } from "react";
import { BrowserDialog } from "./Dialog";
import { reportError, loadBookmarks } from "./data";
import { api } from "../lib/api";
import type { BrowserSettings } from "./desktop";

export function BrowserPreferences({
  settings,
  onChange,
  onClose,
  onImport,
}: {
  settings: BrowserSettings;
  onChange: (settings: BrowserSettings) => void;
  onClose: () => void;
  onImport: () => void;
}) {
  const [search, setSearch] = useState(settings.searchEngine);
  const [confirm, setConfirm] = useState<"" | "cache" | "logins">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const result = await window.agenticDesktop!.saveSettings({ searchEngine: search });
      onChange(result);
      setNote("已保存");
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <BrowserDialog title="浏览器设置" onClose={onClose}>
      <h4 className="browser-section-title">搜索</h4>
      <label className="browser-field">
        搜索引擎
        <select value={search} onChange={(event) => setSearch(event.target.value)}>
          <option value="https://www.bing.com/search?q={query}">Bing</option>
          <option value="https://www.google.com/search?q={query}">Google</option>
          <option value="https://www.baidu.com/s?wd={query}">百度</option>
          <option value="https://duckduckgo.com/?q={query}">DuckDuckGo</option>
          <option value={search} hidden>
            自定义模板
          </option>
        </select>
      </label>
      <label className="browser-field">
        搜索网址
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          spellCheck={false}
        />
        <small>使用 {"{query}"} 代表搜索内容。</small>
      </label>
      <button className="btn" disabled={busy} onClick={() => void save()}>
        保存搜索设置
      </button>
      <h4 className="browser-section-title">下载</h4>
      <p className="browser-path">{settings.downloadDirectory || "系统下载文件夹"}</p>
      <div className="browser-button-row">
        <button
          className="btn"
          onClick={() => {
            void window
              .agenticDesktop!.chooseDirectory()
              .then(async (directory) => {
                if (directory) {
                  onChange(
                    await window.agenticDesktop!.saveSettings({ downloadDirectory: directory }),
                  );
                }
              })
              .catch(reportError);
          }}
        >
          选择目录
        </button>
        {settings.downloadDirectory && (
          <button
            className="btn btn-quiet"
            onClick={() =>
              void window
                .agenticDesktop!.saveSettings({ downloadDirectory: "" })
                .then(onChange)
                .catch(reportError)
            }
          >
            恢复默认
          </button>
        )}
      </div>
      <h4 className="browser-section-title">书签与登录</h4>
      <button className="btn" onClick={onImport}>
        从 Chrome 导入
      </button>
      <p className="browser-muted">导入登录状态需要你主动授权，只支持 macOS Chrome。</p>
      <h4 className="browser-section-title">网站权限</h4>
      {!Object.keys(settings.permissions).length && (
        <p className="browser-muted">网站请求权限时会询问你。</p>
      )}
      {Object.entries(settings.permissions).map(([key, allowed]) => (
        <div className="browser-permission" key={key}>
          <span>
            <strong>{key.slice(0, key.lastIndexOf("|"))}</strong>
            <small>
              {key.slice(key.lastIndexOf("|") + 1)} · {allowed ? "允许" : "拒绝"}
            </small>
          </span>
          <button
            onClick={() =>
              void window.agenticDesktop!.revokePermission(key).then(onChange).catch(reportError)
            }
          >
            重置
          </button>
        </div>
      ))}
      <h4 className="browser-section-title">浏览数据</h4>
      <div className="browser-button-row">
        <button className="btn" onClick={() => setConfirm("cache")}>
          清理缓存
        </button>
        <button className="btn" onClick={() => setConfirm("logins")}>
          清除网站登录状态
        </button>
      </div>
      {confirm && (
        <div className="browser-notice">
          <p>
            {confirm === "logins"
              ? "将清除所有网站的 Cookie、页面存储和认证缓存，需要重新登录网站。agentic 聊天登录不受影响。"
              : "清理网页缓存，保留网站登录状态。"}
          </p>
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void window
                .agenticDesktop!.clearData(confirm)
                .then(() => {
                  setConfirm("");
                  setNote("已清理");
                })
                .catch(reportError)
                .finally(() => setBusy(false));
            }}
          >
            确认清理
          </button>
          <button className="btn btn-quiet" onClick={() => setConfirm("")}>
            取消
          </button>
        </div>
      )}
      {note && <p className="browser-notice">{note}</p>}
    </BrowserDialog>
  );
}
export function ChromeImport({ onClose }: { onClose: () => void }) {
  const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([]);
  const [profile, setProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [cookies, setCookies] = useState(false);
  useEffect(() => {
    void window
      .agenticDesktop!.chromeProfiles()
      .then((items) => {
        setProfiles(items);
        setProfile(items[0]?.id || "");
      })
      .catch(reportError);
  }, []);
  async function run(kind: "bookmarks" | "cookies") {
    setBusy(true);
    setNote("");
    try {
      const result = await window.agenticDesktop!.importChrome(profile, kind);
      if (kind === "bookmarks") {
        const data = await api.post<{ count: number }>("/api/browser/bookmarks/import", {
          bookmarks: result.bookmarks,
        });
        await loadBookmarks();
        setNote(`已导入 ${data.count} 个书签和目录`);
      } else {
        setNote(
          `已导入 ${result.imported} 条 Cookie，${result.failed} 条未能导入。部分网站可能仍需重新登录。`,
        );
        setCookies(false);
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <BrowserDialog
      title="从 Chrome 导入"
      onClose={() => {
        if (!busy) {
          onClose();
        }
      }}
    >
      <p className="browser-muted">
        选择本机 Chrome 用户资料。书签与登录状态分别导入，不会修改 Chrome。
      </p>
      {!profiles.length ? (
        <p className="browser-notice">未找到可导入的 Chrome 配置。当前仅支持 macOS Chrome。</p>
      ) : (
        <>
          <label className="browser-field">
            用户资料
            <select
              disabled={busy}
              value={profile}
              onChange={(event) => setProfile(event.target.value)}
            >
              {profiles.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div className="browser-import-choice">
            <strong>书签与目录</strong>
            <p>保留目录结构，导入到新标签页。</p>
            <button className="btn" disabled={busy} onClick={() => void run("bookmarks")}>
              导入书签
            </button>
          </div>
          <div className="browser-import-choice">
            <strong>网站登录状态</strong>
            <p>读取所选资料的 Cookie，导入 agentic 的浏览器分区。macOS 可能要求钥匙串授权。</p>
            <label className="browser-check">
              <input
                type="checkbox"
                checked={cookies}
                disabled={busy}
                onChange={(event) => setCookies(event.target.checked)}
              />
              允许读取并导入这个 Chrome 用户资料的登录状态
            </label>
            <button className="btn" disabled={busy || !cookies} onClick={() => void run("cookies")}>
              导入登录状态
            </button>
          </div>
        </>
      )}
      {busy && <p className="browser-notice">正在导入，请完成可能出现的系统授权…</p>}
      {note && <p className="browser-notice">{note}</p>}
    </BrowserDialog>
  );
}
