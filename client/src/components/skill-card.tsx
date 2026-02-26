import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Star, Users, Clock } from "lucide-react";
import type { Skill } from "@shared/schema";

interface SkillCardProps {
  skill: Skill;
}

export function SkillCard({ skill }: SkillCardProps) {
  const levelColors: Record<string, string> = {
    beginner: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
    intermediate: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
    advanced: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-400",
  };

  return (
    <Link href={`/skills/${skill.id}`} data-testid={`card-skill-${skill.id}`}>
      <Card className="group cursor-pointer hover-elevate transition-all duration-200 h-full">
        <div className="aspect-[4/3] relative rounded-t-md overflow-hidden">
          <img
            src={skill.image || "/images/category-development.png"}
            alt={skill.title}
            className="w-full h-full object-cover"
            data-testid={`img-skill-${skill.id}`}
          />
          {skill.featured && (
            <Badge className="absolute top-3 left-3" variant="default" data-testid={`badge-featured-${skill.id}`}>
              Featured
            </Badge>
          )}
        </div>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <Badge variant="outline" className={levelColors[skill.level] || ""}>
              {skill.level}
            </Badge>
            {skill.duration && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {skill.duration}
              </span>
            )}
          </div>
          <h3 className="font-semibold text-sm leading-tight line-clamp-2" data-testid={`text-skill-title-${skill.id}`}>
            {skill.title}
          </h3>
          <p className="text-xs text-muted-foreground line-clamp-2">
            {skill.description}
          </p>
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1" data-testid={`text-skill-rating-${skill.id}`}>
                <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
                <span className="font-medium text-foreground">{Number(skill.rating).toFixed(1)}</span>
                <span>({skill.reviewCount})</span>
              </span>
              <span className="flex items-center gap-1" data-testid={`text-skill-students-${skill.id}`}>
                <Users className="w-3.5 h-3.5" />
                {skill.enrollCount?.toLocaleString()}
              </span>
            </div>
            <span className="font-bold text-sm" data-testid={`text-skill-price-${skill.id}`}>
              ${Number(skill.price).toFixed(2)}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
