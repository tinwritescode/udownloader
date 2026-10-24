import { formatBytes, send } from "./shared.js";

const list = document.getElementById("list");

const FORMAT_NAMES = { hls: "HLS stream", dash: "DASH stream", direct: "Video file" };
const BADGES = { hls: "HLS", dash: "DASH", direct: "FILE" };
const SAVE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12"></path><path d="m7 11 5 5 5-5"></path></svg>`;

// Stream manifests are often all called master.m3u8 or index.mpd, so
// include the parent folder to tell them apart.
function fileName(url, kind) {
  const { pathname, hostname } = new URL(url);
  const parts = pathname.split("/").filter(Boolean);
  const shown = kind === "direct" ? parts.slice(-1) : parts.slice(-2);
  return decodeURIComponent(shown.join("/") || hostname);
}

function row(item, tab) {
  const li = document.createElement("li");
  const badge = document.createElement("span");
  badge.className = `badge ${item.kind}`;
  badge.textContent = BADGES[item.kind];
  const info = document.createElement("div");
  info.className = "info";
  info.innerHTML = `<div class="title"></div><div class="file"></div>`;
  const size = item.kind === "direct" ? formatBytes(item.size) : "";
  info.querySelector(".title").textContent = FORMAT_NAMES[item.kind];
  if (size) {
    // Multi-GB files stand out before anyone clicks.
    const sizeEl = document.createElement("span");
    sizeEl.className = item.size >= 1024 ** 3 ? "size-large" : "";
    sizeEl.textContent = `, ${size}`;
    info.querySelector(".title").append(sizeEl);
  }
  info.querySelector(".file").textContent = fileName(item.url, item.kind);
  info.querySelector(".file").title = item.url;

  const button = document.createElement("button");
  button.className = "save";
  button.innerHTML = SAVE_ICON;
  button.setAttribute("aria-label", `Save ${FORMAT_NAMES[item.kind]} ${fileName(item.url, item.kind)}`);
  // Fall back to the tab URL: many CDNs reject requests without a page Referer.
  const referer = item.referer || tab.url;
  button.onclick = () => {
    const params = new URLSearchParams({ url: item.url, kind: item.kind, referer, title: tab.title ?? "" });
    // Same window as the video (incognito stays incognito; with "split"
    // mode the incognito copy of the extension owns this page and cookies).
    chrome.tabs.create({ url: `download.html?${params}`, windowId: tab.windowId, index: tab.index + 1, openerTabId: tab.id });
  };
  li.append(badge, info, button);
  return li;
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
document.getElementById("page-title").textContent = tab.title || "This page";
const host = tab.url ? new URL(tab.url).hostname : "";
const items = await send("list", { tabId: tab.id });
document.getElementById("empty").hidden = items.length > 0;
const count = `${items.length} ${items.length === 1 ? "video" : "videos"}`;
document.getElementById("page-meta").textContent = host ? `${host}, ${count}` : count;
// HLS first (usually the real stream), then larger files.
items.sort((a, b) => (b.kind === "hls") - (a.kind === "hls") || b.size - a.size);
list.append(...items.map((item) => row(item, tab)));
