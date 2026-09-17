import { createDecipheriv, createHash } from "node:crypto";

// 当前 macOS Chrome 的 v10 Cookie：AES-CBC，明文前 32 字节校验所属域名。
export function decryptCookie(value, key, host) {
  const bytes = Buffer.from(value);
  if (bytes.subarray(0, 3).toString() !== "v10") {
    throw new Error("不支持的 Chrome Cookie 加密格式");
  }
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  const plain = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]);
  if (!plain.subarray(0, 32).equals(createHash("sha256").update(host).digest())) {
    throw new Error("Cookie 域名校验失败");
  }
  return plain.subarray(32).toString("utf8");
}
