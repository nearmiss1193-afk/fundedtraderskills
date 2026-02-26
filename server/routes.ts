import type { Express } from "express";
import { type Server } from "http";
import { getAllSkills, createSkill } from "./storage";
import { skillSchema } from "@shared/schema";
import path from "path";
import express from "express";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.use(express.static(path.resolve(process.cwd(), "public")));

  app.get("/health", (_req, res) => {
    res.send("OK");
  });

  app.get("/api/skills", (_req, res) => {
    res.json(getAllSkills());
  });

  app.post("/api/create-skill", (req, res) => {
    const parsed = skillSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    }
    const skill = createSkill(parsed.data.name, parsed.data.description);
    res.status(201).json(skill);
  });

  app.get("/", (_req, res) => {
    res.sendFile(path.resolve(process.cwd(), "public", "index.html"));
  });

  return httpServer;
}
