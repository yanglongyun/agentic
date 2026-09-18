/* agentic 原型 · 仅做三件事：主题切换记忆、工具卡折叠、浏览器标签切换。
   另外注入共享的 SVG 图标 sprite 和右上角浮动小组件。原生 JS，无框架。 */
"use strict";

/* ---------- 内联 SVG 图标 sprite（stroke 1.5，24 视窗，Lucide 风格） ---------- */
var SPRITE =
  '<svg xmlns="http://www.w3.org/2000/svg" style="display:none">' +
  '<symbol id="i-sparkles" viewBox="0 0 24 24"><path d="M12 3l1.9 5.7 5.7 1.9-5.7 1.9L12 18.2l-1.9-5.7-5.7-1.9 5.7-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></symbol>' +
  '<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>' +
  '<symbol id="i-compose" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></symbol>' +
  '<symbol id="i-settings" viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></symbol>' +
  '<symbol id="i-panel" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></symbol>' +
  '<symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></symbol>' +
  '<symbol id="i-send" viewBox="0 0 24 24"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></symbol>' +
  '<symbol id="i-stop" viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="2"/></symbol>' +
  '<symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></symbol>' +
  '<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></symbol>' +
  '<symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></symbol>' +
  '<symbol id="i-moon" viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></symbol>' +
  '<symbol id="i-monitor" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></symbol>' +
  '<symbol id="i-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>' +
  '<symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></symbol>' +
  '<symbol id="i-terminal" viewBox="0 0 24 24"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></symbol>' +
  '<symbol id="i-file" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></symbol>' +
  '<symbol id="i-pen" viewBox="0 0 24 24"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></symbol>' +
  '<symbol id="i-trash" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/></symbol>' +
  '<symbol id="i-arrow-left" viewBox="0 0 24 24"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></symbol>' +
  '<symbol id="i-arrow-right" viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></symbol>' +
  '<symbol id="i-rotate" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></symbol>' +
  '<symbol id="i-lock" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></symbol>' +
  '<symbol id="i-x" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></symbol>' +
  '<symbol id="i-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></symbol>' +
  '<symbol id="i-folder" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/></symbol>' +
  '<symbol id="i-cpu" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M15 20v2M9 2v2M9 20v2M2 15h2M2 9h2M20 15h2M20 9h2"/></symbol>' +
  '<symbol id="i-palette" viewBox="0 0 24 24"><path d="M12 22a10 10 0 1 1 10-10c0 2.2-1.6 3.5-3.3 3.5h-2a2.3 2.3 0 0 0-1.7 3.8c.5.6.2 2.7-3 2.7z"/><circle cx="7.5" cy="11.5" r=".8"/><circle cx="10.5" cy="7.5" r=".8"/><circle cx="15" cy="7.5" r=".8"/><circle cx="17.5" cy="11.5" r=".8"/></symbol>' +
  '<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></symbol>' +
  '<symbol id="i-home" viewBox="0 0 24 24"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></symbol>' +
  '<symbol id="i-message" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></symbol>' +
  '<symbol id="i-zap" viewBox="0 0 24 24"><path d="M13 2 3 14h7l-1 8 11-13h-8z"/></symbol>' +
  '<symbol id="i-download" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></symbol>' +
  '<symbol id="i-command" viewBox="0 0 24 24"><path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/></symbol>' +
  "</svg>";

document.body.insertAdjacentHTML("afterbegin", SPRITE);

/* ---------- 浮动小组件：主题切换（☀/🌙/自动循环）+ 返回原型导航 ---------- */
var THEME_KEY = "agentic-proto-theme";
var MODES = ["light", "dark", "auto"];
var MODE_META = {
  light: { icon: "i-sun", label: "浅色" },
  dark: { icon: "i-moon", label: "深色" },
  auto: { icon: "i-monitor", label: "自动" },
};

var isIndex = document.body.getAttribute("data-page") === "index";
var widget = document.createElement("div");
widget.className = "proto-widget";
widget.innerHTML =
  '<button class="pw-btn pw-theme" type="button" title="切换主题">' +
  '<svg class="ic"><use href="#i-sun"/></svg><span class="pw-theme-label">浅色</span>' +
  "</button>" +
  (isIndex
    ? ""
    : '<span class="pw-divider"></span><a class="pw-btn" href="index.html">' +
      '<svg class="ic"><use href="#i-home"/></svg><span>原型导航</span></a>');
document.body.appendChild(widget);

var themeBtn = widget.querySelector(".pw-theme");
var media = window.matchMedia("(prefers-color-scheme: dark)");

function getMode() {
  var saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch (e) {}
  if (MODES.indexOf(saved) === -1) {
    return "auto";
  }
  return saved;
}

function resolvedTheme(mode) {
  if (mode === "auto") {
    return media.matches ? "dark" : "light";
  }
  return mode;
}

function applyMode(mode) {
  document.documentElement.setAttribute("data-theme", resolvedTheme(mode));
  var meta = MODE_META[mode];
  themeBtn.querySelector("use").setAttribute("href", "#" + meta.icon);
  themeBtn.querySelector(".pw-theme-label").textContent = meta.label;
}

themeBtn.addEventListener("click", function () {
  var current = getMode();
  var next = MODES[(MODES.indexOf(current) + 1) % MODES.length];
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (e) {}
  applyMode(next);
});

media.addEventListener("change", function () {
  if (getMode() === "auto") {
    applyMode("auto");
  }
});
applyMode(getMode());

/* ---------- 工具调用卡：点击头部折叠 / 展开 ---------- */
var toolHeads = document.querySelectorAll("[data-tool] > .tool-head");
for (var i = 0; i < toolHeads.length; i++) {
  toolHeads[i].addEventListener("click", function () {
    this.parentElement.classList.toggle("open");
  });
}

/* ---------- 浏览器面板：标签 active 切换 ---------- */
var tabs = document.querySelectorAll(".browser-tabs .btab");
for (var j = 0; j < tabs.length; j++) {
  tabs[j].addEventListener("click", function (event) {
    if (event.target.closest(".btab-x")) {
      return;
    }
    var group = this.parentElement;
    var all = group.querySelectorAll(".btab");
    for (var k = 0; k < all.length; k++) {
      all[k].classList.remove("active");
    }
    this.classList.add("active");
    var url = this.getAttribute("data-url");
    var bar = document.querySelector(".address-bar .url-text");
    if (url && bar) {
      bar.innerHTML = url;
    }
  });
}
