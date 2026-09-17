import { clipboard, Menu } from "electron";
import { isWebURL } from "./url.js";
export function setupPageMenu(contents, getWindow, send, tabId) {
  contents.on("context-menu", (_event, details) => {
    const items = [];
    if (isWebURL(details.linkURL)) {
      items.push(
        {
          label: "在新标签页打开",
          click: () =>
            send("browser:open-tab", {
              url: details.linkURL,
              background: true,
              openerId: tabId(contents),
            }),
        },
        { label: "复制链接", click: () => clipboard.writeText(details.linkURL) },
        { type: "separator" },
      );
    }
    if (details.mediaType === "image") {
      items.push({ label: "复制图片", click: () => contents.copyImageAt(details.x, details.y) });
    }
    if (details.isEditable) {
      items.push(
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
        { type: "separator" },
      );
    } else if (details.selectionText) {
      items.push({ role: "copy", label: "复制" }, { type: "separator" });
    }
    items.push(
      {
        label: "后退",
        enabled: contents.navigationHistory.canGoBack(),
        click: () => contents.navigationHistory.goBack(),
      },
      {
        label: "前进",
        enabled: contents.navigationHistory.canGoForward(),
        click: () => contents.navigationHistory.goForward(),
      },
      { label: "刷新", click: () => contents.reload() },
    );
    if (isWebURL(contents.getURL())) {
      items.push({ label: "复制页面地址", click: () => clipboard.writeText(contents.getURL()) });
    }
    Menu.buildFromTemplate(items).popup({ window: getWindow() });
  });
}
