import type { Skill } from "@shared/schema";

const skills: Skill[] = [];
let nextId = 1;

export function getAllSkills(): Skill[] {
  return skills;
}

export function createSkill(name: string, description: string): Skill {
  const skill: Skill = { id: nextId++, name, description };
  skills.push(skill);
  return skill;
}
