export const SEARCH_CATEGORIES = [
  'dealers',
  'distributors',
  'retailers',
  'hospitality',
  'healthcare',
  'education',
  'government',
  'enterprise',
  'commercial_buyers',
  'channel_partners',
] as const

export type SearchCategory = (typeof SEARCH_CATEGORIES)[number]

export type ProjectRecord = {
  id: string
  partner_name?: unknown
  website?: unknown
  website_url?: unknown
  offer?: unknown
  offer_description?: unknown
  target_geography?: unknown
  target_customer?: unknown
  advantages?: unknown
  key_advantages?: unknown
  competitors?: unknown
  exclusions?: unknown
  exclusion_criteria?: unknown
}

export type Project = {
  id: string
  partnerName: string
  website: string
  offer: string
  targetGeography: string[]
  targetCustomer: string
  advantages: string[]
  competitors: string[]
  exclusions: string[]
}

export type CompanyIntelligence = {
  business_model: string
  products: string[]
  target_market: string[]
  customer_segments: string[]
  pricing_position: string
  distribution_channels: string[]
  geographic_focus: string[]
  ideal_downstream_buyers: string[]
  excluded_company_types: string[]
}

export type BuyerTier = {
  segment: string
  rationale: string
  purchase_use_case: string
}

export type DealSize = {
  currency: string
  minimum: number | null
  maximum: number | null
  basis: string
}

export type IdealCustomerProfile = {
  tier_1_buyers: BuyerTier[]
  tier_2_buyers: BuyerTier[]
  tier_3_buyers: BuyerTier[]
  buyer_personas: string[]
  purchasing_departments: string[]
  typical_purchase_cycle: string
  estimated_deal_size: DealSize
  disqualifiers: string[]
}

export type SearchPlan = Record<SearchCategory, string[]>

export type SearchPlanEntry = {
  category: SearchCategory
  query: string
}

export type RawSearchResult = {
  query: string
  category: SearchCategory
  title: string
  url: string
  content: string
  published_date?: string
}

export type CompanyEvidence = {
  title: string
  url: string
  snippet: string
  published_date?: string
}

export type NormalizedCompany = {
  company_name: string
  domain: string
  website: string
  matched_categories: SearchCategory[]
  matched_queries: string[]
  evidence: CompanyEvidence[]
}

export type ScoreDimensions = {
  buying_probability: number
  downstream_fit: number
  commercial_value: number
  estimated_purchasing_power: number
  timing: number
  evidence_quality: number
}

export type Opportunity = {
  company_name: string
  website: string
  location: string
  company_type: string
  opportunity_type: string
  why_recommended: string
  why_now: string
  likely_buyer_role: string
  outreach_angle: string
  fit_reason: string
  current_trigger: string
  likely_need: string
  evidence_title: string
  evidence_url: string
  evidence_snippet: string
  buyer_role: string
  opportunity_score: number
  confidence: number
  score_breakdown: ScoreDimensions
}

export type OpenAIConfig = {
  apiKey: string
  model: string
  reasoningEffort: string
}

export type TavilyConfig = {
  apiKey: string
  concurrency: number
}

export type EngineConfig = {
  openAI: OpenAIConfig
  tavily: TavilyConfig
}

export type FindOpportunitiesResponse = {
  project_id: string
  queries: string[]
  searched_sources: number
  opportunities: Opportunity[]
}
