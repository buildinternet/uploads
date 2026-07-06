import { Hono } from "hono";
import { workspaceAuth, type WorkspaceVars } from "./workspace";
import { files } from "./routes/files";

const app = new Hono<WorkspaceVars>()
  .get("/health", (c) => c.json({ ok: true }))
  .use("/v1/:workspace/*", workspaceAuth)
  .route("/v1/:workspace/files", files)
  .onError((err, c) => {
    console.error(JSON.stringify({ message: err.message, stack: err.stack }));
    return c.json({ error: "internal error" }, 500);
  })
  .notFound((c) => c.json({ error: "not found" }, 404));

export default app;
