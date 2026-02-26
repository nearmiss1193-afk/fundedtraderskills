import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SkillCard } from "@/components/skill-card";
import { CategoryCard } from "@/components/category-card";
import { ArrowRight, Sparkles, BookOpen, Users, Award } from "lucide-react";
import type { Skill, Category } from "@shared/schema";

export default function Home() {
  const { data: featuredSkills, isLoading: loadingSkills } = useQuery<Skill[]>({
    queryKey: ["/api/skills/featured"],
  });

  const { data: categories, isLoading: loadingCategories } = useQuery<Category[]>({
    queryKey: ["/api/categories"],
  });

  return (
    <div className="min-h-screen">
      <section className="relative overflow-hidden">
        <div className="absolute inset-0">
          <img src="/images/hero-bg.png" alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-black/50 to-background" />
        </div>
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24 sm:py-32 lg:py-40">
          <div className="max-w-2xl space-y-6">
            <Badge variant="secondary" className="gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              Discover Your Potential
            </Badge>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white leading-tight tracking-tight" data-testid="text-hero-title">
              Master Skills That
              <span className="block text-primary">Shape Your Future</span>
            </h1>
            <p className="text-lg text-white/70 max-w-lg">
              Learn from industry experts. Build real-world projects. Advance your career with skills that employers demand.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/explore">
                <Button size="lg" data-testid="button-explore-skills">
                  Explore Skills
                  <ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              </Link>
              <Link href="/categories">
                <Button size="lg" variant="outline" className="bg-white/10 backdrop-blur-sm border-white/20 text-white" data-testid="button-browse-categories">
                  Browse Categories
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 -mt-12 relative z-10">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { icon: BookOpen, label: "Expert-Led Courses", value: "50+", desc: "Curated by professionals" },
            { icon: Users, label: "Active Learners", value: "15K+", desc: "Growing community" },
            { icon: Award, label: "Completion Rate", value: "94%", desc: "Student satisfaction" },
          ].map((stat) => (
            <div key={stat.label} className="bg-card border rounded-md p-5 flex items-center gap-4" data-testid={`stat-${stat.label.toLowerCase().replace(/\s/g, '-')}`}>
              <div className="w-12 h-12 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                <stat.icon className="w-6 h-6 text-primary" />
              </div>
              <div>
                <div className="font-bold text-xl">{stat.value}</div>
                <div className="text-sm font-medium">{stat.label}</div>
                <div className="text-xs text-muted-foreground">{stat.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-20">
        <div className="flex items-center justify-between gap-4 mb-8">
          <div>
            <h2 className="text-2xl sm:text-3xl font-bold" data-testid="text-featured-heading">Featured Skills</h2>
            <p className="text-muted-foreground mt-1">Handpicked by our team for exceptional quality</p>
          </div>
          <Link href="/explore?featured=true">
            <Button variant="ghost" size="sm" data-testid="link-view-all-featured">
              View All <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          </Link>
        </div>
        {loadingSkills ? (
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
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {featuredSkills?.map((skill) => (
              <SkillCard key={skill.id} skill={skill} />
            ))}
          </div>
        )}
      </section>

      <section className="bg-card/50 border-y">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-20">
          <div className="text-center mb-10">
            <h2 className="text-2xl sm:text-3xl font-bold" data-testid="text-categories-heading">Explore Categories</h2>
            <p className="text-muted-foreground mt-1">Find the perfect skill for your learning journey</p>
          </div>
          {loadingCategories ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="space-y-3 p-4">
                  <Skeleton className="w-14 h-14 mx-auto rounded-md" />
                  <Skeleton className="h-4 w-20 mx-auto" />
                  <Skeleton className="h-3 w-24 mx-auto" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              {categories?.map((cat) => (
                <CategoryCard key={cat.id} category={cat} />
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-20">
        <div className="bg-primary rounded-md p-8 sm:p-12 text-center text-primary-foreground">
          <h2 className="text-2xl sm:text-3xl font-bold mb-3" data-testid="text-cta-heading">
            Ready to Start Learning?
          </h2>
          <p className="text-primary-foreground/80 max-w-lg mx-auto mb-6">
            Join thousands of learners building their future with skills that matter. Browse our catalog and start today.
          </p>
          <Link href="/explore">
            <Button size="lg" variant="secondary" data-testid="button-cta-browse">
              Browse All Skills
              <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          </Link>
        </div>
      </section>
    </div>
  );
}
