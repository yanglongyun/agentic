import { remoteRoot } from "./lib/remote";
import { RemoteView } from "./thread/RemoteView";
import { useEffect } from "react";

import { AppRoutes } from "./router";
import { ToastHost } from "./overlay/toast";
import { checkAuth, useAuth } from "./lib/auth";
import { init, dispose } from "./thread/store";

export function App() {
  return remoteRoot ? <RemoteView /> : <LocalApp />;
}
function LocalApp() {
  const { state: auth, error } = useAuth();

  useEffect(() => {
    void checkAuth();
  }, []);
  useEffect(() => {
    if (auth !== "in") {
      return;
    }
    void init();
    return dispose;
  }, [auth]);

  if (auth === "checking") {
    return null;
  }
  if (auth === "error") {
    return (
      <main className="login">
        <p>{error}</p>
        <button className="btn" onClick={() => void checkAuth()}>
          重新连接
        </button>
      </main>
    );
  }
  return (
    <>
      <AppRoutes />
      <ToastHost />
    </>
  );
}
