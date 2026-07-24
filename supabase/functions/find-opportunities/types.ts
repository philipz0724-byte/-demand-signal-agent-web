export const SEARCH_CATEGORIES = [
  'importers',
  'distributors',
  'dealers_resellers',
  'retailers',
  'brand_owners_private_label',
  'oem_component_buyers',
  'industrial_end_users',
  'commercial_institutional_buyers',
  'integrators_contractors',
  'procurement_channel_partners',
] as const

export type SearchCategory = (typeof SEARCH_CATEGORIES)[number]

export const FACTORY_ARCHETYPES = [
  'finished_goods_brand',
  'oem_odm_finished_goods',
  'commercial_equipment',
  'industrial_equipment',
  'components',
  'materials',
  'packaging',
  'custom_manufacturing',
  'mixed',
  'unknown',
] as const

export type FactoryArchetype = (typeof FACTORY_ARCHETYPES)[number]

export const PRODUCT_ROLES = [
  'finished_good',
  'commercial_equipment',
  'industrial_equipment',
  'component',
  'material',
  'packaging',
  'manufacturing_service',
  'mixed',
  'unknown',
] as const

export type ProductRole = (typeof PRODUCT_ROLES)[number]

export const BUYER_RELATIONSHIPS = [
  'importer',
  'distributor',
  'dealer_reseller',
  'retailer',
  'brand_owner',
  'private_label_buyer',
  'oem_buyer',
  'industrial_end_user',
  'commercial_end_user',
  'system_integrator',
  'contractor_specifier',
  'procurement_partner',
] as const

export type BuyerRelationship = (typeof BUYER_RELATIONSHIPS)[number]

export type FactoryInput = {
  product_summary: string
  cooperation_mode: string[]
  certifications: string[]
  commercial_terms: string
  notes: string
}

export type ProjectRecord = {
  id: string
  partner_name?: unknown
  website?: unknown
  website_url?: unknown
  offer?: unknown
  offer_description?: unknown
  target_geography?: unknown
  target_customer?: unknown
  minimum_deal_requirements?: unknown
  advantages?: unknown
  key_advantages?: unknown
  competitors?: unknown
  exclusions?: unknown
  exclusion_criteria?: unknown
  settings?: unknown
}

export type Project = {
  id: string
  partnerName: string
  website: string
  offer: string
  targetGeography: string[]
  targetCustomer: string
  minimumDealRequirements: string
  advantages: string[]
  competitors: string[]
  exclusions: string[]
  factoryInput: FactoryInput
}

export type CommercialTerms = {
  moq: string
  pricing: string
  lead_time: string
  incoterms: string[]
}

export type ExportReadiness = {
  score: number
  signals: string[]
  gaps: string[]
}

export type CompanyIntelligence = {
  company_role: string
  factory_archetype: FactoryArchetype
  business_model: string
  products: string[]
  product_applications: string[]
  manufacturing_capabilities: string[]
  target_market: string[]
  customer_segments: string[]
  pricing_position: string
  commercial_terms: CommercialTerms
  certifications: string[]
  distribution_channels: string[]
  geographic_focus: string[]
  ideal_downstream_buyers: string[]
  excluded_company_types: string[]
  export_readiness: ExportReadiness
  evidence_gaps: string[]
}

export type ValueChainPath = {
  buyer_segment: string
  relationship: BuyerRelationship
  buyer_uses_product_as: string
  purchase_motion: string
  priority: 1 | 2 | 3
  required_evidence: string
}

export type ValueChainMap = {
  seller_position: string
  product_role: ProductRole
  downstream_paths: ValueChainPath[]
  valid_buyer_relationships: BuyerRelationship[]
  conditional_buyer_types: string[]
  excluded_relationships: string[]
  search_categories: SearchCategory[]
  decision_rule: string
}

export type BuyerTier = {
  segment: string
  relationship: BuyerRelationship
  rationale: string
  purchase_use_case: string
  required_evidence: string
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
  qualification_questions: string[]
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
  relationship_to_factory: BuyerRelationship
  product_match: string
  purchase_use_case: string
  likely_order_type: string
  why_recommended: string
  why_now: string
  likely_buyer_role: string
  outreach_angle: string
  outreach_subject: string
  outreach_message: string
  next_action: string
  risk_flags: string[]
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
  diagnostics?: string[]
}

export type FindOpportunitiesResponse = {
  project_id: string
  queries: string[]
  searched_sources: number
  opportunities: Opportunity[]
  factory_profile?: CompanyIntelligence
  value_chain?: ValueChainMap
  icp?: IdealCustomerProfile
  warnings?: string[]
}

