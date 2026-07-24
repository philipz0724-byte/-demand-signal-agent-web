import {
  BUYER_RELATIONSHIPS,
  FACTORY_ARCHETYPES,
  PRODUCT_ROLES,
  SEARCH_CATEGORIES,
  type BuyerRelationship,
  type BuyerTier,
  type CompanyEvidence,
  type CompanyIntelligence,
  type EngineConfig,
  type FactoryArchetype,
  type IdealCustomerProfile,
  type NormalizedCompany,
  type Opportunity,
  type ProductRole,
  type Project,
  type ProjectRecord,
  type RawSearchResult,
  type ScoreDimensions,
  type SearchCategory,
  type SearchPlan,
  type SearchPlanEntry,
  type ValueChainMap,
  type ValueChainPath,
} from './types.ts'
import {
  asFiniteNumber,
  asRecord,
  asString,
  asStringArray,
  clampScore,
  parseJsonObject,
} from './json.ts'
import {
  commercialJudgePrompt,
  companyAnalysisPrompt,
  icpPrompt,
  searchPlanPrompt,
  valueChainPrompt,
} from './prompts.ts'

const BLOCKED_DOMAIN_SUFFIXES = [
  'wikipedia.org',
  'medium.com',
  'substack.com',
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'x.com',
  'twitter.com',
  'reddit.com',
  'fliphtml5.com',
  'issuu.com',
  'scribd.com',
  'yumpu.com',
  'anyflip.com',
  'docdroid.net',
  'slideshare.net',
  'pinterest.com',
  'quora.com',
  'yelp.com',
  'yellowpages.com',
  'mapquest.com',
  'tripadvisor.com',
  'crunchbase.com',
  'zoominfo.com',
  'glassdoor.com',
  'indeed.com',
  'amazon.com',
  'ebay.com',
  'alibaba.com',
  'aliexpress.com',
  'etsy.com',
  'made-in-china.com',
  'globalsources.com',
  'prnewswire.com',
  'businesswire.com',
  'globenewswire.com',
  'forbes.com',
  'bloomberg.com',
  'reuters.com',
  'nytimes.com',
  'wsj.com',
  'marketwatch.com',
  'grandviewresearch.com',
  'marketsandmarkets.com',
  'fortunebusinessinsights.com',
  'researchandmarkets.com',
]

const TWO_LEVEL_PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.jp',
  'co.in',
  'com.sg',
  'com.cn',
  'com.mx',
  'com.br',
])

const SEARCH_EXCLUDED_DOMAINS = [...BLOCKED_DOMAIN_SUFFIXES]
const QUERY_REJECTION_PATTERN =
  /\b(industry report|market report|directory|list of|top \d+|best \d+|wholesale source|supplier directory|factory directory)\b/i
const RESULT_REJECTION_PATTERN =
  /\b(top \d+|best \d+|directory|market size|market report|industry report|buyers guide|news roundup)\b/i

type OpenAIResponse = {
  output_text?: string
  output?: Array<{ content?: Array<{ text?: string }> }>
  error?: { message?: string }
}

type TavilyResponse = {
  results?: Array<{
    title?: unknown
    url?: unknown
    content?: unknown
    published_date?: unknown
  }>
  detail?: unknown
}

type JudgeRecord = Record<string, unknown>

export function normalizeProject(record: ProjectRecord): Project {
  const website = asString(record.website_url) || asString(record.website)
  const settings = asRecord(record.settings)
  const factoryInput = asRecord(settings.factory_input)
  return {
    id: asString(record.id),
    partnerName: asString(record.partner_name) || domainLabel(website) || 'Unknown partner',
    website: normalizeWebsite(website),
    offer: asString(record.offer_description) || asString(record.offer),
    targetGeography: asStringArray(record.target_geography),
    targetCustomer: asString(record.target_customer),
    minimumDealRequirements: asString(record.minimum_deal_requirements),
    advantages: [
      ...asStringArray(record.key_advantages),
      ...asStringArray(record.advantages),
    ].filter(uniqueString),
    competitors: asStringArray(record.competitors),
    exclusions: [
      ...asStringArray(record.exclusion_criteria),
      ...asStringArray(record.exclusions),
    ].filter(uniqueString),
    factoryInput: {
      product_summary: asString(factoryInput.product_summary),
      cooperation_mode: asStringArray(factoryInput.cooperation_mode),
      certifications: asStringArray(factoryInput.certifications),
      commercial_terms: asString(factoryInput.commercial_terms),
      notes: asString(factoryInput.notes),
    },
  }
}

export async function analyzeCompany(
  project: Project,
  config: EngineConfig,
): Promise<CompanyIntelligence> {
  const fallback = fallbackCompanyIntelligence(project)

  try {
    const websiteEvidence = await collectWebsiteEvidence(project, config)
    const raw = await callOpenAIJson<Record<string, unknown>>(
      companyAnalysisPrompt(project, websiteEvidence),
      config,
      {},
    )
    return normalizeCompanyIntelligence(raw, fallback)
  } catch (error) {
    console.warn('Company analysis fell back to project data:', errorMessage(error))
    recordDiagnostic(config, 'factory_intelligence', error)
    return fallback
  }
}

export async function buildICP(
  project: Project,
  intelligence: CompanyIntelligence,
  valueChain: ValueChainMap,
  config: EngineConfig,
): Promise<IdealCustomerProfile> {
  const fallback = fallbackICP(project, intelligence, valueChain)

  try {
    const raw = await callOpenAIJson<Record<string, unknown>>(
      icpPrompt(project, intelligence, valueChain),
      config,
      {},
    )
    return normalizeICP(raw, fallback)
  } catch (error) {
    console.warn('ICP building fell back to deterministic tiers:', errorMessage(error))
    recordDiagnostic(config, 'buyer_profile', error)
    return fallback
  }
}

export async function mapValueChain(
  project: Project,
  intelligence: CompanyIntelligence,
  config: EngineConfig,
): Promise<ValueChainMap> {
  const fallback = fallbackValueChain(project, intelligence)

  try {
    const raw = await callOpenAIJson<Record<string, unknown>>(
      valueChainPrompt(project, intelligence),
      config,
      {},
    )
    return normalizeValueChain(raw, fallback)
  } catch (error) {
    console.warn('Value-chain mapping fell back to factory archetype:', errorMessage(error))
    recordDiagnostic(config, 'value_chain_mapping', error)
    return fallback
  }
}

export async function generateSearchPlan(
  project: Project,
  intelligence: CompanyIntelligence,
  valueChain: ValueChainMap,
  icp: IdealCustomerProfile | null,
  config: EngineConfig,
): Promise<SearchPlan> {
  let generated: Record<string, unknown> = {}

  try {
    const raw = await callOpenAIJson<Record<string, unknown>>(
      searchPlanPrompt(project, intelligence, valueChain, icp, SEARCH_CATEGORIES),
      config,
      {},
    )
    generated = asRecord(raw.groups)
  } catch (error) {
    console.warn('Search planning fell back to deterministic queries:', errorMessage(error))
    recordDiagnostic(config, 'search_planning', error)
  }

  return ensureCompleteSearchPlan(generated, project, intelligence, valueChain, icp)
}

export async function executeSearch(
  plan: SearchPlan,
  config: EngineConfig,
): Promise<RawSearchResult[]> {
  const entries = flattenSearchPlan(plan)
  const batches = await mapWithConcurrency(
    entries,
    config.tavily.concurrency,
    async (entry) => {
      try {
        return await tavilySearch(entry, config)
      } catch (error) {
        console.warn(`Search failed for "${entry.query}":`, errorMessage(error))
        recordDiagnostic(config, 'buyer_search', error)
        return []
      }
    },
  )

  return batches.flat()
}

export function normalizeResults(
  results: RawSearchResult[],
  partnerWebsite: string,
): NormalizedCompany[] {
  const partnerDomain = registrableDomain(safeHostname(partnerWebsite))
  const companies = new Map<string, NormalizedCompany>()

  for (const result of results) {
    const hostname = safeHostname(result.url)
    const domain = registrableDomain(hostname)
    if (!domain || domain === partnerDomain || shouldRejectResult(result, domain)) continue

    const evidence: CompanyEvidence = {
      title: cleanText(result.title, 220),
      url: result.url,
      snippet: cleanText(result.content, 700),
      ...(result.published_date ? { published_date: result.published_date } : {}),
    }
    const existing = companies.get(domain)

    if (!existing) {
      companies.set(domain, {
        company_name: companyNameFromResult(result.title, domain),
        domain,
        website: `https://${domain}`,
        matched_categories: [result.category],
        matched_queries: [result.query],
        evidence: [evidence],
      })
      continue
    }

    if (!existing.matched_categories.includes(result.category)) {
      existing.matched_categories.push(result.category)
    }
    if (!existing.matched_queries.includes(result.query) && existing.matched_queries.length < 8) {
      existing.matched_queries.push(result.query)
    }
    if (!existing.evidence.some((item) => item.url === evidence.url) && existing.evidence.length < 5) {
      existing.evidence.push(evidence)
    }
    existing.company_name = chooseBetterCompanyName(existing.company_name, result.title, domain)
  }

  return [...companies.values()]
    .filter((company) => company.evidence.some((item) => item.snippet.length >= 40))
    .sort(candidateSort)
}

export async function scoreCompanies(
  project: Project,
  intelligence: CompanyIntelligence,
  valueChain: ValueChainMap,
  icp: IdealCustomerProfile,
  companies: NormalizedCompany[],
  targetCount: number,
  config: EngineConfig,
): Promise<Opportunity[]> {
  // Keep one high-value judging wave inside the hosted Edge Function time budget.
  const candidates = companies.slice(0, 16)
  const batches = chunk(candidates, 8)
  const judgedBatches = await mapWithConcurrency(batches, 2, async (batch) => {
    try {
      const raw = await callOpenAIJson<{ judgements?: unknown }>(
        commercialJudgePrompt(project, intelligence, valueChain, icp, batch),
        config,
        {},
      )
      return normalizeJudgements(raw.judgements, batch, project, intelligence)
    } catch (error) {
      // Fewer verified opportunities are safer than keyword-scored filler.
      console.warn('Commercial Judge batch failed and was omitted:', errorMessage(error))
      recordDiagnostic(config, 'commercial_judgement', error)
      return []
    }
  })

  const bestByDomain = new Map<string, Opportunity>()
  for (const opportunity of judgedBatches.flat()) {
    const domain = registrableDomain(safeHostname(opportunity.website))
    const previous = bestByDomain.get(domain)
    if (!previous || opportunity.opportunity_score > previous.opportunity_score) {
      bestByDomain.set(domain, opportunity)
    }
  }

  return [...bestByDomain.values()]
    .sort((left, right) => right.opportunity_score - left.opportunity_score)
    .slice(0, targetCount)
}

export function flattenSearchPlan(plan: SearchPlan): SearchPlanEntry[] {
  return SEARCH_CATEGORIES.flatMap((category) =>
    plan[category].map((query) => ({ category, query }))
  )
}

function fallbackCompanyIntelligence(project: Project): CompanyIntelligence {
  const productSummary = project.factoryInput.product_summary || project.offer
  const archetype = inferFactoryArchetype(project)
  const inferredBuyerSegments = project.targetCustomer
    ? [project.targetCustomer]
    : ['Companies that purchase, integrate, use, private-label, import, or resell the factory offer']
  const suppliedSignals = [
    project.website ? 'Factory website supplied' : '',
    productSummary ? 'Product summary supplied' : '',
    project.factoryInput.commercial_terms ? 'Commercial terms supplied' : '',
    project.factoryInput.certifications.length ? 'Certification claims supplied' : '',
  ].filter(Boolean)

  return {
    company_role: 'Factory role not verified from available evidence',
    factory_archetype: archetype,
    business_model: productSummary
      ? `Manufactures or supplies ${productSummary}`
      : 'Manufacturing and export model not established from available evidence',
    products: productSummary ? [productSummary] : ['Factory offer not yet established'],
    product_applications: ['Application not yet established'],
    manufacturing_capabilities: project.factoryInput.cooperation_mode,
    target_market: inferredBuyerSegments,
    customer_segments: inferredBuyerSegments,
    pricing_position: 'Not established from available evidence',
    commercial_terms: {
      moq: project.minimumDealRequirements || 'Not established',
      pricing: 'Not established',
      lead_time: 'Not established',
      incoterms: [],
    },
    certifications: project.factoryInput.certifications,
    distribution_channels: ['Direct export sales', 'Qualified downstream buyers and channels'],
    geographic_focus: project.targetGeography.length
      ? project.targetGeography
      : ['Geography not specified'],
    ideal_downstream_buyers: inferredBuyerSegments,
    excluded_company_types: [
      'Companies selling inputs or services upstream to this factory',
      'Peer factories and direct competitors that do not buy the offer',
      'Blogs, news sites, directories, and marketplaces',
      ...project.exclusions,
    ].filter(uniqueString),
    export_readiness: {
      score: Math.min(70, 20 + suppliedSignals.length * 12),
      signals: suppliedSignals,
      gaps: [
        !project.factoryInput.commercial_terms ? 'Commercial terms need verification' : '',
        !project.factoryInput.certifications.length ? 'Certifications need verification' : '',
        'Production capacity and lead time need verification',
      ].filter(Boolean),
    },
    evidence_gaps: [
      'Factory identity and production role need first-party verification',
      'MOQ, pricing, capacity, lead time, certifications, and Incoterms need confirmation',
    ],
  }
}

function normalizeCompanyIntelligence(
  raw: Record<string, unknown>,
  fallback: CompanyIntelligence,
): CompanyIntelligence {
  const commercialTerms = asRecord(raw.commercial_terms)
  const exportReadiness = asRecord(raw.export_readiness)
  return {
    company_role: asString(raw.company_role) || fallback.company_role,
    factory_archetype: enumValue(
      raw.factory_archetype,
      FACTORY_ARCHETYPES,
      fallback.factory_archetype,
    ),
    business_model: asString(raw.business_model) || fallback.business_model,
    products: nonEmptyArray(raw.products, fallback.products),
    product_applications: nonEmptyArray(
      raw.product_applications,
      fallback.product_applications,
    ),
    manufacturing_capabilities: nonEmptyArray(
      raw.manufacturing_capabilities,
      fallback.manufacturing_capabilities,
    ),
    target_market: nonEmptyArray(raw.target_market, fallback.target_market),
    customer_segments: nonEmptyArray(raw.customer_segments, fallback.customer_segments),
    pricing_position: asString(raw.pricing_position) || fallback.pricing_position,
    commercial_terms: {
      moq: asString(commercialTerms.moq) || fallback.commercial_terms.moq,
      pricing: asString(commercialTerms.pricing) || fallback.commercial_terms.pricing,
      lead_time: asString(commercialTerms.lead_time) || fallback.commercial_terms.lead_time,
      incoterms: nonEmptyArray(
        commercialTerms.incoterms,
        fallback.commercial_terms.incoterms,
      ),
    },
    certifications: nonEmptyArray(raw.certifications, fallback.certifications),
    distribution_channels: nonEmptyArray(
      raw.distribution_channels,
      fallback.distribution_channels,
    ),
    geographic_focus: nonEmptyArray(raw.geographic_focus, fallback.geographic_focus),
    ideal_downstream_buyers: nonEmptyArray(
      raw.ideal_downstream_buyers,
      fallback.ideal_downstream_buyers,
    ),
    excluded_company_types: [
      ...nonEmptyArray(raw.excluded_company_types, fallback.excluded_company_types),
      'Companies selling inputs or services upstream to this factory',
      'Peer factories and direct competitors that do not buy the offer',
      'Blogs, news sites, directories, and marketplaces',
    ].filter(uniqueString),
    export_readiness: {
      score: clampScore(exportReadiness.score || fallback.export_readiness.score),
      signals: nonEmptyArray(exportReadiness.signals, fallback.export_readiness.signals),
      gaps: nonEmptyArray(exportReadiness.gaps, fallback.export_readiness.gaps),
    },
    evidence_gaps: nonEmptyArray(raw.evidence_gaps, fallback.evidence_gaps),
  }
}

function fallbackValueChain(
  project: Project,
  intelligence: CompanyIntelligence,
): ValueChainMap {
  const productRole = productRoleForArchetype(intelligence.factory_archetype)
  const relationships = defaultRelationships(intelligence.factory_archetype)
  const buyerSegments = intelligence.ideal_downstream_buyers.length
    ? intelligence.ideal_downstream_buyers
    : intelligence.customer_segments
  const downstreamPaths = relationships.map((relationship, index): ValueChainPath => ({
    buyer_segment: buyerSegments[index] || fallbackBuyerSegment(relationship),
    relationship,
    buyer_uses_product_as: fallbackUseCase(relationship, productRole),
    purchase_motion: `The buyer pays the factory for ${intelligence.products[0] || project.offer || 'the offer'}`,
    priority: index < 3 ? 1 : index < 6 ? 2 : 3,
    required_evidence: fallbackRequiredEvidence(relationship),
  }))
  const categoryDefaults = defaultSearchCategories(intelligence.factory_archetype)

  return {
    seller_position: `${intelligence.factory_archetype} supplying overseas B2B customers`,
    product_role: productRole,
    downstream_paths: downstreamPaths,
    valid_buyer_relationships: relationships,
    conditional_buyer_types: [
      'Manufacturers qualify only when they consume, integrate, use, or private-label this offer',
      'Trading companies qualify only when they import or resell this offer',
    ],
    excluded_relationships: [
      'Upstream input or service vendors',
      'Peer factories and competitors without a purchase motion',
      'Publishers, directories, marketplaces, and lead databases',
      ...project.exclusions,
    ].filter(uniqueString),
    search_categories: categoryDefaults,
    decision_rule:
      'Accept only when evidence supports payment flowing from the candidate to this factory.',
  }
}

function normalizeValueChain(
  raw: Record<string, unknown>,
  fallback: ValueChainMap,
): ValueChainMap {
  const rawPaths = Array.isArray(raw.downstream_paths) ? raw.downstream_paths : []
  const paths = rawPaths.flatMap((item): ValueChainPath[] => {
    const record = asRecord(item)
    const buyerSegment = asString(record.buyer_segment)
    const relationship = enumValue(
      record.relationship,
      BUYER_RELATIONSHIPS,
      null,
    )
    if (!buyerSegment || !relationship) return []
    return [{
      buyer_segment: buyerSegment,
      relationship,
      buyer_uses_product_as: asString(record.buyer_uses_product_as),
      purchase_motion: asString(record.purchase_motion),
      priority: boundedPriority(record.priority),
      required_evidence: asString(record.required_evidence) ||
        fallbackRequiredEvidence(relationship),
    }]
  })
  const validRelationships = enumArray(raw.valid_buyer_relationships, BUYER_RELATIONSHIPS)
  const searchCategories = ensureMinimumSearchCategories(
    enumArray(raw.search_categories, SEARCH_CATEGORIES),
    fallback.search_categories,
  )

  return {
    seller_position: asString(raw.seller_position) || fallback.seller_position,
    product_role: enumValue(raw.product_role, PRODUCT_ROLES, fallback.product_role),
    downstream_paths: paths.length ? paths.slice(0, 18) : fallback.downstream_paths,
    valid_buyer_relationships: validRelationships.length
      ? validRelationships
      : fallback.valid_buyer_relationships,
    conditional_buyer_types: nonEmptyArray(
      raw.conditional_buyer_types,
      fallback.conditional_buyer_types,
    ),
    excluded_relationships: [
      ...nonEmptyArray(raw.excluded_relationships, fallback.excluded_relationships),
      ...fallback.excluded_relationships,
    ].filter(uniqueString),
    search_categories: searchCategories,
    decision_rule: asString(raw.decision_rule) || fallback.decision_rule,
  }
}

function fallbackICP(
  project: Project,
  intelligence: CompanyIntelligence,
  valueChain: ValueChainMap,
): IdealCustomerProfile {
  const tiers = valueChain.downstream_paths.map((path, index): BuyerTier => ({
    segment: path.buyer_segment,
    relationship: path.relationship,
    rationale: index === 0
      ? 'Highest-priority downstream path based on the factory and product role'
      : 'Plausible downstream path requiring company-level evidence',
    purchase_use_case: path.buyer_uses_product_as ||
      `Purchase or use ${intelligence.products[0] || project.offer}`,
    required_evidence: path.required_evidence,
  }))

  return {
    tier_1_buyers: tiers.filter((_, index) => valueChain.downstream_paths[index]?.priority === 1).slice(0, 6),
    tier_2_buyers: tiers.filter((_, index) => valueChain.downstream_paths[index]?.priority === 2).slice(0, 6),
    tier_3_buyers: tiers.filter((_, index) => valueChain.downstream_paths[index]?.priority === 3).slice(0, 6),
    buyer_personas: ['Procurement leader', 'Category buyer', 'Sourcing manager', 'Business owner'],
    purchasing_departments: ['Procurement', 'Sourcing', 'Merchandising', 'Operations'],
    typical_purchase_cycle: 'Not established; validate during outreach',
    estimated_deal_size: {
      currency: 'USD',
      minimum: null,
      maximum: null,
      basis: 'Insufficient verified pricing and volume evidence',
    },
    qualification_questions: [
      'Does the candidate currently buy, import, integrate, use, or resell this product?',
      'Who owns supplier selection and commercial terms?',
      'What specifications, certifications, MOQ, and delivery terms are required?',
    ],
    disqualifiers: [
      ...valueChain.excluded_relationships,
      ...project.exclusions,
    ].filter(uniqueString),
  }
}

function normalizeICP(
  raw: Record<string, unknown>,
  fallback: IdealCustomerProfile,
): IdealCustomerProfile {
  const dealSize = asRecord(raw.estimated_deal_size)
  return {
    tier_1_buyers: normalizeBuyerTiers(raw.tier_1_buyers, fallback.tier_1_buyers),
    tier_2_buyers: normalizeBuyerTiers(raw.tier_2_buyers, fallback.tier_2_buyers),
    tier_3_buyers: normalizeBuyerTiers(raw.tier_3_buyers, fallback.tier_3_buyers),
    buyer_personas: nonEmptyArray(raw.buyer_personas, fallback.buyer_personas),
    purchasing_departments: nonEmptyArray(
      raw.purchasing_departments,
      fallback.purchasing_departments,
    ),
    typical_purchase_cycle:
      asString(raw.typical_purchase_cycle) || fallback.typical_purchase_cycle,
    estimated_deal_size: {
      currency: asString(dealSize.currency) || fallback.estimated_deal_size.currency,
      minimum: nullableNumber(dealSize.minimum),
      maximum: nullableNumber(dealSize.maximum),
      basis: asString(dealSize.basis) || fallback.estimated_deal_size.basis,
    },
    qualification_questions: nonEmptyArray(
      raw.qualification_questions,
      fallback.qualification_questions,
    ),
    disqualifiers: [
      ...nonEmptyArray(raw.disqualifiers, fallback.disqualifiers),
      ...fallback.disqualifiers,
    ].filter(uniqueString),
  }
}

function normalizeBuyerTiers(value: unknown, fallback: BuyerTier[]): BuyerTier[] {
  if (!Array.isArray(value)) return fallback
  const tiers = value.map((item): BuyerTier | null => {
    const record = asRecord(item)
    const segment = asString(record.segment)
    if (!segment) return null
    const relationship = enumValue(
      record.relationship,
      BUYER_RELATIONSHIPS,
      fallback[0]?.relationship || 'procurement_partner',
    )
    return {
      segment,
      relationship,
      rationale: asString(record.rationale),
      purchase_use_case: asString(record.purchase_use_case),
      required_evidence: asString(record.required_evidence) ||
        fallbackRequiredEvidence(relationship),
    }
  }).filter((item): item is BuyerTier => Boolean(item))
  return tiers.length ? tiers.slice(0, 8) : fallback
}

function ensureCompleteSearchPlan(
  generated: Record<string, unknown>,
  project: Project,
  intelligence: CompanyIntelligence,
  valueChain: ValueChainMap,
  icp: IdealCustomerProfile | null,
): SearchPlan {
  const fallback = buildFallbackQueries(project, intelligence, valueChain, icp)
  const plan = {} as SearchPlan
  const allowedCategories = defaultSearchCategories(intelligence.factory_archetype)
  const activeCategories = new Set(
    ensureMinimumSearchCategories(
      valueChain.search_categories.filter((category) => allowedCategories.includes(category)),
      allowedCategories,
    ),
  )

  for (const category of SEARCH_CATEGORIES) {
    if (!activeCategories.has(category)) {
      plan[category] = []
      continue
    }
    const aliases = [
      category,
      category.replaceAll('_', ' '),
      category.replaceAll('_', '-'),
    ]
    const generatedQueries = aliases.flatMap((key) => asStringArray(generated[key]))
    const validGenerated = generatedQueries
      .map(cleanQuery)
      .filter((query) => query.length >= 8 && !QUERY_REJECTION_PATTERN.test(query))

    plan[category] = [...validGenerated, ...fallback[category]]
      .filter(uniqueStringInsensitive)
      .slice(0, 6)
  }

  return plan
}

function buildFallbackQueries(
  project: Project,
  intelligence: CompanyIntelligence,
  valueChain: ValueChainMap,
  icp: IdealCustomerProfile | null,
): SearchPlan {
  const product = compactSearchTerm(
    intelligence.products.find((item) => item.length <= 80) ||
      project.factoryInput.product_summary ||
      project.offer ||
      'factory product',
  )
  const application = compactSearchTerm(
    intelligence.product_applications.find((item) => item.length <= 80) ||
      intelligence.target_market[0] ||
      product,
  )
  const geography = compactSearchTerm(
    intelligence.geographic_focus[0] || project.targetGeography[0] || 'United States',
  )
  const tierOne = compactSearchTerm(
    icp?.tier_1_buyers[0]?.segment || intelligence.ideal_downstream_buyers[0] ||
      'business buyers',
  )
  const selected = new Set(defaultSearchCategories(intelligence.factory_archetype))

  return {
    importers: selected.has('importers') ? [
      `"${product}" importer "${geography}"`,
      `"${product}" import distribution company`,
      `"${application}" importer product catalog`,
      `"${product}" importing company wholesale`,
      `"${product}" importer brands "${geography}"`,
      `"${product}" customs import company distributor`,
    ] : [],
    distributors: selected.has('distributors') ? [
      `"${product}" distributor "${geography}"`,
      `"${product}" distribution company catalog`,
      `"${application}" regional distributor`,
      `"${product}" distributor dealer network`,
      `"${product}" wholesale distributor to businesses`,
      `"${product}" distribution product line`,
    ] : [],
    dealers_resellers: selected.has('dealers_resellers') ? [
      `"${product}" dealer "${geography}"`,
      `authorized "${product}" dealer`,
      `"${product}" reseller business`,
      `"${application}" equipment dealer`,
      `"${product}" showroom dealer`,
      `"${product}" dealer installation service`,
    ] : [],
    retailers: selected.has('retailers') ? [
      `"${product}" specialty retailer "${geography}"`,
      `"${product}" retailer store locations`,
      `"${application}" retail showroom`,
      `"${product}" retail chain`,
      `"${product}" online retailer official website`,
      `"${product}" buyer merchandising company`,
    ] : [],
    brand_owners_private_label: selected.has('brand_owners_private_label') ? [
      `"${product}" brand company "${geography}"`,
      `"${product}" private label brand`,
      `"${application}" brand product collection`,
      `"${product}" own brand retailer`,
      `"${product}" OEM private label buyer`,
      `"${product}" brand sourcing manager`,
    ] : [],
    oem_component_buyers: selected.has('oem_component_buyers') ? [
      `"${product}" OEM buyer "${geography}"`,
      `"${application}" manufacturer uses "${product}"`,
      `"${product}" component sourcing manager`,
      `"${product}" approved supplier requirements manufacturer`,
      `"${application}" assembly company "${product}"`,
      `"${product}" engineering procurement company`,
    ] : [],
    industrial_end_users: selected.has('industrial_end_users') ? [
      `"${product}" plant equipment procurement`,
      `"${application}" manufacturing facility "${geography}"`,
      `"${product}" industrial end user`,
      `"${product}" operations procurement manager`,
      `"${application}" production company equipment`,
      `"${product}" factory modernization project`,
    ] : [],
    commercial_institutional_buyers: selected.has('commercial_institutional_buyers') ? [
      `"${product}" "${tierOne}"`,
      `"${product}" commercial procurement "${geography}"`,
      `"${application}" multi-location operator`,
      `"${product}" bulk purchase business`,
      `"${product}" institutional buyer`,
      `"${product}" procurement manager`,
    ] : [],
    integrators_contractors: selected.has('integrators_contractors') ? [
      `"${product}" system integrator "${geography}"`,
      `"${product}" project contractor supplier selection`,
      `"${application}" installation company equipment`,
      `"${product}" engineering integrator`,
      `"${product}" project specification contractor`,
      `"${application}" turnkey project company`,
    ] : [],
    procurement_channel_partners: selected.has('procurement_channel_partners') ? [
      `"${product}" procurement company "${geography}"`,
      `"${application}" sourcing company buyer`,
      `"${product}" procurement partner projects`,
      `"${product}" purchasing group`,
      `"${application}" category procurement company`,
      `"${product}" contract purchasing organization`,
    ] : [],
  }
}

async function collectWebsiteEvidence(
  project: Project,
  config: EngineConfig,
): Promise<Array<{ title: string; url: string; content: string }>> {
  const domain = safeHostname(project.website)
  if (!domain) return []

  const queries: SearchPlanEntry[] = [
    {
      category: 'procurement_channel_partners',
      query: `site:${domain} products applications industries customers`,
    },
    {
      category: 'procurement_channel_partners',
      query: `site:${domain} factory manufacturing OEM ODM capacity`,
    },
    {
      category: 'procurement_channel_partners',
      query: `site:${domain} certifications MOQ lead time export`,
    },
  ]
  const results = await Promise.all(
    queries.map((entry) =>
      tavilySearch(entry, config, {
        includeDomains: [domain],
        maxResults: 3,
        searchDepth: 'basic',
      }).catch(() => [])
    ),
  )
  const unique = new Map<string, { title: string; url: string; content: string }>()

  for (const item of results.flat()) {
    if (!unique.has(item.url)) {
      unique.set(item.url, {
        title: item.title,
        url: item.url,
        content: cleanText(item.content, 1_200),
      })
    }
  }

  return [...unique.values()].slice(0, 8)
}

async function tavilySearch(
  entry: SearchPlanEntry,
  config: EngineConfig,
  options: {
    includeDomains?: string[]
    maxResults?: number
    searchDepth?: 'basic' | 'advanced'
  } = {},
): Promise<RawSearchResult[]> {
  const payload = await fetchJsonWithRetry<TavilyResponse>(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: config.tavily.apiKey,
        query: entry.query,
        search_depth: options.searchDepth || 'advanced',
        max_results: options.maxResults || 3,
        include_answer: false,
        include_raw_content: false,
        exclude_domains: SEARCH_EXCLUDED_DOMAINS,
        ...(options.includeDomains ? { include_domains: options.includeDomains } : {}),
      }),
    },
    20_000,
  )

  return (payload.results || []).flatMap((item): RawSearchResult[] => {
    const title = asString(item.title)
    const url = asString(item.url)
    const content = asString(item.content)
    if (!title || !url || !content) return []
    return [{
      query: entry.query,
      category: entry.category,
      title,
      url,
      content,
      ...(asString(item.published_date)
        ? { published_date: asString(item.published_date) }
        : {}),
    }]
  })
}

async function callOpenAIJson<T>(
  prompt: string,
  config: EngineConfig,
  fallback: T,
): Promise<T> {
  const requestBody: Record<string, unknown> = {
    model: config.openAI.model,
    input: prompt,
    text: { format: { type: 'json_object' } },
  }
  if (supportsReasoningEffort(config.openAI.model)) {
    requestBody.reasoning = { effort: config.openAI.reasoningEffort }
  }
  const payload = await fetchJsonWithRetry<OpenAIResponse>(
    'https://api.openai.com/v1/responses',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openAI.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    },
    45_000,
  )

  const output = payload.output_text ||
    payload.output
      ?.flatMap((item) => item.content || [])
      .map((item) => item.text || '')
      .join('') ||
    ''

  if (!output) throw new Error(payload.error?.message || 'OpenAI returned no JSON output')
  return parseJsonObject(output, fallback)
}

function supportsReasoningEffort(model: string): boolean {
  return /^(gpt-5|o1|o3|o4)(?:[-.]|$)/i.test(model.trim())
}

async function fetchJsonWithRetry<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      const payload = await response.json() as T & {
        error?: { message?: string }
        detail?: unknown
      }
      if (!response.ok) {
        const message = payload.error?.message ||
          asString(payload.detail) ||
          `${response.status} ${response.statusText}`
        if (response.status < 500 && response.status !== 429) throw new Error(message)
        lastError = new Error(message)
      } else {
        return payload
      }
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timeout)
    }

    if (attempt === 0) await delay(300)
  }

  throw lastError instanceof Error ? lastError : new Error('External request failed')
}

function normalizeJudgements(
  value: unknown,
  candidates: NormalizedCompany[],
  project: Project,
  intelligence: CompanyIntelligence,
): Opportunity[] {
  if (!Array.isArray(value)) return []
  const candidateMap = new Map(candidates.map((candidate) => [candidate.domain, candidate]))

  return value.flatMap((item): Opportunity[] => {
    const judgement = asRecord(item) as JudgeRecord
    const domain = registrableDomain(safeHostname(asString(judgement.domain)))
    const candidate = candidateMap.get(domain)
    if (!candidate || asString(judgement.decision).toLowerCase() !== 'accept') return []

    const relationship = enumValue(
      judgement.relationship,
      BUYER_RELATIONSHIPS,
      null,
    )
    if (!relationship) return []
    const proposedCompanyName = judgedCompanyNameFrom(judgement, candidate)
    if (candidateLooksFactoryOwned(candidate, project, proposedCompanyName)) return []
    if (
      intelligence.factory_archetype === 'finished_goods_brand' &&
      !hasVerifiedThirdPartyPurchaseMotion(candidate, relationship)
    ) return []

    const scoreBreakdown: ScoreDimensions = {
      buying_probability: clampScore(judgement.buying_probability),
      downstream_fit: clampScore(judgement.downstream_fit),
      commercial_value: clampScore(judgement.commercial_value),
      estimated_purchasing_power: clampScore(judgement.estimated_purchasing_power),
      timing: clampScore(judgement.timing),
      evidence_quality: clampScore(judgement.evidence_quality),
    }
    const opportunityScore = calculateCommercialScore(scoreBreakdown)
    if (
      scoreBreakdown.downstream_fit < 60 ||
      scoreBreakdown.buying_probability < 45 ||
      scoreBreakdown.evidence_quality < 35 ||
      opportunityScore < 58
    ) return []

    const requestedEvidenceUrl = asString(judgement.evidence_url)
    const evidence = candidate.evidence.find((item) => item.url === requestedEvidenceUrl) ||
      candidate.evidence[0]
    if (!evidence) return []
    const judgedCompanyName = proposedCompanyName
    if (!companyIdentityMatches(judgedCompanyName, candidate)) return []

    const whyRecommended = asString(judgement.why_recommended) ||
      `The supplied evidence supports ${relationshipLabel(relationship)} status and a downstream purchase motion.`
    const whyNow = asString(judgement.why_now) ||
      'No time-specific trigger was found; the evidence supports recurring structural demand.'
    const likelyBuyerRole = asString(judgement.likely_buyer_role) ||
      'Procurement or category owner; exact title not established'
    const likelyNeed = asString(judgement.likely_need) ||
      `Potential need for ${intelligence.products[0] || 'the finished offer'}`
    const outreachAngle = asString(judgement.outreach_angle) ||
      'Validate current product mix, buying cadence, and decision ownership.'
    const productMatch = asString(judgement.product_match) ||
      `Potential fit for ${intelligence.products[0] || 'the factory offer'}`
    const purchaseUseCase = asString(judgement.purchase_use_case) || likelyNeed
    const outreachSubject = asString(judgement.outreach_subject) ||
      `Supply partnership for ${intelligence.products[0] || 'your product category'}`
    const outreachMessage = asString(judgement.outreach_message) ||
      `I noticed your company operates in this product category. We represent a factory supplying ${intelligence.products[0] || 'the relevant products'}. Would it be useful to compare specifications, commercial terms, and current sourcing needs?`

    return [{
      company_name: judgedCompanyName,
      website: candidate.website,
      location: asString(judgement.location) || 'Not established from supplied evidence',
      company_type: asString(judgement.company_type) || relationshipLabel(relationship),
      opportunity_type: relationshipLabel(relationship),
      relationship_to_factory: relationship,
      product_match: productMatch,
      purchase_use_case: purchaseUseCase,
      likely_order_type: asString(judgement.likely_order_type) ||
        'Order type needs qualification',
      why_recommended: whyRecommended,
      why_now: whyNow,
      likely_buyer_role: likelyBuyerRole,
      outreach_angle: outreachAngle,
      outreach_subject: outreachSubject,
      outreach_message: outreachMessage,
      next_action: asString(judgement.next_action) ||
        'Verify the buyer role and send the approved first-touch message.',
      risk_flags: asStringArray(judgement.risk_flags),
      // Legacy aliases preserve the current frontend contract.
      fit_reason: whyRecommended,
      current_trigger: whyNow,
      likely_need: likelyNeed,
      evidence_title: evidence.title,
      evidence_url: evidence.url,
      evidence_snippet: evidence.snippet,
      buyer_role: likelyBuyerRole,
      opportunity_score: opportunityScore,
      confidence: Math.round(
        scoreBreakdown.evidence_quality * 0.6 + scoreBreakdown.downstream_fit * 0.4,
      ),
      score_breakdown: scoreBreakdown,
    }]
  })
}

function calculateCommercialScore(scores: ScoreDimensions): number {
  return Math.round(
    scores.buying_probability * 0.20 +
      scores.downstream_fit * 0.25 +
      scores.commercial_value * 0.15 +
      scores.estimated_purchasing_power * 0.15 +
      scores.timing * 0.10 +
      scores.evidence_quality * 0.15,
  )
}

function shouldRejectResult(result: RawSearchResult, domain: string): boolean {
  if (BLOCKED_DOMAIN_SUFFIXES.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`))) {
    return true
  }
  if (RESULT_REJECTION_PATTERN.test(result.title)) return true
  try {
    const url = new URL(result.url)
    return /\.(pdf|docx?|xlsx?|pptx?)$/i.test(url.pathname)
  } catch {
    return true
  }
}

function candidateSort(left: NormalizedCompany, right: NormalizedCompany): number {
  const leftSignal = candidateCommercialSignal(left)
  const rightSignal = candidateCommercialSignal(right)
  return rightSignal - leftSignal || left.domain.localeCompare(right.domain)
}

function candidateCommercialSignal(candidate: NormalizedCompany): number {
  const evidence = candidate.evidence
    .map((item) => `${item.title} ${item.snippet}`)
    .join(' ')
    .toLowerCase()
  let score = candidate.matched_categories.length * 5 + candidate.evidence.length
  if (/\bauthorized dealer\b|\bbrands we carry\b|\bshop by brand\b|\bmulti-brand\b/.test(evidence)) {
    score += 18
  }
  if (/\bimporter\b|\bdistributor\b|\bdistribution network\b|\bdealer network\b/.test(evidence)) {
    score += 10
  }
  if (/\bshowroom\b|\bstore locations?\b|\bcommercial projects?\b|\bprocurement\b/.test(evidence)) {
    score += 6
  }
  return score
}

function companyNameFromResult(title: string, domain: string): string {
  const genericTitle =
    /\b(become (?:a|an)|partner with|partnership program|business opportunity|dealer inquiry|retail partner|researching|blog|news|contact us|about us|shop now|learn more)\b/i
  const segments = cleanText(title, 180)
    .split(/\s(?:\||--?)\s/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 2 && segment.length <= 80)
  const candidate = [...segments]
    .reverse()
    .find((segment) => !genericTitle.test(segment))
    ?.replace(/\b(home|homepage|official site|welcome to)\b/gi, '')
    .trim() || ''
  return candidate.length >= 2 && candidate.length <= 80 ? candidate : domainLabel(domain)
}

function chooseBetterCompanyName(current: string, title: string, domain: string): string {
  const next = companyNameFromResult(title, domain)
  const domainName = domainLabel(domain).toLowerCase()
  if (current.toLowerCase() === domainName && next.toLowerCase() !== domainName) return next
  return current
}

function companyIdentityMatches(
  judgedName: string,
  candidate: NormalizedCompany,
): boolean {
  const judgedTokens = companyIdentityTokens(judgedName)
  const evidenceTokens = new Set([
    ...companyIdentityTokens(candidate.company_name),
    ...companyIdentityTokens(domainLabel(candidate.domain)),
  ])
  if (!judgedTokens.length || !evidenceTokens.size) return false
  if (judgedTokens.some((token) => evidenceTokens.has(token))) return true
  const judgedCompact = judgedTokens.join('')
  const evidenceCompact = [...evidenceTokens].join('')
  return judgedCompact.length >= 4 &&
    evidenceCompact.length >= 4 &&
    (judgedCompact.includes(evidenceCompact) || evidenceCompact.includes(judgedCompact))
}

function judgedCompanyNameFrom(
  judgement: JudgeRecord,
  candidate: NormalizedCompany,
): string {
  return asString(judgement.company_name) || candidate.company_name
}

/**
 * Search engines often surface a factory's regional shop, wholesale portal, or
 * dropshipping site on another domain. Those are channels owned by the seller,
 * not new customers, so exclude clear brand/domain aliases deterministically.
 */
function candidateLooksFactoryOwned(
  candidate: NormalizedCompany,
  project: Project,
  judgedName: string,
): boolean {
  const factoryDomain = registrableDomain(safeHostname(project.website))
  if (factoryDomain && candidate.domain === factoryDomain) return true

  const factoryBrands = [
    project.partnerName,
    domainLabel(factoryDomain),
  ]
    .map(compactIdentity)
    .filter((value) => value.length >= 4)
  if (!factoryBrands.length) return false

  const candidateIdentities = [
    compactIdentity(judgedName),
    compactIdentity(candidate.company_name),
    compactIdentity(domainLabel(candidate.domain)),
  ]
  return factoryBrands.some((brand) =>
    candidateIdentities.some((identity) =>
      identity === brand ||
      (brand.length >= 6 && identity.includes(brand))
    )
  )
}

/**
 * For an own-brand finished-goods factory, a dealer/retailer must prove that it
 * carries third-party brands, and a distributor/importer must prove that it
 * imports or represents products made by others. This guards against the common
 * false positive where a competing brand is merely recruiting its own dealers.
 */
function hasVerifiedThirdPartyPurchaseMotion(
  candidate: NormalizedCompany,
  relationship: BuyerRelationship,
): boolean {
  const evidence = candidate.evidence
    .map((item) => `${item.title} ${item.snippet}`)
    .join(' ')
    .toLowerCase()

  if (relationship === 'dealer_reseller' || relationship === 'retailer') {
    return /\b(shop by brand|brands we carry|our brands|featured brands|multi-brand|authorized (?:dealer|retailer) (?:for|of)|we (?:carry|stock|sell) brands?)\b/i
      .test(evidence)
  }
  if (relationship === 'importer' || relationship === 'distributor') {
    return /\b(import(?:er|ing|s|ed)?|represent(?:s|ing|ed)? brands?|distribut(?:e|es|ing) (?:products|brands)|works? directly with (?:the world's |global |leading |top )?manufacturers|manufacturer relationships?)\b/i
      .test(evidence)
  }
  if (
    relationship === 'brand_owner' ||
    relationship === 'private_label_buyer' ||
    relationship === 'oem_buyer'
  ) {
    return /\b(private label|white label|oem|odm|contract manufactur(?:er|ing)|third-party sourcing|sourcing partner)\b/i
      .test(evidence)
  }
  return true
}

function companyIdentityTokens(value: string): string[] {
  const ignored = new Set([
    'company',
    'group',
    'global',
    'international',
    'official',
    'website',
    'home',
    'usa',
    'inc',
    'llc',
    'ltd',
    'limited',
    'corp',
    'corporation',
  ])
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !ignored.has(token))
}

function compactIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function normalizeWebsite(value: string): string {
  if (!value) return ''
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).toString()
  } catch {
    return value
  }
}

function safeHostname(value: string): string {
  if (!value) return ''
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
    return url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  } catch {
    return ''
  }
}

function registrableDomain(hostname: string): string {
  if (!hostname) return ''
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname === 'localhost') return hostname
  const parts = hostname.split('.').filter(Boolean)
  if (parts.length <= 2) return hostname
  const lastTwo = parts.slice(-2).join('.')
  return TWO_LEVEL_PUBLIC_SUFFIXES.has(lastTwo)
    ? parts.slice(-3).join('.')
    : lastTwo
}

function domainLabel(value: string): string {
  const hostname = safeHostname(value) || value.toLowerCase().replace(/^www\./, '')
  const label = hostname.split('.')[0] || ''
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function inferFactoryArchetype(project: Project): FactoryArchetype {
  const context = [
    project.offer,
    project.factoryInput.product_summary,
    project.factoryInput.cooperation_mode.join(' '),
    project.factoryInput.notes,
  ].join(' ').toLowerCase()

  if (/\b(packaging|package|carton|bottle|label|pouch)\b/.test(context)) return 'packaging'
  if (/\b(raw material|resin|polymer|alloy|chemical|fabric|textile material)\b/.test(context)) {
    return 'materials'
  }
  if (/\b(component|parts?|module|assembly|bearing|fastener|connector|pcb)\b/.test(context)) {
    return 'components'
  }
  if (/\b(industry|industrial|cnc|machine|machinery|production line|automation)\b/.test(context)) {
    return 'industrial_equipment'
  }
  if (/\b(commercial equipment|medical equipment|fitness equipment|restaurant equipment)\b/.test(context)) {
    return 'commercial_equipment'
  }
  if (/\b(custom fabrication|contract manufacturing|made to drawing|build to print)\b/.test(context)) {
    return 'custom_manufacturing'
  }
  if (/\b(oem|odm|private label)\b/.test(context)) return 'oem_odm_finished_goods'
  return context.trim() ? 'finished_goods_brand' : 'unknown'
}

function productRoleForArchetype(archetype: FactoryArchetype): ProductRole {
  const roles: Record<FactoryArchetype, ProductRole> = {
    finished_goods_brand: 'finished_good',
    oem_odm_finished_goods: 'finished_good',
    commercial_equipment: 'commercial_equipment',
    industrial_equipment: 'industrial_equipment',
    components: 'component',
    materials: 'material',
    packaging: 'packaging',
    custom_manufacturing: 'manufacturing_service',
    mixed: 'mixed',
    unknown: 'unknown',
  }
  return roles[archetype]
}

function defaultRelationships(archetype: FactoryArchetype): BuyerRelationship[] {
  const commonChannel: BuyerRelationship[] = [
    'importer',
    'distributor',
    'procurement_partner',
  ]
  const groups: Record<FactoryArchetype, BuyerRelationship[]> = {
    finished_goods_brand: [
      ...commonChannel,
      'dealer_reseller',
      'retailer',
      'commercial_end_user',
      'system_integrator',
    ],
    oem_odm_finished_goods: [
      ...commonChannel,
      'brand_owner',
      'private_label_buyer',
      'retailer',
      'commercial_end_user',
    ],
    commercial_equipment: [
      ...commonChannel,
      'dealer_reseller',
      'commercial_end_user',
      'system_integrator',
      'contractor_specifier',
    ],
    industrial_equipment: [
      ...commonChannel,
      'dealer_reseller',
      'industrial_end_user',
      'system_integrator',
      'contractor_specifier',
    ],
    components: [
      ...commonChannel,
      'oem_buyer',
      'industrial_end_user',
      'brand_owner',
      'system_integrator',
    ],
    materials: [
      ...commonChannel,
      'oem_buyer',
      'industrial_end_user',
      'brand_owner',
      'commercial_end_user',
    ],
    packaging: [
      ...commonChannel,
      'brand_owner',
      'private_label_buyer',
      'oem_buyer',
      'industrial_end_user',
    ],
    custom_manufacturing: [
      ...commonChannel,
      'brand_owner',
      'private_label_buyer',
      'oem_buyer',
      'industrial_end_user',
    ],
    mixed: [...BUYER_RELATIONSHIPS],
    unknown: [
      ...commonChannel,
      'dealer_reseller',
      'brand_owner',
      'oem_buyer',
      'commercial_end_user',
    ],
  }
  return groups[archetype].filter(uniqueString) as BuyerRelationship[]
}

function defaultSearchCategories(archetype: FactoryArchetype): SearchCategory[] {
  const relationshipCategories: Partial<Record<BuyerRelationship, SearchCategory>> = {
    importer: 'importers',
    distributor: 'distributors',
    dealer_reseller: 'dealers_resellers',
    retailer: 'retailers',
    brand_owner: 'brand_owners_private_label',
    private_label_buyer: 'brand_owners_private_label',
    oem_buyer: 'oem_component_buyers',
    industrial_end_user: 'industrial_end_users',
    commercial_end_user: 'commercial_institutional_buyers',
    system_integrator: 'integrators_contractors',
    contractor_specifier: 'integrators_contractors',
    procurement_partner: 'procurement_channel_partners',
  }
  return ensureMinimumSearchCategories(
    defaultRelationships(archetype)
      .map((relationship) => relationshipCategories[relationship])
      .filter((value): value is SearchCategory => Boolean(value)),
    [...SEARCH_CATEGORIES],
  )
}

function fallbackBuyerSegment(relationship: BuyerRelationship): string {
  const labels: Record<BuyerRelationship, string> = {
    importer: 'Importers handling this product category',
    distributor: 'Distributors with an established downstream network',
    dealer_reseller: 'Specialist dealers and resellers',
    retailer: 'Retailers with a matching product assortment',
    brand_owner: 'Brands with a matching product portfolio',
    private_label_buyer: 'Private-label buyers',
    oem_buyer: 'OEMs that integrate or consume the offer',
    industrial_end_user: 'Industrial companies that use the offer in operations',
    commercial_end_user: 'Commercial and institutional operators',
    system_integrator: 'System integrators',
    contractor_specifier: 'Contractors and project specifiers',
    procurement_partner: 'Procurement and sourcing partners',
  }
  return labels[relationship]
}

function fallbackUseCase(
  relationship: BuyerRelationship,
  productRole: ProductRole,
): string {
  if (relationship === 'oem_buyer') return `Integrate or consume the ${productRole}`
  if (relationship === 'industrial_end_user') return `Use the ${productRole} in operations`
  if (relationship === 'brand_owner' || relationship === 'private_label_buyer') {
    return 'Sell the offer under its own brand or product line'
  }
  if (relationship === 'commercial_end_user') return 'Deploy the offer across facilities'
  if (relationship === 'system_integrator' || relationship === 'contractor_specifier') {
    return 'Specify or install the offer in customer projects'
  }
  return 'Import, stock, market, and resell the offer'
}

function fallbackRequiredEvidence(relationship: BuyerRelationship): string {
  const evidence: Partial<Record<BuyerRelationship, string>> = {
    importer: 'Import, distribution, or represented-brand evidence',
    distributor: 'Matching catalog, brands, dealer network, or distribution coverage',
    dealer_reseller: 'Matching products, showroom, installation, or reseller evidence',
    retailer: 'Matching assortment and active retail operations',
    brand_owner: 'Matching owned product line and external sourcing likelihood',
    private_label_buyer: 'Private-label, OEM, sourcing, or owned-brand evidence',
    oem_buyer: 'Evidence the company consumes or integrates this component, material, or service',
    industrial_end_user: 'Relevant facilities, processes, equipment, or procurement activity',
    commercial_end_user: 'Relevant facilities, use case, multi-site operation, or procurement activity',
    system_integrator: 'Relevant project, integration, installation, or specification evidence',
    contractor_specifier: 'Relevant project, bid, specification, or installation evidence',
    procurement_partner: 'Evidence it sources this category for clients or member organizations',
  }
  return evidence[relationship] || 'Evidence of a concrete downstream purchase motion'
}

function ensureMinimumSearchCategories(
  preferred: SearchCategory[],
  fallback: SearchCategory[],
): SearchCategory[] {
  const combined = [...preferred, ...fallback, ...SEARCH_CATEGORIES]
    .filter(uniqueString) as SearchCategory[]
  const targetCount = Math.min(8, Math.max(7, new Set(preferred).size))
  return combined.slice(0, targetCount)
}

function boundedPriority(value: unknown): 1 | 2 | 3 {
  const number = Math.round(asFiniteNumber(value, 3))
  return number <= 1 ? 1 : number === 2 ? 2 : 3
}

function enumArray<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  const allowedSet = new Set<string>(allowed)
  return asStringArray(value)
    .map((item) => item.toLowerCase())
    .filter((item): item is T => allowedSet.has(item))
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T
function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: null,
): T | null
function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T | null,
): T | null {
  const normalized = asString(value).toLowerCase()
  return (allowed as readonly string[]).includes(normalized)
    ? normalized as T
    : fallback
}

function relationshipLabel(value: string): string {
  const labels: Record<string, string> = {
    importer: 'Importer',
    distributor: 'Distributor',
    dealer_reseller: 'Dealer / Reseller',
    retailer: 'Retailer',
    brand_owner: 'Brand Owner',
    private_label_buyer: 'Private-label Buyer',
    oem_buyer: 'OEM / Component Buyer',
    industrial_end_user: 'Industrial End User',
    commercial_end_user: 'Commercial / Institutional Buyer',
    system_integrator: 'System Integrator',
    contractor_specifier: 'Contractor / Specifier',
    procurement_partner: 'Procurement Partner',
  }
  return labels[value] || 'Downstream Buyer'
}

function cleanText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength - 3).trim()}...`
}

function cleanQuery(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '')
}

function compactSearchTerm(value: string): string {
  return cleanText(value.replace(/["']/g, ''), 80)
}

function nonEmptyArray(value: unknown, fallback: string[]): string[] {
  const array = asStringArray(value)
  return array.length ? array : fallback
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = asFiniteNumber(value, Number.NaN)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function uniqueString(value: string, index: number, values: string[]): boolean {
  return values.findIndex((item) => item.toLowerCase() === value.toLowerCase()) === index
}

function uniqueStringInsensitive(value: string, index: number, values: string[]): boolean {
  return values.findIndex((item) => item.toLowerCase() === value.toLowerCase()) === index
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

async function mapWithConcurrency<T, R>(
  items: T[],
  requestedConcurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const concurrency = Math.max(1, Math.min(Math.floor(requestedConcurrency) || 1, items.length || 1))
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()))
  return results
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function recordDiagnostic(
  config: EngineConfig,
  stage: string,
  error: unknown,
): void {
  if (!config.diagnostics) return
  const sanitized = errorMessage(error)
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[redacted-api-key]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
  const diagnostic = `${stage}: ${cleanText(sanitized, 240)}`
  if (!config.diagnostics.includes(diagnostic) && config.diagnostics.length < 20) {
    config.diagnostics.push(diagnostic)
  }
}

