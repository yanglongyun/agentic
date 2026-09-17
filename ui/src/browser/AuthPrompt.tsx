import { useState } from "react";
import { Sheet } from "../overlay/Sheet";
import type { AuthRequest } from "./desktop";
import { reportError } from "./data";
export function AuthPrompt({ request, onDone }: { request: AuthRequest; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  function finish(cancel = false) {
    void window
      .agenticDesktop!.answerAuth({ id: request.id, username, password, cancel })
      .then(onDone)
      .catch(reportError);
  }
  return (
    <Sheet title={`网站登录 · ${request.host}`} onClose={() => finish(true)}>
      <p className="sheet-note">
        {request.proxy ? "代理服务器" : "网站"}请求 HTTP 认证。{request.realm}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          finish();
        }}
      >
        <label className="browser-field">
          用户名
          <input
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label className="browser-field">
          密码
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <div className="sheet-foot">
          <button type="button" className="btn btn-quiet" onClick={() => finish(true)}>
            取消
          </button>
          <button className="btn btn-accent">登录</button>
        </div>
      </form>
    </Sheet>
  );
}
