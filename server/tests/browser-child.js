import runTool from "../agent/runner.js";

const controllers = new Map();
process.on("message", async (message) => {
  if (message.type === "test:cancel") {
    controllers.get(message.id)?.abort(new Error("测试取消"));
  }
  if (message.type !== "test:run") {
    return;
  }
  const controller = new AbortController();
  controllers.set(message.id, controller);
  const config = {
    session_id: message.sessionId || "session-test",
    images_dir: message.directory,
    max_output: 2000,
    run_images: new Set(),
  };
  try {
    const result = await runTool(
      { name: "browser", arguments: JSON.stringify({ summary: "测试", code: message.code }) },
      config,
      controller.signal,
    );
    process.send({ type: "test:result", id: message.id, result, images: [...config.run_images] });
  } catch (error) {
    process.send({ type: "test:result", id: message.id, error: error.message });
  } finally {
    controllers.delete(message.id);
  }
});
