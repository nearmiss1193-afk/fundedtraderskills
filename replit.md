# Sovereign Skill Hub

Minimal Node.js + Express starter for a skill marketplace.

## Endpoints

- `GET /health` - Returns "OK"
- `POST /api/create-skill` - Create a skill `{ name, description }` (in-memory)
- `GET /api/skills` - List all skills

## Structure

```
public/index.html   - Static frontend
server/routes.ts    - API endpoints
server/storage.ts   - In-memory skill storage
shared/schema.ts    - Zod validation schema
```

## Running

`npm run dev` starts the Express server on port 5000.
