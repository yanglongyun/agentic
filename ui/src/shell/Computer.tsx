import { useEffect, useState } from "react";
import type { ComputerState } from "../browser/desktop";
import { toast } from "../overlay/toast";

export function ComputerSettings() {
  const [state, setState] = useState<ComputerState | null>(null);
  const [busy, setBusy] = useState(false);
  const desktop = window.agenticDesktop;
  useEffect(() => {
    if (!desktop) {
      return;
    }
    let closed = false;
    function refresh() {
      void desktop!
        .computerState()
        .then((value) => {
          if (!closed) {
            setState(value);
          }
        })
        .catch((error) => {
          if (!closed) {
            toast(error.message);
          }
        });
    }
    refresh();
    const unsubscribe = desktop.onComputerChanged(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      closed = true;
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [desktop]);
  if (!desktop || !state?.supported) {
    return null;
  }
  async function change(action: () => Promise<ComputerState>) {
    setBusy(true);
    try {
      setState(await action());
    } catch (error) {
      toast(error instanceof Error ? error.message : "Mac 控制设置失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <div className="settings-section-title">Mac 控制</div>
      <div className="settings-theme">
        <span>允许 Agent 操作这台 Mac 的应用</span>
        <button
          type="button"
          className="btn btn-quiet"
          disabled={busy}
          onClick={() => void change(() => desktop.computerEnabled(!state.enabled))}
        >
          {state.enabled ? "关闭控制" : "开启控制"}
        </button>
      </div>
      <p className="sheet-note">
        读取界面、截图、点击和输入。开启后，当前电脑上运行的
        Agent（包括远程对话）都可以使用。截图会随工具结果交给你配置的模型。
      </p>
      <div className="computer-permissions">
        <div>
          <span>辅助功能 · {state.accessibility ? "已授权" : "未授权"}</span>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={busy}
            onClick={() => void change(() => desktop.computerPermission("accessibility"))}
          >
            打开授权设置
          </button>
        </div>
        <div>
          <span>屏幕录制 · {state.screen ? "已授权" : "未授权"}</span>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={busy}
            onClick={() => void change(() => desktop.computerPermission("screen"))}
          >
            打开授权设置
          </button>
        </div>
      </div>
      <p className="sheet-note">
        {state.shortcut
          ? "随时按 ⌘⇧Esc 停止并关闭 Mac 控制。"
          : "停止快捷键注册失败，请通过这里的关闭控制按钮停止。"}{" "}
        授权完成后点击刷新权限；系统要求时重新启动客户端。
      </p>
      <button
        type="button"
        className="btn btn-quiet"
        disabled={busy}
        onClick={() => void change(() => desktop.computerState())}
      >
        刷新权限
      </button>
    </section>
  );
}
