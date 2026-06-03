export function resolveApiKey(userKey: string): string {
  return userKey.trim(); // Simply returns whatever the user provided (can be empty string)
}

export function hasEnvKey(): boolean {
  // Always true because your Cloudflare proxy deployment acts as the global fallback
  return true; 
}