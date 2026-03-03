import express, { type Request, Response, NextFunction } from "express";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import path from "path";
import fs from "fs";

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] Unhandled rejection:", err);
});

const app = express();
let routesReady = false;

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/" || req.url === "/healthz" || req.url === "/healthz/" || req.url === "") {
    if (!routesReady) {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "2" });
      res.end("ok");
      return;
    }
    if (req.url === "/healthz" || req.url === "/healthz/") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "2" });
      res.end("ok");
      return;
    }
  }
  app(req, res);
});

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});

if (process.env.NODE_ENV === "production") {
  const distPath = path.resolve(__dirname, "public");
  const fallbackPath = path.resolve(process.cwd(), "dist", "public");
  const staticDir = fs.existsSync(distPath) ? distPath : fallbackPath;

  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir, { etag: false, lastModified: false, maxAge: 0 }));
    console.log(`[static] Serving production files from ${staticDir}`);
  } else {
    console.error(`[static] WARNING: No dist/public found at ${distPath} or ${fallbackPath}`);
  }
} else {
  app.use(express.static(path.resolve(process.cwd(), "public"), { etag: false, lastModified: false, maxAge: 0 }));
}

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const reqPath = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (reqPath.startsWith("/api")) {
      let logLine = `${req.method} ${reqPath} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        const jsonStr = JSON.stringify(capturedJsonResponse);
        logLine += ` :: ${jsonStr.length > 500 ? jsonStr.slice(0, 500) + '...[truncated]' : jsonStr}`;
      }
      log(logLine);
    }
  });

  next();
});

const port = parseInt(process.env.PORT || "5000", 10);
console.log(`[boot] Starting server on port ${port}, NODE_ENV=${process.env.NODE_ENV}`);

httpServer.listen(port, "0.0.0.0", () => {
  log(`serving on port ${port}`);
});

async function loadRoutes() {
  try {
    if (process.env.NODE_ENV === "production") {
      const routesFile = path.join(__dirname, "routes.cjs");
      const routesMod = await import(routesFile);
      const registerRoutes = routesMod.registerRoutes || routesMod.default?.registerRoutes;
      await registerRoutes(httpServer, app);
    } else {
      const { registerRoutes } = await import("./routes");
      await registerRoutes(httpServer, app);
    }
    routesReady = true;
    log("Routes registered successfully");
  } catch (err: any) {
    console.error(`[startup] Route registration error: ${err.message}`);
    routesReady = true;
  }

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    console.error("Internal Server Error:", err);
    if (res.headersSent) {
      return next(err);
    }
    return res.status(status).json({ message });
  });

  if (process.env.NODE_ENV !== "production") {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  } else {
    app.use("/{*path}", (_req: Request, res: Response) => {
      const distDir = path.resolve(__dirname, "public");
      const fallbackDir = path.resolve(process.cwd(), "dist", "public");
      const staticDir = fs.existsSync(distDir) ? distDir : fallbackDir;
      const indexPath = path.resolve(staticDir, "index.html");
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(200).send("Sovereign Skill Hub");
      }
    });
  }
}

setTimeout(loadRoutes, 500);
