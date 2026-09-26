import AsyncStorage from '@react-native-async-storage/async-storage';

const CACHE_KEY = '@contract_registry';
export const REGISTRY_CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

export interface ContractRegistryEntry {
  id: string;
  wasmHash: string;
  version: number;
  schemaVersion: string;
  schemaCompatibility: { min: string; max: string };
  networkPassphrase: string;
  deploymentId?: string;
  initParams?: Record<string, unknown>;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface ContractRegistry {
  [key: string]: ContractRegistryEntry;
}

interface ContractRegistryEnvelope {
  network: string;
  authoritative: boolean;
  version: number;
  etag: string;
  data: ContractRegistry;
}

export interface ContractRegistrySyncResult {
  registry: ContractRegistry;
  fetchedAt: number;
  isStale: boolean;
  source: 'network' | 'cache';
}

interface ContractRegistryCache {
  timestamp: number;
  data: ContractRegistry;
  etag?: string;
}

function readCachedRegistry(value: string | null): ContractRegistryCache | null {
  if (!value) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as ContractRegistryCache).timestamp === 'number' &&
      typeof (parsed as ContractRegistryCache).data === 'object' &&
      (parsed as ContractRegistryCache).data !== null
    ) {
      return parsed as ContractRegistryCache;
    }
  } catch {
    return null;
  }

  return null;
}

function isContractRegistryEnvelope(value: unknown): value is ContractRegistryEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ContractRegistryEnvelope).data === 'object' &&
    (value as ContractRegistryEnvelope).data !== null
  );
}

export const ContractRegistryService = {
  async sync(backendUrl: string): Promise<ContractRegistrySyncResult> {
    let cached: ContractRegistryCache | null = null;
    try {
      cached = readCachedRegistry(await AsyncStorage.getItem(CACHE_KEY));
    } catch {
      // Registry fetches should still work when local storage is unavailable.
    }

    try {
      const registryUrl = `${backendUrl.replace(/\/+$/, '')}/contracts/registry`;
      const response = await fetch(registryUrl, {
        headers: cached?.etag ? { 'If-None-Match': cached.etag } : {},
      });
      if (response.status === 404) {
        throw new Error('Contract registry route not found on backend');
      }
      if (response.status === 304) {
        if (!cached) {
          throw new Error('Registry returned not modified without a cached registry');
        }

        const timestamp = Date.now();
        const etag = response.headers?.get?.('ETag') ?? cached.etag;
        try {
          await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({
            timestamp,
            data: cached.data,
            ...(etag ? { etag } : {}),
          }));
        } catch {
          // A valid network result should not fail because cache storage is unavailable.
        }
        return {
          registry: cached.data,
          fetchedAt: timestamp,
          isStale: false,
          source: 'network',
        };
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch registry (status ${response.status})`);
      }

      const body: unknown = await response.json();
      if (!isContractRegistryEnvelope(body)) {
        throw new Error('Contract registry response payload is malformed');
      }

      const data = body.data;
      const timestamp = Date.now();
      const etag = response.headers?.get?.('ETag') ?? body.etag;
      try {
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({
          timestamp,
          data,
          ...(etag ? { etag } : {}),
        }));
      } catch {
        // Keep the fresh registry usable even if local persistence fails.
      }
      return {
        registry: data,
        fetchedAt: timestamp,
        isStale: false,
        source: 'network',
      };
    } catch (error) {
      if (cached) {
        // Serve stale cache if offline or backend returned bad data
        return {
          registry: cached.data,
          fetchedAt: cached.timestamp,
          isStale: Date.now() - cached.timestamp > REGISTRY_CACHE_TTL_MS,
          source: 'cache',
        };
      }
      const reason = error instanceof Error ? error.message : 'unknown error';
      throw new Error(`Registry unavailable and no cache found: ${reason}`);
    }
  },

  async getContract(name: string): Promise<string> {
    const cached = await AsyncStorage.getItem(CACHE_KEY);
    if (!cached) throw new Error('Registry missing');
    const registry = JSON.parse(cached).data;
    if (!registry[name]) throw new Error(`Contract ${name} missing from registry`);
    return registry[name].id;
  }
};
