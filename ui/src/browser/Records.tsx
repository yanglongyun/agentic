import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons/Icon";
import { api } from "../lib/api";
import { BrowserDialog } from "./Dialog";
import { PageIcon } from "./PageIcon";
import { reportError, type Visit } from "./data";
import type { Download } from "./desktop";
export function HistoryPanel({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (url: string) => void;
}) {
  const [query, setQuery] = useState("");
  const currentQuery = useRef(query);
  currentQuery.current = query;
  const [items, setItems] = useState<Visit[]>([]);
  const [total, setTotal] = useState(0);
  const [revision, setRevision] = useState(0);
  const [clearing, setClearing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void api
        .get<{ history: Visit[]; total: number }>(
          `/api/browser/history?query=${encodeURIComponent(query)}`,
        )
        .then((data) => {
          if (active) {
            setItems(data.history);
            setTotal(data.total);
          }
        })
        .catch((error) => {
          if (active) {
            setError(error.message);
          }
        })
        .finally(() => {
          if (active) {
            setLoading(false);
          }
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, revision]);
  return (
    <BrowserDialog title="浏览历史" onClose={onClose}>
      <input
        className="browser-search"
        autoFocus
        aria-label="搜索浏览历史"
        placeholder="搜索标题或网址"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="browser-record-toolbar">
        <span>{total} 个网页</span>
        <button disabled={!total} onClick={() => setClearing(!clearing)}>
          清空历史
        </button>
      </div>
      {clearing && (
        <p className="browser-notice">
          清空所有浏览历史？
          <button
            className="browser-text-button danger"
            onClick={() => {
              void api
                .del("/api/browser/history")
                .then(() => {
                  setRevision(revision + 1);
                  setClearing(false);
                })
                .catch(reportError);
            }}
          >
            确认清空
          </button>
        </p>
      )}
      {error && <p className="browser-notice error">{error}</p>}
      {loading && <p className="browser-muted">正在读取…</p>}
      {!loading && !items.length && (
        <div className="browser-record-empty">
          {query ? "没有找到相关网页" : "浏览过的网页会出现在这里"}
        </div>
      )}
      {items.map((item) => (
        <div className="browser-record" key={item.url}>
          <PageIcon icon={item.icon} />
          <button
            className="browser-record-link"
            title={item.url}
            onClick={() => {
              onOpen(item.url);
              onClose();
            }}
          >
            <strong>{item.title || item.url}</strong>
            <small>
              {new URL(item.url).hostname} · {new Date(item.visited_at).toLocaleString()}
            </small>
          </button>
          <button
            className="icon-btn"
            title={`删除历史 ${item.title}`}
            onClick={() => {
              void api
                .del(`/api/browser/history?url=${encodeURIComponent(item.url)}`)
                .then(() => setRevision(revision + 1))
                .catch(reportError);
            }}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
      {items.length < total && !loading && (
        <button
          className="btn browser-load-more"
          onClick={() => {
            setLoading(true);
            void api
              .get<{ history: Visit[]; total: number }>(
                `/api/browser/history?query=${encodeURIComponent(query)}&offset=${items.length}`,
              )
              .then((data) => {
                if (currentQuery.current === query) {
                  setItems([...items, ...data.history]);
                }
              })
              .catch(reportError)
              .finally(() => {
                if (currentQuery.current === query) {
                  setLoading(false);
                }
              });
          }}
        >
          显示更多
        </button>
      )}
    </BrowserDialog>
  );
}
function bytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
function downloadStatus(item: Download) {
  switch (item.state) {
    case "progressing": {
      const total = item.total ? bytes(item.total) : "未知大小";
      return `${bytes(item.received)} / ${total}`;
    }
    case "completed":
      return `已完成 · ${bytes(item.received)}`;
    case "cancelled":
      return "已取消";
    default:
      return "下载中断";
  }
}
export function DownloadsPanel({
  items,
  onClose,
  onClear,
}: {
  items: Download[];
  onClose: () => void;
  onClear: () => void;
}) {
  return (
    <BrowserDialog title="下载记录" onClose={onClose}>
      <div className="browser-record-toolbar">
        <span>下载文件保留在本机</span>
        <button onClick={onClear}>清除已结束记录</button>
      </div>
      {!items.length && (
        <div className="browser-record-empty">
          <Icon name="download" size={26} />
          <p>下载的文件会出现在这里</p>
        </div>
      )}
      {items.map((item) => (
        <div className="browser-download-record" key={item.id}>
          <div className="browser-record">
            <Icon name="download" size={18} />
            <div className="browser-record-link">
              <strong title={item.name}>{item.name}</strong>
              <small>{downloadStatus(item)}</small>
            </div>
            {item.state === "progressing" ? (
              <button
                className="browser-text-button"
                onClick={() =>
                  void window.agenticDesktop?.downloadAction("cancel", item.id).catch(reportError)
                }
              >
                取消
              </button>
            ) : (
              item.state === "completed" && (
                <button
                  className="browser-text-button"
                  onClick={() =>
                    void window.agenticDesktop?.downloadAction("reveal", item.id).catch(reportError)
                  }
                >
                  显示文件
                </button>
              )
            )}
          </div>
          {item.state === "progressing" && (
            <progress
              max={item.total || undefined}
              value={item.total ? item.received : undefined}
            />
          )}
        </div>
      ))}
    </BrowserDialog>
  );
}
