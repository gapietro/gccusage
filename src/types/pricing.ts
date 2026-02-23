export interface ModelPricing {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheCreationCostPerToken: number;
  cacheReadCostPerToken: number;
}

export type PricingTable = Record<string, ModelPricing>;
