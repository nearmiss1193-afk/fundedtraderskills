import { Zap } from "lucide-react";
import { Link } from "wouter";

export function Footer() {
  return (
    <footer className="border-t bg-card/50 mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center">
                <Zap className="w-5 h-5 text-primary-foreground" />
              </div>
              <span className="font-bold text-lg">Sovereign Skill Hub</span>
            </div>
            <p className="text-sm text-muted-foreground" data-testid="text-footer-description">
              Discover and master new skills from world-class instructors. Your journey to mastery starts here.
            </p>
          </div>
          <div>
            <h4 className="font-semibold text-sm mb-3">Explore</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/explore" data-testid="link-footer-browse">Browse Skills</Link></li>
              <li><Link href="/categories" data-testid="link-footer-categories">Categories</Link></li>
              <li><Link href="/explore?featured=true" data-testid="link-footer-featured">Featured</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold text-sm mb-3">Categories</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/explore?category=development" data-testid="link-footer-development">Development</Link></li>
              <li><Link href="/explore?category=design" data-testid="link-footer-design">Design</Link></li>
              <li><Link href="/explore?category=data-science" data-testid="link-footer-data-science">Data Science</Link></li>
              <li><Link href="/explore?category=marketing" data-testid="link-footer-marketing">Marketing</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold text-sm mb-3">Company</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li data-testid="text-footer-about">About Us</li>
              <li data-testid="text-footer-contact">Contact</li>
              <li data-testid="text-footer-privacy">Privacy Policy</li>
              <li data-testid="text-footer-terms">Terms of Service</li>
            </ul>
          </div>
        </div>
        <div className="border-t mt-8 pt-8 text-center text-xs text-muted-foreground" data-testid="text-footer-copyright">
          2026 Sovereign Skill Hub. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
