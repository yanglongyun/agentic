import { fail } from "../../../../http.js";
import { readImage } from "../../../../../images.js";
export default async function get(req, res, context, id, name) {
  const url = `/api/images/${name}`;
  const uploaded = context.db
    .prepare("SELECT url FROM session_images WHERE session_id = ? AND url = ?")
    .get(id, url);
  const saved = context.db
    .prepare(
      `SELECT messages.id FROM messages, json_each(CASE WHEN json_extract(item,'$.type') = 'message' THEN json_extract(item,'$.content') WHEN json_type(item,'$.output') = 'array' THEN json_extract(item,'$.output') ELSE '[]' END) AS part WHERE session_id = ? AND json_extract(part.value,'$.image_url') = ? LIMIT 1`,
    )
    .get(id, url);
  if (!uploaded && !saved) {
    fail(404, "图片不存在");
  }
  try {
    const image = await readImage(context.paths.images, name);
    res.writeHead(200, {
      "content-type": image.type,
      "content-length": image.bytes.length,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(image.bytes);
  } catch (error) {
    if (error.code === "ENOENT") {
      fail(404, "图片不存在");
    }
    throw error;
  }
}
