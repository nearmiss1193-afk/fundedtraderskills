# Sovereign Skill Hub

A skill marketplace web application built with React, Express, and PostgreSQL.

## Architecture

- **Frontend**: React + TypeScript + Tailwind CSS + shadcn/ui components
- **Backend**: Express.js REST API
- **Database**: PostgreSQL with Drizzle ORM
- **Routing**: wouter (client-side), Express (server-side)
- **State Management**: TanStack React Query

## Project Structure

```
client/src/
  components/       - Reusable UI components (navbar, footer, skill-card, category-card, theme-provider)
  pages/            - Page components (home, explore, skill-detail, categories, not-found)
  hooks/            - Custom hooks
  lib/              - Utilities and query client config
  components/ui/    - shadcn component library

server/
  index.ts          - Express server entry point
  routes.ts         - API route handlers
  storage.ts        - Database storage layer (IStorage interface)
  db.ts             - PostgreSQL connection (node-postgres + Drizzle)
  seed.ts           - Database seed data

shared/
  schema.ts         - Drizzle schema definitions and Zod validation
```

## Data Model

- **Users**: id, username, password, displayName, bio, avatar
- **Categories**: id, name, slug, description, image, icon
- **Skills**: id, title, description, longDescription, price, categoryId, instructorId, level, duration, image, rating, reviewCount, enrollCount, featured, tags, createdAt
- **Reviews**: id, skillId, userId, rating, comment, createdAt

## API Endpoints

- `GET /api/categories` - List all categories
- `GET /api/categories/:slug` - Get category by slug
- `GET /api/skills` - List skills with optional filters (categoryId, search, level, featured)
- `GET /api/skills/featured` - Get featured skills
- `GET /api/skills/:id` - Get skill by ID
- `POST /api/skills` - Create a new skill
- `GET /api/skills/:id/reviews` - Get reviews for a skill
- `POST /api/skills/:id/reviews` - Create a review
- `GET /api/users/:id` - Get user profile (without password)

## Pages

- `/` - Home page with hero, featured skills, categories, and CTA
- `/explore` - Browse/search/filter skills
- `/skills/:id` - Skill detail page with reviews
- `/categories` - All categories overview

## Theme

- Purple primary color (hsl 271 91% 65%)
- Light/dark mode toggle
- Open Sans font family
