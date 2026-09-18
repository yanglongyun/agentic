import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../index.js";
import { defaults, paths } from "../config.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-browser-test-"));
  const token = "browser-test-token-123456";
  const runtime = createServer({
    p: paths({ AGENT_HOME: root }),
    config: { ...defaults(), workdir: root, api: { listen: "127.0.0.1:0", token } },
  });
  const origin = await runtime.listen();
  t.after(async () => {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function request(route, method = "GET", data) {
    const response = await fetch(origin + "/api/browser" + route, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  }
  async function sessionRequest(route = "", method = "POST") {
    const response = await fetch(origin + "/api/sessions" + route, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    return { status: response.status, body: await response.json() };
  }
  return { request, origin, sessionRequest, runtime };
}
test("浏览器接口要求登录；目录、书签、重命名与递归删除", async (t) => {
  const { request, origin } = await fixture(t);
  assert.equal((await fetch(origin + "/api/browser/bookmarks")).status, 401);
  const folder = await request("/bookmarks", "POST", { kind: "folder", title: "收藏" });
  assert.equal(folder.status, 201);
  const id = folder.body.bookmark.id;
  const nested = await request("/bookmarks", "POST", {
    kind: "folder",
    title: "子目录",
    parent_id: id,
  });
  const bookmark = await request("/bookmarks", "POST", {
    kind: "link",
    title: "示例",
    url: "https://example.com/",
    parent_id: nested.body.bookmark.id,
  });
  assert.equal(bookmark.status, 201);
  assert.equal(
    (
      await request("/bookmarks", "POST", {
        kind: "link",
        title: "bad",
        url: "javascript:alert(1)",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/bookmarks", "POST", {
        kind: "folder",
        title: "bad",
        parent_id: bookmark.body.bookmark.id,
      })
    ).status,
    400,
  );
  assert.equal(
    (await request(`/bookmarks/${id}`, "PATCH", { title: "资料" })).body.bookmark.title,
    "资料",
  );
  assert.equal(
    (
      await request(`/bookmarks/${id}`, "PATCH", {
        title: "bad",
        parent_id: nested.body.bookmark.id,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/bookmarks/${bookmark.body.bookmark.id}`, "PATCH", {
        title: "新网址",
        url: "https://new.test/",
        parent_id: id,
      })
    ).body.bookmark.url,
    "https://new.test/",
  );
  assert.equal((await request("/bookmarks")).body.bookmarks.length, 3);
  await request(`/bookmarks/${id}`, "DELETE");
  assert.equal((await request("/bookmarks")).body.bookmarks.length, 0);
});
test("书签批量导入保持层级，遇到错误整批回滚", async (t) => {
  const { request } = await fixture(t);
  const bookmarks = [{ title: "目录", children: [{ title: "网页", url: "https://example.com" }] }];
  assert.equal((await request("/bookmarks/import", "POST", { bookmarks })).body.count, 2);
  const before = (await request("/bookmarks")).body.bookmarks;
  const link = before.find((item) => item.kind === "link");
  assert.equal(link.parent_id, before.find((item) => item.kind === "folder").id);
  const bad = [...bookmarks, { title: "无效", url: "file:///tmp/test" }];
  assert.equal((await request("/bookmarks/import", "POST", { bookmarks: bad })).status, 400);
  assert.deepEqual((await request("/bookmarks")).body.bookmarks, before);
});
test("历史区分访问与元数据更新，支持搜索、分页和删除", async (t) => {
  const { request } = await fixture(t);
  const record = { url: "https://example.com/guide", title: "Guide", icon: "", visit: true };
  await request("/history", "POST", record);
  await request("/history", "POST", record);
  await request("/history", "POST", { ...record, title: "New guide", visit: false });
  await request("/history", "POST", { ...record, url: "https://another.test", title: "Second" });
  const found = (await request("/history?query=GUIDE")).body;
  assert.equal(found.total, 1);
  assert.equal(found.history[0].visits, 2);
  assert.equal(found.history[0].title, "New guide");
  assert.equal((await request("/history?offset=1")).body.history.length, 1);
  assert.equal((await request("/history?offset=Infinity")).status, 400);
  assert.equal((await request("/history", "POST", { url: "data:text/html,hello" })).status, 400);
  await request(`/history?url=${encodeURIComponent(record.url)}`, "DELETE");
  assert.equal((await request("/history")).body.total, 1);
  await request("/history", "DELETE");
  assert.equal((await request("/history")).body.total, 0);
});

test("标签按对话持久化，排序、选中、关闭原子保存，拒绝跨对话抢占", async (t) => {
  const { request, origin, sessionRequest, runtime } = await fixture(t);
  assert.equal((await fetch(origin + "/api/browser/pages")).status, 401);
  const a = (await sessionRequest()).body.id;
  const b = (await sessionRequest()).body.id;
  const first = { id: "first", url: "https://example.com/1", title: "一", icon: "", active: true };
  const second = { ...first, id: "second", url: "https://example.com/2", active: false };
  assert.equal(
    (await request("/pages", "PUT", { session_id: a, pages: [first, second] })).status,
    200,
  );
  const original = (await request(`/pages?session_id=${a}`)).body.pages;
  assert.deepEqual(
    original.map((page) => [page.id, page.position, page.active]),
    [
      ["first", 0, 1],
      ["second", 1, 0],
    ],
  );
  assert.equal((await request("/pages", "PUT", { session_id: b, pages: [first] })).status, 409);
  assert.equal(
    (await request("/pages", "PUT", { session_id: a, pages: [first, first] })).status,
    400,
  );
  assert.equal(
    (
      await request("/pages", "PUT", {
        session_id: a,
        pages: [{ ...first, url: "javascript:alert(1)" }],
      })
    ).status,
    400,
  );
  assert.deepEqual((await request(`/pages?session_id=${a}`)).body.pages, original);
  await request("/pages", "PUT", {
    session_id: a,
    pages: [
      { ...second, active: true },
      { ...first, title: "改名", active: false },
    ],
  });
  const changed = (await request(`/pages?session_id=${a}`)).body.pages;
  assert.deepEqual(
    changed.map((page) => page.id),
    ["second", "first"],
  );
  assert.equal(changed[1].created_at, original[0].created_at);
  assert.equal(changed[1].title, "改名");
  await request("/pages", "PUT", { session_id: a, pages: [first] });
  assert.equal(
    runtime.db.prepare("SELECT COUNT(*) AS n FROM browser_pages WHERE session_id = ?").get(a).n,
    1,
  );
  await request("/pages", "PUT", { session_id: b, pages: [{ ...second, active: true }] });
  assert.equal((await sessionRequest(`/${a}`, "DELETE")).status, 200);
  assert.deepEqual((await request(`/pages?session_id=${a}`)).body.pages, []);
  assert.equal((await request(`/pages?session_id=${b}`)).body.pages.length, 1);
  assert.equal((await request("/pages", "PUT", { session_id: a, pages: [first] })).status, 404);
});

test("草稿标签落库，转正式会话保留 ID 和创建时间；关闭全部后为空", async (t) => {
  const { request, sessionRequest } = await fixture(t);
  const page = { id: "draft-page", url: "about:blank", title: "新标签页", icon: "", active: true };
  await request("/pages", "PUT", { session_id: "", pages: [page] });
  const before = (await request("/pages?session_id=")).body.pages[0];
  assert.equal((await request("/pages/claim", "POST", { session_id: "missing" })).status, 404);
  const session_id = (await sessionRequest()).body.id;
  assert.equal((await request("/pages/claim", "POST", { session_id })).status, 200);
  assert.deepEqual((await request("/pages?session_id=")).body.pages, []);
  const saved = (await request(`/pages?session_id=${session_id}`)).body.pages[0];
  assert.equal(saved.id, before.id);
  assert.equal(saved.created_at, before.created_at);
  assert.equal(saved.active, 1);
  assert.equal((await request("/pages/claim", "POST", { session_id })).status, 409);
  await request("/pages", "PUT", { session_id, pages: [] });
  assert.deepEqual((await request("/pages")).body.pages, []);
});
