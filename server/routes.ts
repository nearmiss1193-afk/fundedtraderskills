import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertSkillSchema, insertReviewSchema } from "@shared/schema";
import { seedDatabase } from "./seed";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await seedDatabase();

  app.get("/api/categories", async (_req, res) => {
    try {
      const cats = await storage.getCategories();
      res.json(cats);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to fetch categories" });
    }
  });

  app.get("/api/categories/:slug", async (req, res) => {
    try {
      const category = await storage.getCategoryBySlug(req.params.slug);
      if (!category) return res.status(404).json({ message: "Category not found" });
      res.json(category);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to fetch category" });
    }
  });

  app.get("/api/skills", async (req, res) => {
    try {
      const { categoryId, search, level, featured } = req.query;
      const filters: any = {};
      if (categoryId) filters.categoryId = categoryId as string;
      if (search) filters.search = search as string;
      if (level) filters.level = level as string;
      if (featured === "true") filters.featured = true;
      const result = await storage.getSkills(filters);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to fetch skills" });
    }
  });

  app.get("/api/skills/featured", async (_req, res) => {
    try {
      const result = await storage.getFeaturedSkills();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to fetch featured skills" });
    }
  });

  app.get("/api/skills/:id", async (req, res) => {
    try {
      const skill = await storage.getSkillById(req.params.id);
      if (!skill) return res.status(404).json({ message: "Skill not found" });
      res.json(skill);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to fetch skill" });
    }
  });

  app.post("/api/skills", async (req, res) => {
    try {
      const parsed = insertSkillSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
      const skill = await storage.createSkill(parsed.data);
      res.status(201).json(skill);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to create skill" });
    }
  });

  app.get("/api/skills/:id/reviews", async (req, res) => {
    try {
      const revs = await storage.getReviewsBySkillId(req.params.id);
      res.json(revs);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to fetch reviews" });
    }
  });

  app.post("/api/skills/:id/reviews", async (req, res) => {
    try {
      const parsed = insertReviewSchema.safeParse({ ...req.body, skillId: req.params.id });
      if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
      const review = await storage.createReview(parsed.data);
      res.status(201).json(review);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to create review" });
    }
  });

  app.get("/api/users/:id", async (req, res) => {
    try {
      const user = await storage.getUser(req.params.id);
      if (!user) return res.status(404).json({ message: "User not found" });
      const { password, ...safeUser } = user;
      res.json(safeUser);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to fetch user" });
    }
  });

  return httpServer;
}
