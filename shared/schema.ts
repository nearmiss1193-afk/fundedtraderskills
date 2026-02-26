import { z } from "zod";

export const skillSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

export type Skill = z.infer<typeof skillSchema> & { id: number };
