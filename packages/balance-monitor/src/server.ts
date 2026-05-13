import express from "express";
import promClient from "prom-client";

export function startServer() {
  const app = express();
  const port = process.env.PORT ?? 3000;

  app.get("/metrics", async (_, res) => {
    res.set("Content-Type", promClient.register.contentType);
    res.end(await promClient.register.metrics());
  });

  app.listen(port, () => {
    console.log(`Server listening at ${port}`);
  });
}
