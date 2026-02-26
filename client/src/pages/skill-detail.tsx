import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Star, Clock, Users, BarChart3, BookOpen, ChevronLeft, CheckCircle2 } from "lucide-react";
import type { Skill, Review, User } from "@shared/schema";

export default function SkillDetail() {
  const { id } = useParams<{ id: string }>();

  const { data: skill, isLoading } = useQuery<Skill>({
    queryKey: ["/api/skills", id],
  });

  const { data: reviews } = useQuery<(Review & { user?: User })[]>({
    queryKey: ["/api/skills", id, "reviews"],
  });

  const { data: instructor } = useQuery<Omit<User, "password">>({
    queryKey: ["/api/users", skill?.instructorId],
    enabled: !!skill?.instructorId,
  });

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Skeleton className="h-8 w-48 mb-6" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <Skeleton className="aspect-video rounded-md" />
            <Skeleton className="h-10 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <div>
            <Skeleton className="h-64 rounded-md" />
          </div>
        </div>
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 text-center">
        <h2 className="text-2xl font-bold mb-2">Skill not found</h2>
        <p className="text-muted-foreground mb-4">The skill you're looking for doesn't exist.</p>
        <Link href="/explore">
          <Button data-testid="button-back-explore">Back to Explore</Button>
        </Link>
      </div>
    );
  }

  const levelColors: Record<string, string> = {
    beginner: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
    intermediate: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
    advanced: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-400",
  };

  const highlights = [
    "Hands-on projects and exercises",
    "Lifetime access to content",
    "Certificate of completion",
    "Community support and Q&A",
    "Regular content updates",
  ];

  return (
    <div className="min-h-screen">
      <div className="bg-card/50 border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <Link href="/explore" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-back-explore">
            <ChevronLeft className="w-4 h-4" />
            Back to Explore
          </Link>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
            <div className="aspect-video rounded-md overflow-hidden">
              <img
                src={skill.image || "/images/category-development.png"}
                alt={skill.title}
                className="w-full h-full object-cover"
                data-testid="img-skill-detail"
              />
            </div>

            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={levelColors[skill.level] || ""}>
                  {skill.level}
                </Badge>
                {skill.featured && <Badge>Featured</Badge>}
                {skill.tags?.map((tag) => (
                  <Badge key={tag} variant="secondary">{tag}</Badge>
                ))}
              </div>

              <h1 className="text-3xl sm:text-4xl font-bold leading-tight" data-testid="text-skill-detail-title">
                {skill.title}
              </h1>
              <p className="text-lg text-muted-foreground">
                {skill.description}
              </p>

              <div className="flex flex-wrap items-center gap-4 text-sm">
                <span className="flex items-center gap-1.5">
                  <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
                  <span className="font-semibold">{Number(skill.rating).toFixed(1)}</span>
                  <span className="text-muted-foreground">({skill.reviewCount} reviews)</span>
                </span>
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Users className="w-4 h-4" />
                  {skill.enrollCount?.toLocaleString()} students
                </span>
                {skill.duration && (
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Clock className="w-4 h-4" />
                    {skill.duration}
                  </span>
                )}
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <BarChart3 className="w-4 h-4" />
                  {skill.level}
                </span>
              </div>
            </div>

            <Separator />

            {instructor && (
              <div className="flex items-center gap-4">
                <Avatar className="w-12 h-12">
                  <AvatarFallback className="bg-primary/10 text-primary font-semibold">
                    {instructor.displayName.split(" ").map(n => n[0]).join("")}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-semibold" data-testid="text-instructor-name">{instructor.displayName}</p>
                  <p className="text-sm text-muted-foreground line-clamp-1">{instructor.bio}</p>
                </div>
              </div>
            )}

            <Separator />

            <div>
              <h2 className="text-xl font-bold mb-3" data-testid="text-about-heading">About This Skill</h2>
              <p className="text-muted-foreground leading-relaxed whitespace-pre-line">
                {skill.longDescription || skill.description}
              </p>
            </div>

            <div>
              <h2 className="text-xl font-bold mb-4" data-testid="text-highlights-heading">What You'll Get</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {highlights.map((item) => (
                  <div key={item} className="flex items-center gap-2 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>

            {reviews && reviews.length > 0 && (
              <div>
                <h2 className="text-xl font-bold mb-4" data-testid="text-reviews-heading">
                  Reviews ({reviews.length})
                </h2>
                <div className="space-y-4">
                  {reviews.map((review) => (
                    <Card key={review.id}>
                      <CardContent className="p-4">
                        <div className="flex items-start gap-3">
                          <Avatar className="w-9 h-9">
                            <AvatarFallback className="text-xs bg-muted">
                              {review.user?.displayName?.split(" ").map(n => n[0]).join("") || "?"}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2 mb-1">
                              <span className="font-medium text-sm" data-testid={`text-reviewer-${review.id}`}>
                                {review.user?.displayName || "Anonymous"}
                              </span>
                              <div className="flex items-center gap-0.5">
                                {[...Array(5)].map((_, i) => (
                                  <Star
                                    key={i}
                                    className={`w-3.5 h-3.5 ${i < review.rating ? "text-amber-500 fill-amber-500" : "text-muted"}`}
                                  />
                                ))}
                              </div>
                            </div>
                            <p className="text-sm text-muted-foreground">{review.comment}</p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="lg:col-span-1">
            <div className="sticky top-20">
              <Card>
                <CardContent className="p-6 space-y-5">
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold" data-testid="text-skill-detail-price">
                      ${Number(skill.price).toFixed(2)}
                    </span>
                  </div>
                  <Button className="w-full" size="lg" data-testid="button-enroll">
                    <BookOpen className="w-4 h-4 mr-2" />
                    Enroll Now
                  </Button>
                  <Separator />
                  <div className="space-y-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Level</span>
                      <span className="font-medium capitalize">{skill.level}</span>
                    </div>
                    {skill.duration && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">Duration</span>
                        <span className="font-medium">{skill.duration}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Students</span>
                      <span className="font-medium">{skill.enrollCount?.toLocaleString()}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Rating</span>
                      <span className="font-medium flex items-center gap-1">
                        <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
                        {Number(skill.rating).toFixed(1)}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
