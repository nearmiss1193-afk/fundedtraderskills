import { db } from "./db";
import { users, categories, skills, reviews } from "@shared/schema";
import { eq } from "drizzle-orm";

export async function seedDatabase() {
  const existingCategories = await db.select().from(categories);
  if (existingCategories.length > 0) return;

  const [instructor1] = await db.insert(users).values({
    username: "elena_code",
    password: "hashed_placeholder",
    displayName: "Elena Rodriguez",
    bio: "Full-stack developer with 10 years of experience. Passionate about teaching modern web technologies.",
    avatar: null,
  }).returning();

  const [instructor2] = await db.insert(users).values({
    username: "marcus_design",
    password: "hashed_placeholder",
    displayName: "Marcus Chen",
    bio: "Senior UX/UI designer at a top tech company. Specializing in user-centered design and design systems.",
    avatar: null,
  }).returning();

  const [instructor3] = await db.insert(users).values({
    username: "sarah_data",
    password: "hashed_placeholder",
    displayName: "Sarah Williams",
    bio: "Data scientist and machine learning engineer. Former researcher at MIT.",
    avatar: null,
  }).returning();

  const [reviewer1] = await db.insert(users).values({
    username: "alex_student",
    password: "hashed_placeholder",
    displayName: "Alex Thompson",
    bio: "Lifelong learner exploring new skills.",
    avatar: null,
  }).returning();

  const categoryData = [
    { name: "Development", slug: "development", description: "Web, mobile, and software development skills", image: "/images/category-development.png", icon: "Code" },
    { name: "Design", slug: "design", description: "UI/UX, graphic design, and creative tools", image: "/images/category-design.png", icon: "Palette" },
    { name: "Marketing", slug: "marketing", description: "Digital marketing, SEO, and analytics", image: "/images/category-marketing.png", icon: "TrendingUp" },
    { name: "Music", slug: "music", description: "Music production, instruments, and audio engineering", image: "/images/category-music.png", icon: "Music" },
    { name: "Photography", slug: "photography", description: "Photo editing, composition, and camera techniques", image: "/images/category-photography.png", icon: "Camera" },
    { name: "Data Science", slug: "data-science", description: "Machine learning, AI, and data analysis", image: "/images/category-data.png", icon: "BarChart3" },
  ];

  const createdCategories = await db.insert(categories).values(categoryData).returning();

  const devCat = createdCategories.find(c => c.slug === "development")!;
  const designCat = createdCategories.find(c => c.slug === "design")!;
  const dataCat = createdCategories.find(c => c.slug === "data-science")!;
  const marketingCat = createdCategories.find(c => c.slug === "marketing")!;
  const musicCat = createdCategories.find(c => c.slug === "music")!;
  const photoCat = createdCategories.find(c => c.slug === "photography")!;

  const skillData = [
    {
      title: "Modern React with TypeScript",
      description: "Master React 19 with TypeScript, hooks, and modern patterns for building scalable applications.",
      longDescription: "This comprehensive course covers everything from React fundamentals to advanced patterns. You'll learn hooks, context, state management, TypeScript integration, testing, and deployment. Build real-world projects including a task manager, e-commerce dashboard, and social media feed.",
      price: "79.99",
      categoryId: devCat.id,
      instructorId: instructor1.id,
      level: "intermediate",
      duration: "24 hours",
      image: "/images/category-development.png",
      rating: "4.85",
      reviewCount: 342,
      enrollCount: 2847,
      featured: true,
      tags: ["React", "TypeScript", "Frontend"],
    },
    {
      title: "Full-Stack Node.js Masterclass",
      description: "Build production-ready APIs and web applications with Node.js, Express, and PostgreSQL.",
      longDescription: "From zero to deployment, this course teaches you how to build robust backend systems. Topics include REST APIs, authentication, database design, testing, Docker, and CI/CD pipelines. Includes 5 real-world projects.",
      price: "89.99",
      categoryId: devCat.id,
      instructorId: instructor1.id,
      level: "advanced",
      duration: "32 hours",
      image: "/images/category-development.png",
      rating: "4.72",
      reviewCount: 198,
      enrollCount: 1563,
      featured: true,
      tags: ["Node.js", "Express", "PostgreSQL", "Backend"],
    },
    {
      title: "UI/UX Design Fundamentals",
      description: "Learn the principles of great user interface and experience design from scratch.",
      longDescription: "This course covers color theory, typography, layout, user research, wireframing, prototyping, and usability testing. You'll work with Figma to create beautiful, functional designs that users love.",
      price: "59.99",
      categoryId: designCat.id,
      instructorId: instructor2.id,
      level: "beginner",
      duration: "18 hours",
      image: "/images/category-design.png",
      rating: "4.91",
      reviewCount: 567,
      enrollCount: 4231,
      featured: true,
      tags: ["UI", "UX", "Figma", "Design"],
    },
    {
      title: "Advanced Design Systems",
      description: "Create scalable, maintainable design systems that bridge design and development.",
      longDescription: "Learn to build component libraries, design tokens, documentation, and governance processes. This course covers atomic design, accessibility standards, and collaboration workflows between designers and developers.",
      price: "99.99",
      categoryId: designCat.id,
      instructorId: instructor2.id,
      level: "advanced",
      duration: "28 hours",
      image: "/images/category-design.png",
      rating: "4.68",
      reviewCount: 124,
      enrollCount: 892,
      featured: false,
      tags: ["Design Systems", "Components", "Tokens"],
    },
    {
      title: "Machine Learning with Python",
      description: "From fundamentals to deployment: master machine learning with hands-on projects.",
      longDescription: "Covers supervised and unsupervised learning, neural networks, natural language processing, computer vision, and model deployment. Uses scikit-learn, TensorFlow, and PyTorch with real datasets.",
      price: "109.99",
      categoryId: dataCat.id,
      instructorId: instructor3.id,
      level: "intermediate",
      duration: "40 hours",
      image: "/images/category-data.png",
      rating: "4.79",
      reviewCount: 289,
      enrollCount: 2156,
      featured: true,
      tags: ["Python", "ML", "TensorFlow", "AI"],
    },
    {
      title: "Data Visualization Mastery",
      description: "Tell compelling stories with data using modern visualization tools and techniques.",
      longDescription: "Learn D3.js, Tableau, and Python visualization libraries. Cover principles of visual encoding, dashboard design, interactive charts, and data storytelling for different audiences.",
      price: "69.99",
      categoryId: dataCat.id,
      instructorId: instructor3.id,
      level: "beginner",
      duration: "16 hours",
      image: "/images/category-data.png",
      rating: "4.55",
      reviewCount: 156,
      enrollCount: 1234,
      featured: false,
      tags: ["D3.js", "Tableau", "Visualization"],
    },
    {
      title: "Digital Marketing Strategy",
      description: "Build effective marketing campaigns across social media, search, and email channels.",
      longDescription: "Learn SEO, SEM, social media marketing, content marketing, email campaigns, analytics, and conversion optimization. Includes case studies from successful campaigns.",
      price: "49.99",
      categoryId: marketingCat.id,
      instructorId: instructor2.id,
      level: "beginner",
      duration: "14 hours",
      image: "/images/category-marketing.png",
      rating: "4.62",
      reviewCount: 203,
      enrollCount: 1876,
      featured: true,
      tags: ["SEO", "Social Media", "Analytics"],
    },
    {
      title: "Music Production Essentials",
      description: "Create professional-quality music using modern DAWs and production techniques.",
      longDescription: "Covers music theory, sound design, mixing, mastering, and music business. Work with Ableton Live and FL Studio to produce tracks across multiple genres.",
      price: "74.99",
      categoryId: musicCat.id,
      instructorId: instructor1.id,
      level: "beginner",
      duration: "22 hours",
      image: "/images/category-music.png",
      rating: "4.44",
      reviewCount: 87,
      enrollCount: 654,
      featured: false,
      tags: ["Ableton", "Production", "Mixing"],
    },
    {
      title: "Portrait Photography Masterclass",
      description: "Capture stunning portraits with any camera, from smartphones to DSLRs.",
      longDescription: "Learn lighting setups, posing techniques, composition rules, and post-processing workflows. Covers studio and outdoor photography with practical assignments.",
      price: "54.99",
      categoryId: photoCat.id,
      instructorId: instructor2.id,
      level: "intermediate",
      duration: "20 hours",
      image: "/images/category-photography.png",
      rating: "4.73",
      reviewCount: 145,
      enrollCount: 1098,
      featured: true,
      tags: ["Portraits", "Lighting", "Editing"],
    },
  ];

  const createdSkills = await db.insert(skills).values(skillData).returning();

  const reviewData = [
    { skillId: createdSkills[0].id, userId: reviewer1.id, rating: 5, comment: "Excellent course! The TypeScript integration examples were incredibly practical. I went from junior to mid-level confidence in React." },
    { skillId: createdSkills[0].id, userId: instructor3.id, rating: 5, comment: "Even as a data scientist, I found the React patterns here transferable and well-explained." },
    { skillId: createdSkills[2].id, userId: reviewer1.id, rating: 5, comment: "Marcus is an incredible teacher. The Figma exercises helped me build a real portfolio piece." },
    { skillId: createdSkills[4].id, userId: reviewer1.id, rating: 4, comment: "Great content on ML fundamentals. The TensorFlow sections could use more advanced examples." },
  ];

  await db.insert(reviews).values(reviewData);

  console.log("Database seeded successfully!");
}
