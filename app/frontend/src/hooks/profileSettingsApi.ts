import { getQuickexApiBase } from "@/lib/api";

export type ProfileSettings = {
  username: string;
  publicKey: string;
  profileVersion: number;
  primaryColor: string;
  avatarUrl: string;
  bio: string;
  twitterHandle: string;
  discordHandle: string;
  githubHandle: string;
};

export class ProfileSettingsRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProfileSettingsRequestError";
  }
}

type BackendProfileSettings = {
  username: string;
  public_key: string;
  profile_version: number;
  profile_primary_color: string;
  avatar_url: string | null;
  bio: string;
  twitter_handle: string;
  discord_handle: string;
  github_handle: string;
};

function toProfileSettings(profile: BackendProfileSettings): ProfileSettings {
  return {
    username: profile.username,
    publicKey: profile.public_key,
    profileVersion: profile.profile_version,
    primaryColor: profile.profile_primary_color,
    avatarUrl: profile.avatar_url ?? "",
    bio: profile.bio,
    twitterHandle: profile.twitter_handle,
    discordHandle: profile.discord_handle,
    githubHandle: profile.github_handle,
  };
}

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Profile settings request failed (${response.status}).`;
    try {
      const body = (await response.json()) as { message?: string | { message?: string } };
      if (typeof body.message === "string") message = body.message;
      else if (body.message?.message) message = body.message.message;
    } catch {
      // Keep the status-based message if the server response has no JSON body.
    }
    throw new ProfileSettingsRequestError(message, response.status);
  }
  return (await response.json()) as T;
}

export async function fetchProfileSettings(publicKey: string): Promise<ProfileSettings[]> {
  const url = new URL(`${getQuickexApiBase()}/username/profile`);
  url.searchParams.set("publicKey", publicKey);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const result = await readResponse<{ profiles: BackendProfileSettings[] }>(response);
  return result.profiles.map(toProfileSettings);
}

export async function saveProfileSettings(
  profile: ProfileSettings,
): Promise<ProfileSettings> {
  const response = await fetch(`${getQuickexApiBase()}/username/profile`, {
    method: "PATCH",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      username: profile.username,
      publicKey: profile.publicKey,
      profileVersion: profile.profileVersion,
      primaryColor: profile.primaryColor,
      avatarUrl: profile.avatarUrl || null,
      bio: profile.bio,
      twitterHandle: profile.twitterHandle,
      discordHandle: profile.discordHandle,
      githubHandle: profile.githubHandle,
    }),
  });
  const result = await readResponse<{ profile: BackendProfileSettings }>(response);
  return toProfileSettings(result.profile);
}