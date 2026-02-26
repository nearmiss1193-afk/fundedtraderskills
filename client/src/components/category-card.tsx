import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Code, Palette, TrendingUp, Music, Camera, BarChart3 } from "lucide-react";
import type { Category } from "@shared/schema";

const iconMap: Record<string, any> = {
  Code, Palette, TrendingUp, Music, Camera, BarChart3,
};

interface CategoryCardProps {
  category: Category;
  skillCount?: number;
}

export function CategoryCard({ category, skillCount }: CategoryCardProps) {
  const IconComponent = iconMap[category.icon || "Code"] || Code;

  return (
    <Link href={`/explore?category=${category.slug}`} data-testid={`card-category-${category.slug}`}>
      <Card className="group cursor-pointer hover-elevate transition-all duration-200 h-full">
        <CardContent className="p-5 flex flex-col items-center text-center gap-3">
          <div className="w-14 h-14 rounded-md bg-primary/10 flex items-center justify-center">
            <IconComponent className="w-7 h-7 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-sm" data-testid={`text-category-name-${category.slug}`}>
              {category.name}
            </h3>
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2" data-testid={`text-category-desc-${category.slug}`}>
              {category.description}
            </p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
