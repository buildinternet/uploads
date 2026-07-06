import { Hono } from "hono";
import { bearerAuth } from "./auth";
import { files } from "./routes/files";

const app = new Hono<{ Bindings: Env }>()
  .get("/health", (c) => c.json({ ok: true }))
  .use("/v1/*", bearerAuth)
  .route("/v1/files", files)
  .onError((err, c) => {
    console.error(JSON.stringify({ message: err.message, stack: err.stack }));
    return c.json({ error: "internal error" }, 500);
  })
  .notFound((c) => c.json({ error: "not found" }, 404));

export default app;
