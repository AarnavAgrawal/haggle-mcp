// Engine-side STAND-IN for Partner's packages/brain, used until it is published. It implements the
// frozen Brain interface with fixed, honest answers and does no learning (learning is Partner's
// code): estimates are empty, price checks are "unknown" with sample_size 0, discovery returns
// only the configured demo fleet, marked simulated. Replace with `@haggle/brain` when it lands.
import type { Brain, Business, Estimate, Hints, PriceVerdict, Profile } from "@haggle/core/contracts";

export class StubBrain implements Brain {
  readonly stub = true;
  constructor(private readonly fleet: Business[] = []) {}

  async learnFromReply(businessId: string): Promise<Profile> {
    const b = this.fleet.find((x) => x.business_id === businessId);
    return {
      business_id: businessId, slug: b?.slug ?? businessId, name: b?.name ?? businessId, simulated: b?.simulated ?? false,
      menu: [], price_model: {}, discount_behavior: { responds_to_competing_quote: null }, quote_count: 0, confidence: 0,
      updated_at: new Date().toISOString(),
    };
  }
  async estimate(): Promise<Estimate[]> {
    return [];
  }
  async checkPrice(): Promise<PriceVerdict> {
    return { verdict: "unknown", sample_size: 0, basis: "brain not connected (stub)" };
  }
  async negotiationHints(businessId: string): Promise<Hints> {
    return { business_id: businessId, responds_to_competing_quote: null, max_rounds_suggested: 1, sample_size: 0, confidence: 0 };
  }
  async discover(_category: string, _area: string, count: number): Promise<Business[]> {
    return this.fleet.slice(0, count);
  }
}
