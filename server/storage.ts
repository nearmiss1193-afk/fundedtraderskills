import {
  type User, type InsertUser,
  type Category, type InsertCategory,
  type Skill, type InsertSkill,
  type Review, type InsertReview,
  users, categories, skills, reviews,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, ilike, and, sql } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  getCategories(): Promise<Category[]>;
  getCategoryBySlug(slug: string): Promise<Category | undefined>;
  createCategory(category: InsertCategory): Promise<Category>;

  getSkills(filters?: { categoryId?: string; search?: string; level?: string; featured?: boolean }): Promise<Skill[]>;
  getSkillById(id: string): Promise<Skill | undefined>;
  getFeaturedSkills(): Promise<Skill[]>;
  createSkill(skill: InsertSkill): Promise<Skill>;

  getReviewsBySkillId(skillId: string): Promise<(Review & { user?: User })[]>;
  createReview(review: InsertReview): Promise<Review>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async getCategories(): Promise<Category[]> {
    return db.select().from(categories);
  }

  async getCategoryBySlug(slug: string): Promise<Category | undefined> {
    const [category] = await db.select().from(categories).where(eq(categories.slug, slug));
    return category;
  }

  async createCategory(category: InsertCategory): Promise<Category> {
    const [created] = await db.insert(categories).values(category).returning();
    return created;
  }

  async getSkills(filters?: { categoryId?: string; search?: string; level?: string; featured?: boolean }): Promise<Skill[]> {
    const conditions = [];
    if (filters?.categoryId) conditions.push(eq(skills.categoryId, filters.categoryId));
    if (filters?.level) conditions.push(eq(skills.level, filters.level));
    if (filters?.featured) conditions.push(eq(skills.featured, true));
    if (filters?.search) conditions.push(ilike(skills.title, `%${filters.search}%`));

    if (conditions.length > 0) {
      return db.select().from(skills).where(and(...conditions)).orderBy(desc(skills.createdAt));
    }
    return db.select().from(skills).orderBy(desc(skills.createdAt));
  }

  async getSkillById(id: string): Promise<Skill | undefined> {
    const [skill] = await db.select().from(skills).where(eq(skills.id, id));
    return skill;
  }

  async getFeaturedSkills(): Promise<Skill[]> {
    return db.select().from(skills).where(eq(skills.featured, true)).limit(6);
  }

  async createSkill(skill: InsertSkill): Promise<Skill> {
    const [created] = await db.insert(skills).values(skill).returning();
    return created;
  }

  async getReviewsBySkillId(skillId: string): Promise<(Review & { user?: User })[]> {
    const reviewList = await db.select().from(reviews).where(eq(reviews.skillId, skillId)).orderBy(desc(reviews.createdAt));
    const enriched = await Promise.all(
      reviewList.map(async (review) => {
        const user = await this.getUser(review.userId);
        return { ...review, user };
      })
    );
    return enriched;
  }

  async createReview(review: InsertReview): Promise<Review> {
    const [created] = await db.insert(reviews).values(review).returning();
    const allReviews = await db.select().from(reviews).where(eq(reviews.skillId, review.skillId));
    const avgRating = allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length;
    await db.update(skills).set({
      rating: avgRating.toFixed(2),
      reviewCount: allReviews.length,
    }).where(eq(skills.id, review.skillId));
    return created;
  }
}

export const storage = new DatabaseStorage();
