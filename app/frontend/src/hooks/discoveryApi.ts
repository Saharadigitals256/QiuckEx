import { getQuickexApiBase } from "../lib/api";
import { MOCK_USERS, User } from "../lib/mockData";

export type DiscoveryCategory = "all" | "trending" | "recent" | "featured";

export interface DiscoveryFilterParams {
  category: DiscoveryCategory;
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface PaginatedDiscoveryResult {
  items: User[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  isDegraded: boolean;
}

const AVATAR_COLORS = [
  "bg-indigo-500",
  "bg-emerald-500",
  "bg-rose-500",
  "bg-blue-500",
  "bg-purple-500",
  "bg-amber-500",
  "bg-pink-500",
  "bg-cyan-500",
];

function getAvatarColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash << 5) - hash + username.charCodeAt(i);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function mapBackendProfileToUser(
  item: {
    id?: string;
    username: string;
    displayName?: string;
    bio?: string;
    followersCount?: number;
    isTrending?: boolean;
    isRecentlyActive?: boolean;
  },
  idx: number,
): User {
  return {
    id: item.id || `profile-${item.username}-${idx}`,
    username: item.username,
    name: item.displayName || item.username,
    avatarColor: getAvatarColor(item.username),
    bio: item.bio || `Public creator on QuickEx (@${item.username})`,
    followers: item.followersCount ?? 0,
    isTrending: item.isTrending,
    isRecentlyActive: item.isRecentlyActive,
  };
}

/**
 * Fetch creators from backend discovery endpoints with fallback to local mock data.
 * Supports filtering by category and search term, with pagination boundaries.
 */
export async function fetchDiscoveryProfiles(
  params: DiscoveryFilterParams,
): Promise<PaginatedDiscoveryResult> {
  const { category = "all", query = "", page = 1, pageSize = 8 } = params;
  const apiBase = getQuickexApiBase();

  let fetchedUsers: User[] = [];
  let isDegraded = false;

  try {
    if (query.trim().length >= 2) {
      const url = new URL(`${apiBase}/username/search`);
      url.searchParams.set("query", query.trim());
      url.searchParams.set("limit", "50");

      const res = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });

      if (!res.ok) {
        throw new Error(`Search failed: HTTP ${res.status}`);
      }

      const data = await res.json();
      const profiles = (data.profiles || data.results || []) as Array<{
        id?: string;
        username: string;
        displayName?: string;
        bio?: string;
      }>;
      fetchedUsers = profiles.map(mapBackendProfileToUser);
    } else if (category === "trending") {
      const res = await fetch(`${apiBase}/username/trending?limit=50`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Trending failed: HTTP ${res.status}`);
      const data = await res.json();
      const items = (data.items || data.creators || []) as Array<{
        username: string;
        displayName?: string;
        bio?: string;
      }>;
      fetchedUsers = items.map((item, idx) =>
        mapBackendProfileToUser({ ...item, isTrending: true }, idx),
      );
    } else if (category === "recent") {
      const res = await fetch(`${apiBase}/username/recently-active?limit=50`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Recently active failed: HTTP ${res.status}`);
      const data = await res.json();
      const items = (data.items || data.creators || []) as Array<{
        username: string;
        displayName?: string;
        bio?: string;
      }>;
      fetchedUsers = items.map((item, idx) =>
        mapBackendProfileToUser({ ...item, isRecentlyActive: true }, idx),
      );
    } else if (category === "featured") {
      const res = await fetch(`${apiBase}/username/featured?limit=50`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Featured failed: HTTP ${res.status}`);
      const data = await res.json();
      const items = (data.items || data.creators || []) as Array<{
        username: string;
        displayName?: string;
        bio?: string;
      }>;
      fetchedUsers = items.map(mapBackendProfileToUser);
    } else {
      // "all" - combine trending and recent
      const [trendRes, recentRes] = await Promise.allSettled([
        fetch(`${apiBase}/username/trending?limit=25`, { headers: { Accept: "application/json" }, cache: "no-store" }),
        fetch(`${apiBase}/username/recently-active?limit=25`, { headers: { Accept: "application/json" }, cache: "no-store" }),
      ]);

      const list: User[] = [];
      if (trendRes.status === "fulfilled" && trendRes.value.ok) {
        const trendData = await trendRes.value.json();
        const items = (trendData.items || trendData.creators || []) as Array<{ username: string }>;
        list.push(...items.map((i, idx) => mapBackendProfileToUser({ ...i, isTrending: true }, idx)));
      }
      if (recentRes.status === "fulfilled" && recentRes.value.ok) {
        const recentData = await recentRes.value.json();
        const items = (recentData.items || recentData.creators || []) as Array<{ username: string }>;
        list.push(...items.map((i, idx) => mapBackendProfileToUser({ ...i, isRecentlyActive: true }, idx + 100)));
      }

      // Deduplicate by username
      const seen = new Set<string>();
      fetchedUsers = list.filter((user) => {
        if (seen.has(user.username)) return false;
        seen.add(user.username);
        return true;
      });

      if (fetchedUsers.length === 0) {
        throw new Error("No backend users returned");
      }
    }
  } catch {
    // Graceful degraded mode: fallback to MOCK_USERS
    isDegraded = true;
    fetchedUsers = [...MOCK_USERS];
  }

  // Filter local dataset if degraded or needed
  let filtered = fetchedUsers;
  if (isDegraded) {
    if (category === "trending") {
      filtered = filtered.filter((u) => u.isTrending);
    } else if (category === "recent") {
      filtered = filtered.filter((u) => u.isRecentlyActive);
    }

    if (query.trim()) {
      const q = query.trim().toLowerCase();
      filtered = filtered.filter(
        (u) =>
          u.name.toLowerCase().includes(q) ||
          u.username.toLowerCase().includes(q) ||
          u.bio.toLowerCase().includes(q),
      );
    }
  }

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const items = filtered.slice(startIndex, startIndex + pageSize);

  return {
    items,
    total,
    page: currentPage,
    pageSize,
    totalPages,
    isDegraded,
  };
}
