// 页面观察思路改编自 browser-use/jev-ultrafast（MIT，见同目录 LICENSE）。
// 在网页隔离环境执行。只保存节点引用和编号，不让模型生成选择器。
export function readPage() {
  if (!document.body) {
    throw new Error("页面还没有正文，请等待加载完成");
  }
  let cache = window.__agenticJev;
  if (!cache) {
    cache = { ids: new WeakMap(), nodes: new Map(), next: 1 };
    window.__agenticJev = cache;
  }
  for (const [id, element] of cache.nodes) {
    if (!element.isConnected) {
      cache.nodes.delete(id);
    }
  }
  function identity(element) {
    if (!cache.ids.has(element)) {
      cache.ids.set(element, cache.next++);
    }
    const id = cache.ids.get(element);
    cache.nodes.set(id, element);
    return id;
  }
  function visible(element) {
    return (
      !element.closest('[aria-hidden="true"],[inert]') &&
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    );
  }
  function name(element, seen = new Set()) {
    if (!element || seen.has(element)) {
      return "";
    }
    seen.add(element);
    const labelled = (element.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => name(document.getElementById(id), seen))
      .filter(Boolean)
      .join(" ");
    const labels = [...(element.labels || [])]
      .map((label) => name(label, seen))
      .filter(Boolean)
      .join(" ");
    let text = "";
    if (element.tagName !== "INPUT") {
      for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          text += " " + node.textContent;
        } else if (
          node.nodeType === Node.ELEMENT_NODE &&
          node.getAttribute("aria-hidden") !== "true"
        ) {
          text += " " + name(node, seen);
        }
      }
    }
    let buttonValue = "";
    if (["button", "submit", "reset"].includes(element.type)) {
      buttonValue = element.value;
    }
    return (
      labelled ||
      element.getAttribute("aria-label") ||
      labels ||
      buttonValue ||
      element.getAttribute("alt") ||
      text.trim() ||
      element.getAttribute("title") ||
      element.getAttribute("placeholder") ||
      ""
    ).slice(0, 500);
  }
  const roles = [
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "menuitemradio",
    "option",
    "gridcell",
    "combobox",
    "textbox",
    "searchbox",
    "spinbutton",
  ];
  function role(element) {
    const explicit = element.getAttribute("role");
    if (roles.includes(explicit)) {
      return explicit;
    }
    switch (element.tagName) {
      case "BUTTON":
      case "SUMMARY":
        return "button";
      case "A":
        return "link";
      case "SELECT":
        return "combobox";
      case "TEXTAREA":
        return "textbox";
      case "INPUT":
        if (["checkbox", "radio"].includes(element.type)) {
          return element.type;
        }
        if (["button", "submit", "reset", "image"].includes(element.type)) {
          return "button";
        }
        if (element.type === "search") {
          return "searchbox";
        }
        if (element.type === "number") {
          return "spinbutton";
        }
        if (["text", "email", "url", "tel"].includes(element.type)) {
          return "textbox";
        }
        break;
    }
    if (element.isContentEditable) {
      return "textbox";
    }
    return null;
  }
  const selector =
    'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    roles.map((value) => `[role="${value}"]`).join(",");
  const actions = [];
  for (const element of document.querySelectorAll(selector)) {
    if (
      ["password", "file", "hidden"].includes(element.type) ||
      !visible(element) ||
      element.matches(":disabled") ||
      element.closest('[aria-disabled="true"]')
    ) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const kind = role(element);
    if (
      !kind ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      x < 0 ||
      y < 0 ||
      x >= innerWidth ||
      y >= innerHeight
    ) {
      continue;
    }
    if (kind === "gridcell" && element.querySelector('button,[role="button"]')) {
      continue;
    }
    const node = identity(element);
    const base = { node, role: kind, label: name(element) || kind };
    for (const key of ["checked", "selected", "expanded"]) {
      const value = element.getAttribute("aria-" + key);
      if (value !== null) {
        base[key] = value;
      }
    }
    if (["checkbox", "radio"].includes(element.type)) {
      base.checked = String(element.checked);
    }
    if (element.tagName === "SELECT") {
      for (const option of element.options) {
        if (!option.selected && !option.disabled && !option.closest("optgroup[disabled]")) {
          actions.push({
            ...base,
            id: `${node}:${option.index}`,
            kind: "select",
            value: option.value,
            current_value: [...element.selectedOptions].map((item) => item.label).join(", "),
            label: base.label + " → " + option.label,
          });
        }
      }
    } else {
      const editable =
        !element.readOnly &&
        element.getAttribute("aria-readonly") !== "true" &&
        (["textbox", "searchbox", "spinbutton"].includes(kind) ||
          (kind === "combobox" && ["INPUT", "TEXTAREA"].includes(element.tagName)));
      let value = "";
      if ("value" in element) {
        value = String(element.value);
      } else if (element.isContentEditable || kind === "combobox") {
        value = element.innerText.trim();
      }
      if (editable) {
        actions.push({ ...base, id: `${node}:fill`, kind: "fill", value });
      }
      actions.push({ ...base, id: `${node}:click`, kind: "click", value });
    }
  }
  const words = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node;
  let length = 0;
  while ((node = walker.nextNode()) && length < 6000) {
    const text = node.textContent.trim();
    const parent = node.parentElement;
    if (!text || !parent || parent.closest("script,style,noscript,template") || !visible(parent)) {
      continue;
    }
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < innerHeight &&
      rect.right > 0 &&
      rect.left < innerWidth
    ) {
      words.push(text);
      length += text.length;
    }
  }
  const text = words.join("\n").slice(0, 6000);
  const marker = JSON.stringify([
    performance.timeOrigin,
    location.href,
    scrollX,
    scrollY,
    innerWidth,
    innerHeight,
    document.title,
    text,
    actions,
  ]);
  const omitted = Math.max(0, actions.length - 250);
  actions.splice(250);
  if (scrollY + innerHeight < document.documentElement.scrollHeight - 2) {
    actions.push({ id: "SCROLL_DOWN", kind: "scroll", label: "Scroll down", delta: 560 });
  }
  if (scrollY > 0) {
    actions.push({ id: "SCROLL_UP", kind: "scroll", label: "Scroll up", delta: -560 });
  }
  actions.push({ id: "WAIT", kind: "wait", label: "Wait for actual page loading" });
  return { url: location.href, title: document.title, text, actions, marker, omitted };
}
