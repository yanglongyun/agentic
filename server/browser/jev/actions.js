import { readPage } from "./snapshot.js";

// 此函数与 readPage 一起进入网页隔离环境；变更后先返回 stale，不重复执行操作。
export function prepareAction(action, marker) {
  const current = readPage();
  if (current.marker !== marker) {
    return { stale: true };
  }
  if (action.kind === "scroll") {
    return { x: innerWidth / 2, y: innerHeight / 2 };
  }
  const element = window.__agenticJev.nodes.get(action.node);
  if (
    !element?.isConnected ||
    element.matches(":disabled") ||
    element.closest('[aria-disabled="true"],[inert]')
  ) {
    return { stale: true };
  }
  const rect = element.getBoundingClientRect();
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  if (
    x < 0 ||
    y < 0 ||
    x >= innerWidth ||
    y >= innerHeight ||
    !element.contains(document.elementFromPoint(x, y))
  ) {
    throw new Error("目标被遮挡，停止操作；请检查当前页面");
  }
  if (action.kind === "select") {
    const option = [...element.options].find((item) => item.value === action.value);
    if (!option || option.disabled || option.closest("optgroup[disabled]")) {
      return { stale: true };
    }
    element.value = action.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return { x, y };
}

export function observe(connection, id) {
  return connection.request("evaluate", { id, expression: `(${readPage.toString()})()` });
}

export function executeAction(connection, id, action, marker, text) {
  return connection.request("act", {
    id,
    kind: action.kind,
    text,
    delta: action.delta,
    expression: `${readPage.toString()}\n${prepareAction.toString()}\nprepareAction(${JSON.stringify(action)}, ${JSON.stringify(marker)})`,
  });
}
