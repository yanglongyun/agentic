import { useState } from "react";
import { api } from "../lib/api";
import { Icon } from "../icons/Icon";
import { BrowserDialog } from "./Dialog";
import { PageIcon } from "./PageIcon";
import { useBookmarks, loadBookmarks, reportError, type Bookmark } from "./data";
export function BookmarkEditor({
  item,
  parent = "",
  onClose,
}: {
  item: Partial<Bookmark>;
  parent?: string;
  onClose: () => void;
}) {
  const items = useBookmarks((state) => state.items);
  const folders = items.filter((one) => one.kind === "folder" && one.id !== item.id);
  const [title, setTitle] = useState(item.title || "");
  const [url, setURL] = useState(item.url || "");
  const [directory, setDirectory] = useState(item.parent_id || parent);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      if (item.id) {
        await api.patch(`/api/browser/bookmarks/${item.id}`, { title, url, parent_id: directory });
      } else {
        await api.post("/api/browser/bookmarks", {
          title,
          kind: item.kind || "link",
          url,
          icon: item.icon || "",
          parent_id: directory,
        });
      }
      await loadBookmarks();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  let heading = "添加书签";
  if (item.kind === "folder") {
    heading = "新建目录";
  }
  if (item.id) {
    heading = "编辑书签";
  }
  return (
    <BrowserDialog title={heading} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="browser-field">
          名称
          <input
            autoFocus
            required
            maxLength={500}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {item.kind !== "folder" && (
          <label className="browser-field">
            网址
            <input
              type="url"
              required
              value={url}
              placeholder="https://"
              onChange={(event) => setURL(event.target.value)}
            />
          </label>
        )}
        <label className="browser-field">
          保存到
          <select value={directory} onChange={(event) => setDirectory(event.target.value)}>
            <option value="">书签首页</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.title}
              </option>
            ))}
          </select>
        </label>
        {error && <p className="browser-notice error">{error}</p>}
        {deleting && (
          <p className="browser-notice">
            {item.kind === "folder" ? "删除目录会同时删除其中的书签。" : "确定删除这个书签？"}
            <button
              type="button"
              className="browser-text-button danger"
              onClick={() => {
                void api
                  .del(`/api/browser/bookmarks/${item.id}`)
                  .then(loadBookmarks)
                  .then(onClose)
                  .catch(reportError);
              }}
            >
              确认删除
            </button>
          </p>
        )}
        <div className="browser-dialog-actions">
          {item.id && (
            <button type="button" className="btn btn-quiet" onClick={() => setDeleting(true)}>
              删除
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-accent" disabled={busy || !title.trim()}>
            保存
          </button>
        </div>
      </form>
    </BrowserDialog>
  );
}
export function NewTab({
  onOpen,
  onImport,
}: {
  onOpen: (url: string) => void;
  onImport: () => void;
}) {
  const items = useBookmarks((state) => state.items);
  const [folder, setFolder] = useState("");
  const [editing, setEditing] = useState<Partial<Bookmark> | null>(null);
  const current = items.find((item) => item.id === folder);
  const parent = current ? folder : "";
  const rows = items.filter((item) => item.parent_id === parent);
  const trail: Bookmark[] = [];
  let at = current;
  while (at) {
    trail.unshift(at);
    at = items.find((item) => item.id === at!.parent_id);
  }
  return (
    <div className="browser-newtab">
      <div className="browser-newtab-heading">
        <div>
          <span className="browser-eyebrow">AGENTIC / BROWSER</span>
          <h2>{current ? current.title : "常用网页，随手打开"}</h2>
          <p>在上方输入网址或搜索内容，收藏常用页面到这里。</p>
        </div>
      </div>
      <div className="browser-bookmark-toolbar">
        <nav>
          <button onClick={() => setFolder("")}>书签</button>
          {trail.map((item) => (
            <span key={item.id}>
              {" "}
              / <button onClick={() => setFolder(item.id)}>{item.title}</button>
            </span>
          ))}
        </nav>
        <span className="grow" />
        <button title="添加书签" onClick={() => setEditing({ kind: "link" })}>
          <Icon name="plus" size={14} />
          <span>书签</span>
        </button>
        <button title="新建书签目录" onClick={() => setEditing({ kind: "folder" })}>
          <Icon name="folder" size={14} />
          <span>目录</span>
        </button>
      </div>
      {rows.length ? (
        <div className="browser-bookmark-grid">
          {rows.map((item) => (
            <div
              key={item.id}
              className="browser-bookmark-tile"
              onContextMenu={(event) => {
                event.preventDefault();
                setEditing(item);
              }}
            >
              <button
                className="browser-bookmark-open"
                title={item.url || item.title}
                onClick={() => {
                  if (item.kind === "folder") {
                    setFolder(item.id);
                  } else {
                    onOpen(item.url);
                  }
                }}
              >
                <span className="browser-bookmark-icon">
                  {item.kind === "folder" ? (
                    <Icon name="folder" size={22} />
                  ) : (
                    <PageIcon icon={item.icon} />
                  )}
                </span>
                <strong>{item.title}</strong>
                <small>
                  {item.kind === "folder"
                    ? `${items.filter((one) => one.parent_id === item.id).length} 项`
                    : new URL(item.url).hostname}
                </small>
              </button>
              <button
                className="browser-bookmark-edit"
                title={`编辑 ${item.title}`}
                onClick={() => setEditing(item)}
              >
                <Icon name="more" size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="browser-bookmarks-empty">
          <Icon name="bookmark" size={28} />
          <h3>{current ? "目录里还没有书签" : "把常用网站留在手边"}</h3>
          <p>点地址栏旁的星标收藏网页，也可以导入 Chrome 书签。</p>
          <button className="btn" onClick={onImport}>
            从 Chrome 导入
          </button>
        </div>
      )}
      {editing && (
        <BookmarkEditor item={editing} parent={parent} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
