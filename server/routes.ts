import type { Express } from "express";
import { type Server } from "http";

let skills: any[] = [];

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get("/health", (_req, res) => res.send("OK"));

  app.post("/api/create-skill", (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const skill = { id: Date.now(), name, description: description || "", createdAt: new Date() };
    skills.push(skill);
    res.json({ success: true, skill });
  });

  app.get("/api/skills", (_req, res) => res.json(skills));

  return httpServer;
}
