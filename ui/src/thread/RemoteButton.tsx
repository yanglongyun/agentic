import { useEffect, useState } from "react";
import { Icon } from "../icons/Icon";
import { api } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { Sheet } from "../overlay/Sheet";
import { toast } from "../overlay/toast";
import { useThread } from "./store";
interface Remote {
  enabled: boolean;
  online?: boolean;
  url?: string;
}
export function RemoteButton() {
  const id = useThread((state) => state.currentId);
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<Remote | null>(null);
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const path = `/api/sessions/${id}/remote`;
  useEffect(() => {
    if (!id) {
      return;
    }
    let active = true;
    async function load() {
      try {
        const result = await api.get<Remote>(path);
        if (active) {
          setRemote(result);
        }
      } catch (error) {
        if (active) {
          toast(error instanceof Error ? error.message : "读取远程状态失败");
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [id, path]);
  async function show() {
    setOpen(true);
    try {
      setRemote(await api.get<Remote>(path));
    } catch (error) {
      toast(error instanceof Error ? error.message : "读取失败");
    }
  }
  async function enable() {
    setBusy(true);
    try {
      setRemote(await api.post<Remote>(path, { url, key }));
      setKey("");
    } catch (error) {
      toast(error instanceof Error ? error.message : "开启失败");
    } finally {
      setBusy(false);
    }
  }
  async function disable() {
    setBusy(true);
    try {
      setRemote(await api.del<Remote>(path));
    } catch (error) {
      toast(error instanceof Error ? error.message : "关闭失败");
    } finally {
      setBusy(false);
    }
  }
  if (!id) {
    return null;
  }
  return (
    <>
      <button
        className={`icon-btn remote-toggle${remote?.enabled ? " on" : ""}`}
        title={remote?.enabled ? "远程访问已开启" : "远程访问"}
        aria-label={remote?.enabled ? "远程访问已开启" : "远程访问"}
        aria-pressed={remote?.enabled === true}
        onClick={() => void show()}
      >
        <Icon name="link" size={18} />
      </button>
      {open && (
        <Sheet title="远程访问此对话" onClose={() => setOpen(false)}>
          <div className="remote-form">
            <p>远程设备可以查看、发送消息和停止此对话。本地客户端需要保持运行。</p>
            {!remote && <p>正在读取…</p>}
            {remote?.enabled && (
              <>
                <label>
                  访问链接
                  <input readOnly value={remote.url} />
                </label>
                <p>持有链接的人可以操作此对话，请只分享给可信的人。</p>
                <div className="remote-actions">
                  <button className="btn" onClick={() => void copyText(remote.url || "")}>
                    复制链接
                  </button>
                  <button className="btn" disabled={busy} onClick={() => void disable()}>
                    关闭远程访问
                  </button>
                </div>
              </>
            )}
            {remote && !remote.enabled && (
              <>
                <label>
                  Worker 地址
                  <input
                    placeholder="https://agentic-relay.example.workers.dev"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </label>
                <label>
                  管理密钥
                  <input
                    type="password"
                    autoComplete="off"
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                  />
                </label>
                <button
                  className="btn"
                  disabled={busy || !url.trim() || !key}
                  onClick={() => void enable()}
                >
                  {busy ? "正在连接…" : "开启远程访问"}
                </button>
              </>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}
