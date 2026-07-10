import { Hono } from "hono";
import { workspaceAuth, type WorkspaceVars } from "./workspace";
import { files } from "./routes/files";
import { admin } from "./routes/admin";
import { auth } from "./routes/auth";

const app = new Hono<WorkspaceVars>()
  .get("/health", (c) => c.json({ ok: true }))
  .route("/admin", admin)
  .route("/auth", auth)
  .use("/v1/:workspace/*", workspaceAuth)
  .route("/v1/:workspace/files", files)
  .onError((err, c) => {
    console.error(JSON.stringify({ message: err.message, stack: err.stack }));
    return c.json({ error: "internal error" }, 500);
  })
  .notFound((c) => c.json({ error: "not found" }, 404));

export default app;
