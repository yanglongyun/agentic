// 侧栏底部的「新东西」提示：官方发布了新功能、用户还没决定要不要时出现，一次只显示一条。
// 「了解一下」开一个新对话让 agent 介绍、问要不要加；「不要」记为 skipped，以后不再提。
// 加上了由 agent 加完后自己记（agentic news added），这里不管。
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { api } from "../lib/api";
import { toast } from "../overlay/toast";
import { createDraft, send } from "../thread/store";

interface NewsItem {
  id: string;
  date: string;
  title: string;
  summary: string;
  status: string;
}

export function News() {
  const navigate = useNavigate();
  const [items, setItems] = useState<NewsItem[]>([]);

  useEffect(() => {
    const load = () =>
      void api
        .get<{ items: NewsItem[] }>("/api/news")
        .then((result) => setItems(result.items.filter((item) => item.status === "new")))
        .catch(() => {});
    load();
    // launcher 每隔几小时拉一次；窗口拿到焦点、每十分钟各看一次本机的状态就够了。
    const timer = window.setInterval(load, 10 * 60_000);
    window.addEventListener("focus", load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, []);

  const item = items[0];
  if (!item) {
    return null;
  }

  const learn = () => {
    navigate("/");
    createDraft();
    const text = `官方发布了新东西「${item.title}」（${item.id}）。介绍一下它是什么、加上之后是什么样，我决定要不要加。`;
    send(text, null, (id) => navigate(`/sessions/${id}`, { replace: true }));
  };

  const skip = async () => {
    try {
      await api.patch(`/api/news/${encodeURIComponent(item.id)}`, { status: "skipped" });
      setItems((current) => current.filter((entry) => entry.id !== item.id));
    } catch (error) {
      toast(error instanceof Error ? error.message : "操作失败");
    }
  };

  return (
    <div className="news-card">
      <div className="news-label">
        新东西{items.length > 1 ? ` · 还有 ${items.length - 1} 条` : ""}
      </div>
      <div className="news-title">{item.title}</div>
      {item.summary && <div className="news-summary">{item.summary}</div>}
      <div className="news-actions">
        <button className="btn btn-accent news-btn" onClick={learn}>
          了解一下
        </button>
        <button className="btn btn-quiet news-btn" onClick={() => void skip()}>
          不要
        </button>
      </div>
    </div>
  );
}
