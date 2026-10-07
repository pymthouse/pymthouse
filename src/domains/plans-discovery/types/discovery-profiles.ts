import type { DiscoveryPolicy } from "@/shared/discovery/discovery-plans";

export interface DiscoveryProfileCapabilityInput {
  pipeline: string;
  modelId: string;
  discoveryPolicy: DiscoveryPolicy | null;
}

export interface CreateDiscoveryProfileInput {
  name: string;
  policy: DiscoveryPolicy | null;
  capabilities: DiscoveryProfileCapabilityInput[];
}

export interface UpdateDiscoveryProfileInput {
  name: string;
  policy?: DiscoveryPolicy | null;
  capabilities?: DiscoveryProfileCapabilityInput[];
}
