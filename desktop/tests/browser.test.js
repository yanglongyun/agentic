import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { browserShortcut } from "../browser/shortcuts.js";
import { decryptCookie } from "../browser/chrome-cookie.js";

test("网页快捷键支持 macOS 和 Ctrl，普通输入不被拦截", () => {
  assert.equal(browserShortcut({ type: "keyDown", key: "T", meta: true }), "new");
  assert.equal(
    browserShortcut({ type: "keyDown", key: "T", control: true, shift: true }),
    "reopen",
  );
  assert.equal(
    browserShortcut({ type: "keyDown", key: "Tab", control: true, shift: true }),
    "previous-tab",
  );
  assert.equal(browserShortcut({ type: "keyDown", key: "ArrowLeft", alt: true }), "back");
  assert.equal(browserShortcut({ type: "keyDown", key: "f" }), "");
  assert.equal(browserShortcut({ type: "keyUp", key: "w", meta: true }), "");
});
test("当前 Chrome Cookie 解密验证所属域名，不接受其他格式", () => {
  const key = pbkdf2Sync("synthetic-test-password", "saltysalt", 1003, 16, "sha1");
  const host = ".example.test";
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  const plain = Buffer.concat([
    createHash("sha256").update(host).digest(),
    Buffer.from("test-cookie-value"),
  ]);
  const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
  assert.equal(decryptCookie(encrypted, key, host), "test-cookie-value");
  assert.throws(() => decryptCookie(encrypted, key, "other.test"), /域名/);
  assert.throws(() => decryptCookie(Buffer.from("v20unknown"), key, host), /格式/);
});
