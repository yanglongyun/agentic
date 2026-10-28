// 设置里的「改动记录」：agent 每改完一件事记的一笔（agentic snapshot），新的在前。
// 每一条都能退回：退回后应用重启，窗口会重新打开；退回前的样子留成分支，不会丢。
import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { toast } from "../overlay/toast";

interface Entry {
  oid: string;
  message: string;
  at: string;
  good: boolean;
}

const when = (at: string) => {
  const date = new Date(at);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

// launcher 自己记的快照（启动前、重启前、回滚前）只在有改动时才有，说明是固定的一句，换成用户看得懂的话。
const label = (message: string) => {
  if (/^播种 v/.test(message)) {
    return "出厂的样子";
  }
  if (/^(启动前|重启前|回滚前)自动快照$/.test(message)) {
    return "没写说明的改动（自动记下）";
  }
  return message;
};

export function History() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    void api
      .get<{ available: boolean; entries: Entry[] }>("/api/history")
      .then((result) => {
        setAvailable(result.available);
        setEntries(result.entries);
      })
      .catch((error) => toast(error instanceof Error ? error.message : "改动记录加载失败"));
  }, []);

  const rollback = async (entry: Entry) => {
    if (
      !window.confirm(
        `退回到「${label(entry.message)}」之后的样子？之后的改动会先留存起来，应用会重启。`,
      )
    ) {
      return;
    }
    setBusy(entry.oid);
    try {
      await api.post("/api/history/rollback", { oid: entry.oid });
      toast("正在退回，应用马上重启…", 6000);
    } catch (error) {
      toast(error instanceof Error ? error.message : "退回失败");
      setBusy("");
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-section-title">改动记录</div>
      <p className="sheet-note history-note">
        你让 agentic
        改它自己（界面、功能、工具）时，每改完一件事会记一笔。改得不满意，可以退回到任何一次之后的样子。
      </p>
      {!available ? (
        <p className="sheet-note">现在不是从 agentic 应用里打开的，没有改动记录。</p>
      ) : !entries ? (
        <p className="sheet-note">正在读取…</p>
      ) : (
        <div className="history-list">
          {entries.map((entry, index) => (
            <div className="history-row" key={entry.oid}>
              <div className="history-main">
                <div className="history-message">{label(entry.message)}</div>
                <div className="history-meta">
                  {when(entry.at)} · {entry.oid.slice(0, 8)}
                  {index === 0 ? " · 当前" : ""}
                </div>
              </div>
              {index > 0 && (
                <button
                  className="btn btn-quiet history-btn"
                  disabled={Boolean(busy)}
                  onClick={() => void rollback(entry)}
                >
                  {busy === entry.oid ? "退回中…" : "退回到这里"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
