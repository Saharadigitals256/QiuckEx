"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { User } from "@/lib/mockData";
import {
  DiscoveryCategory,
  fetchDiscoveryProfiles,
  PaginatedDiscoveryResult,
} from "@/hooks/discoveryApi";

export default function DiscoveryPage() {
  const [isLoading, setIsLoading] = useState(true);
  const [category, setCategory] = useState<DiscoveryCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(8);
  const [result, setResult] = useState<PaginatedDiscoveryResult>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 8,
    totalPages: 1,
    isDegraded: false,
  });
  const [error, setError] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchDiscoveryProfiles({
        category,
        query: searchQuery,
        page,
        pageSize,
      });
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load discovery profiles.");
    } finally {
      setIsLoading(false);
    }
  }, [category, searchQuery, page, pageSize]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    setPage(1);
  };

  const handleCategoryChange = (cat: DiscoveryCategory) => {
    setCategory(cat);
    setPage(1);
  };

  const UserCard = ({ user }: { user: User }) => (
    <Link href={`/${user.username}`} className="block group">
      <div className="p-6 rounded-3xl bg-card border border-border hover:border-indigo-500/30 hover:bg-card/80 transition-all h-full flex flex-col shadow-lg shadow-black/20 group-hover:shadow-indigo-500/10">
        <div className="flex items-start justify-between mb-5">
          <div
            className={`w-14 h-14 rounded-2xl flex items-center justify-center font-bold text-2xl shadow-inner text-white ${user.avatarColor}`}
          >
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div className="flex flex-col items-end">
            <span className="text-xs font-semibold text-subtle bg-background/50 px-3 py-1.5 rounded-full border border-border">
              {Number(user.followers).toLocaleString()} followers
            </span>
          </div>
        </div>
        <h3 className="text-lg font-bold text-foreground group-hover:text-indigo-400 transition-colors">
          {user.name}
        </h3>
        <p className="text-sm text-brand/80 mb-4 tracking-tight">@{user.username}</p>
        <p className="text-sm text-subtle flex-1 leading-relaxed">{user.bio}</p>

        <div className="mt-6 pt-4 border-t border-border flex items-center justify-between text-xs text-subtle font-medium group-hover:text-indigo-400 transition-colors">
          <span>View Profile</span>
          <span aria-hidden="true">→</span>
        </div>
      </div>
    </Link>
  );

  const SkeletonCard = () => (
    <div
      className="p-6 rounded-3xl bg-card/20 border border-border h-full flex flex-col animate-pulse"
      aria-hidden="true"
    >
      <div className="flex items-start justify-between mb-5">
        <div className="w-14 h-14 rounded-2xl bg-surface-strong"></div>
        <div className="w-24 h-7 rounded-full bg-surface"></div>
      </div>
      <div className="w-2/3 h-5 rounded bg-surface-strong mb-2 mt-1"></div>
      <div className="w-1/3 h-4 rounded bg-surface mb-5"></div>
      <div className="w-full h-3 rounded bg-surface mb-2"></div>
      <div className="w-4/5 h-3 rounded bg-surface mb-2"></div>
      <div className="w-1/2 h-3 rounded bg-surface"></div>

      <div className="mt-auto pt-4 border-t border-border flex items-center justify-between">
        <div className="w-1/4 h-3 rounded bg-surface"></div>
        <div className="w-4 h-4 rounded bg-surface"></div>
      </div>
    </div>
  );

  return (
    <div className="max-w-6xl mx-auto space-y-12 py-8 selection:bg-indigo-500/30 px-4">
      {/* Live region for accessibility announcements */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {isLoading
          ? "Loading creators..."
          : `Showing page ${result.page} of ${result.totalPages}. ${result.total} creators found.`}
      </div>

      <header className="space-y-6 text-center max-w-3xl mx-auto">
        <div className="w-16 h-16 bg-indigo-500/10 rounded-3xl flex items-center justify-center mx-auto mb-8 border border-indigo-500/20 shadow-xl shadow-indigo-500/10">
          <span className="text-3xl" role="img" aria-label="telescope">
            🔭
          </span>
        </div>
        <h1 className="text-5xl md:text-6xl font-black tracking-tighter">
          Discover{" "}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-cyan-400">
            QuickEx
          </span>
        </h1>
        <p className="text-xl text-subtle leading-relaxed">
          Find public profiles, connect with trending creators, and effortlessly send payments to
          active members of the community.
        </p>

        {result.isDegraded && !isLoading && (
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-semibold"
            role="status"
          >
            <span>⚡ Offline / Degraded mode — showing cached profiles</span>
          </div>
        )}
      </header>

      {/* Filter and Search Controls */}
      <section className="space-y-6" aria-label="Search and filter creators">
        <div className="flex flex-col md:flex-row gap-4 items-stretch md:items-center justify-between bg-card p-4 rounded-3xl border border-border">
          {/* Category Tabs */}
          <div className="flex gap-2 flex-wrap" role="tablist" aria-label="Creator categories">
            {(
              [
                { id: "all", label: "All Creators" },
                { id: "trending", label: "🔥 Trending" },
                { id: "recent", label: "✨ Recently Active" },
                { id: "featured", label: "⭐ Featured" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={category === tab.id}
                onClick={() => handleCategoryChange(tab.id)}
                className={`px-4 py-2 rounded-xl text-sm font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 ${
                  category === tab.id
                    ? "bg-indigo-600 text-white shadow-md shadow-indigo-500/20"
                    : "bg-surface hover:bg-surface-strong text-subtle hover:text-foreground"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Search Input */}
          <div className="relative min-w-[280px]">
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search by name or username..."
              aria-label="Search creators by name or username"
              className="w-full bg-surface border border-border rounded-xl px-4 py-2.5 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition text-foreground placeholder:text-subtle"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => handleSearchChange("")}
                aria-label="Clear search query"
                className="absolute right-3 top-2.5 text-subtle hover:text-foreground text-sm font-bold"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Error state */}
      {error && !isLoading && (
        <div
          role="alert"
          className="p-6 rounded-3xl bg-red-500/10 border border-red-500/30 text-center space-y-3"
        >
          <p className="text-red-400 font-semibold">{error}</p>
          <button
            onClick={() => void loadProfiles()}
            className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-xl text-sm font-bold transition"
          >
            Retry Loading
          </button>
        </div>
      )}

      {/* Creators Grid / Loading Boundary */}
      <section aria-label="Creators list">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {isLoading
            ? [...Array(pageSize)].map((_, i) => <SkeletonCard key={`skeleton-${i}`} />)
            : result.items.map((user) => <UserCard key={`user-${user.id}`} user={user} />)}
        </div>

        {/* Empty state */}
        {!isLoading && result.items.length === 0 && (
          <div className="p-12 rounded-3xl bg-card border border-border text-center space-y-4">
            <span className="text-4xl" role="img" aria-label="magnifying glass">
              🔍
            </span>
            <h2 className="text-xl font-bold">No creators found</h2>
            <p className="text-sm text-subtle max-w-md mx-auto">
              No profiles match your current search and filter criteria. Try adjusting your query or
              switching categories.
            </p>
            <button
              onClick={() => {
                setSearchQuery("");
                setCategory("all");
              }}
              className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-500 transition"
            >
              Reset Filters
            </button>
          </div>
        )}
      </section>

      {/* Pagination Boundary Controls */}
      {!isLoading && result.totalPages > 1 && (
        <nav
          className="flex items-center justify-between border-t border-border pt-6"
          aria-label="Discovery pagination"
        >
          <div className="text-sm text-subtle">
            Showing <span className="font-semibold text-foreground">{result.items.length}</span> of{" "}
            <span className="font-semibold text-foreground">{result.total}</span> creators
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              disabled={page <= 1}
              aria-label="Previous page"
              className="px-4 py-2 rounded-xl border border-border bg-card text-sm font-semibold hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              Previous
            </button>

            <span className="px-3 py-1 text-sm font-bold text-subtle">
              Page {result.page} of {result.totalPages}
            </span>

            <button
              onClick={() => setPage((prev) => Math.min(result.totalPages, prev + 1))}
              disabled={page >= result.totalPages}
              aria-label="Next page"
              className="px-4 py-2 rounded-xl border border-border bg-card text-sm font-semibold hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              Next
            </button>
          </div>
        </nav>
      )}

      {/* Join Community CTA */}
      {!isLoading && (
        <section className="mt-20 p-12 rounded-3xl bg-gradient-to-br from-indigo-900/40 to-cyan-900/20 border border-border-strong text-center space-y-6 relative overflow-hidden shadow-2xl shadow-indigo-500/5 group hover:border-border-strong transition-all">
          <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 mix-blend-overlay pointer-events-none"></div>
          <div className="absolute top-0 right-0 w-64 h-64 bg-cyan-500/20 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          <div className="absolute bottom-0 left-0 w-64 h-64 bg-indigo-500/20 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2"></div>

          <h2 className="text-4xl font-bold relative z-10 tracking-tight">Want to get featured?</h2>
          <p className="text-lg text-muted max-w-xl mx-auto relative z-10">
            Create your QuickEx profile, share your link, and start receiving payments to appear on
            the Discovery page.
          </p>
          <div className="relative z-10 pt-8">
            <Link
              href="/generator"
              className="inline-block px-10 py-4 bg-card text-foreground font-bold rounded-2xl hover:bg-surface-strong transition-all hover:scale-105 active:scale-95 shadow-xl shadow-white/10"
            >
              Claim Your Username
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
