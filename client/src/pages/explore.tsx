import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { SkillCard } from "@/components/skill-card";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { useState, useEffect } from "react";
import type { Skill, Category } from "@shared/schema";

export default function Explore() {
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const initialSearch = params.get("search") || "";
  const initialCategory = params.get("category") || "";
  const initialFeatured = params.get("featured") === "true";

  const [searchQuery, setSearchQuery] = useState(initialSearch);
  const [selectedLevel, setSelectedLevel] = useState<string>("all");
  const [selectedCategory, setSelectedCategory] = useState<string>(initialCategory || "all");

  const { data: categories } = useQuery<Category[]>({
    queryKey: ["/api/categories"],
  });

  const categoryId = categories?.find(c => c.slug === selectedCategory)?.id;

  const queryParams = new URLSearchParams();
  if (searchQuery) queryParams.set("search", searchQuery);
  if (categoryId) queryParams.set("categoryId", categoryId);
  if (selectedLevel !== "all") queryParams.set("level", selectedLevel);
  if (initialFeatured) queryParams.set("featured", "true");

  const { data: skills, isLoading } = useQuery<Skill[]>({
    queryKey: ["/api/skills", `?${queryParams.toString()}`],
  });

  useEffect(() => {
    const cat = params.get("category");
    if (cat) setSelectedCategory(cat);
    const search = params.get("search");
    if (search) setSearchQuery(search);
  }, [searchString]);

  const clearFilters = () => {
    setSearchQuery("");
    setSelectedLevel("all");
    setSelectedCategory("all");
  };

  const hasFilters = searchQuery || selectedLevel !== "all" || selectedCategory !== "all" || initialFeatured;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <div className="mb-8">
        <h1 className="text-3xl font-bold" data-testid="text-explore-title">
          {initialFeatured ? "Featured Skills" : "Explore Skills"}
        </h1>
        <p className="text-muted-foreground mt-1">
          {initialFeatured ? "Our handpicked selection of top-quality courses" : "Discover skills that match your interests and goals"}
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-8">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search by title..."
            className="pl-9"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-testid="input-explore-search"
          />
        </div>
        <Select value={selectedCategory} onValueChange={setSelectedCategory}>
          <SelectTrigger className="w-full sm:w-48" data-testid="select-category">
            <SlidersHorizontal className="w-4 h-4 mr-2" />
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {categories?.map((cat) => (
              <SelectItem key={cat.id} value={cat.slug} data-testid={`option-category-${cat.slug}`}>
                {cat.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={selectedLevel} onValueChange={setSelectedLevel}>
          <SelectTrigger className="w-full sm:w-40" data-testid="select-level">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Levels</SelectItem>
            <SelectItem value="beginner">Beginner</SelectItem>
            <SelectItem value="intermediate">Intermediate</SelectItem>
            <SelectItem value="advanced">Advanced</SelectItem>
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button variant="ghost" size="icon" onClick={clearFilters} data-testid="button-clear-filters">
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="space-y-3">
              <Skeleton className="aspect-[4/3] rounded-md" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : skills && skills.length > 0 ? (
        <>
          <p className="text-sm text-muted-foreground mb-4" data-testid="text-results-count">
            {skills.length} skill{skills.length !== 1 ? "s" : ""} found
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {skills.map((skill) => (
              <SkillCard key={skill.id} skill={skill} />
            ))}
          </div>
        </>
      ) : (
        <div className="text-center py-20">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
            <Search className="w-8 h-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-1" data-testid="text-no-results">No skills found</h3>
          <p className="text-muted-foreground text-sm">
            Try adjusting your search or filters
          </p>
          <Button variant="secondary" className="mt-4" onClick={clearFilters} data-testid="button-clear-all">
            Clear All Filters
          </Button>
        </div>
      )}
    </div>
  );
}
