import "dotenv/config";
import { serve } from "@hono/node-server";

const { createApp } = await import("./app.js");
const app = createApp();

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Common Days API listening on http://localhost:${info.port}`);
});
