import { useEffect, useState } from "react";
import { remoteRoot } from "../lib/remote";
import { ToastHost } from "../overlay/toast";
import { Composer } from "./Composer";
import { MessageStream } from "./MessageStream";
import { init, dispose, useThread, threadTitle } from "./store";
export function RemoteView() {
  const [error, setError] = useState("");
  const { online, ready, currentId, threads, loadError } = useThread();
  useEffect(() => {
    let stopped = false;
    async function connect() {
      try {
        const token = window.location.hash.slice(1);
        if (token) {
          const response = await fetch(`${remoteRoot}/auth`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token }),
          });
          if (!response.ok) {
            throw new Error((await response.json()).error);
          }
          history.replaceState(null, "", remoteRoot);
        } else {
          const response = await fetch(`${remoteRoot}/api/status`);
          if (response.status === 401 || response.status === 404) {
            throw new Error((await response.json()).error);
          }
        }
        if (!stopped) {
          void init();
        }
      } catch (error) {
        if (!stopped) {
          setError(error instanceof Error ? error.message : "连接失败");
        }
      }
    }
    void connect();
    return () => {
      stopped = true;
      dispose();
    };
  }, []);
  return (
    <div className="remote-page">
      <section className="thread">
        <header className="topbar">
          <span className="topbar-title clip">
            {threadTitle(threads.find((thread) => thread.id === currentId))}
          </span>
          <span className="model-tag">远程对话</span>
        </header>
        {error || loadError ? (
          <main className="route-error">
            <p>{error || loadError}</p>
          </main>
        ) : (
          <>
            {!online && <div className="connection-note">正在等待本地客户端连接…</div>}
            {ready && (
              <>
                <MessageStream />
                <Composer />
              </>
            )}
          </>
        )}
      </section>
      <ToastHost />
    </div>
  );
}
