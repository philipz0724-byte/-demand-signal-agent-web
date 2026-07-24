import {
  SEARCH_CATEGORIES,
  type BuyerTier,
  type CompanyEvidence,
  type CompanyIntelligence,
  type EngineConfig,
  type IdealCustomerProfile,
  type NormalizedCompany,
  type Opportunity,
  type Project,
  type ProjectRecord,
  type RawSearchResult,
  type ScoreDimensions,
  type SearchCategory,
  type SearchPlan,
  type SearchPlanEntry,
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
  /\b(raw materials?|components?|parts supplier|oem|odm|factory|factories|contract manufactur|manufacturers?|wholesale source|industry report|market report|directory|list of|top \d+)\b/i
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
  return {
    id: asString(record.id),
    partnerName: asString(record.partner_name) || domainLabel(website) || 'Unknown partner',
    website: normalizeWebsite(website),
    offer: asString(record.offer_description) || asString(record.offer),
    targetGeography: asStringArray(record.target_geography),
    targetCustomer: asString(record.target_customer),
    advantages: [
      ...asStringArray(record.key_advantages),
      ...asStringArray(record.advantages),
    ].filter(uniqueString),
    competitors: asStringArray(record.competitors),
    exclusions: [
      ...asStringArray(record.exclusion_criteria),
      ...asStringArray(record.exclusions),
    ].filter(uniqueString),
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
    return fallback
  }
}

export async function buildICP(
  project: Project,
  intelligence: CompanyIntelligence,
  config: EngineConfig,
): Promise<IdealCustomerProfile> {
  const fallback = fallbackICP(project, intelligence)

  try {
    const raw = await callOpenAIJson<Record<string, unknown>>(
      icpPrompt(project, intelligence),
      config,
      {},
    )
    return normalizeICP(raw, fallback)
  } catch (error) {
    console.warn('ICP building fell back to deterministic tiers:', errorMessage(error))
    return fallback
  }
}

export async function generateSearchPlan(
  project: Project,
  intelligence: CompanyIntelligence,
  icp: IdealCustomerProfile,
  config: EngineConfig,
): Promise<SearchPlan> {
  let generated: Record<string, unknown> = {}

  try {
    const raw = await callOpenAIJson<Record<string, unknown>>(
      searchPlanPrompt(project, intelligence, icp, SEARCH_CATEGORIES),
      config,
      {},
    )
    generated = asRecord(raw.groups)
  } catch (error) {
    console.warn('Search planning fell back to deterministic queries:', errorMessage(error))
  }

  return ensureCompleteSearchPlan(generated, project, intelligence, icp)
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
  icp: IdealCustomerProfile,
  companies: NormalizedCompany[],
  targetCount: number,
  config: EngineConfig,
): Promise<Opportunity[]> {
  const candidates = companies.slice(0, 80)
  const batches = chunk(candidates, 10)
  const judgedBatches = await mapWithConcurrency(batches, 3, async (batch) => {
    try {
      const raw = await callOpenAIJson<{ judgements?: unknown }>(
        commercialJudgePrompt(project, intelligence, icp, batch),
        config,
        {},
      )
      return normalizeJudgements(raw.judgements, batch, intelligence)
    } catch (error) {
      // Fewer verified opportunities are safer than keyword-scored filler.
      console.warn('Commercial Judge batch failed and was omitted:', errorMessage(error))
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
  const inferredBuyerSegments = project.targetCustomer
    ? [project.targetCustomer]
    : ['Commercial organizations that buy or resell the finished offer']

  return {
    business_model: project.offer
      ? `Sells ${project.offer}`
      : 'Commercial model not established from available evidence',
    products: project.offer ? [project.offer] : ['Finished commercial offer not yet established'],
    target_market: inferredBuyerSegments,
    customer_segments: inferredBuyerSegments,
    pricing_position: 'Not established from available evidence',
    distribution_channels: ['Direct B2B sales', 'Qualified downstream channel partners'],
    geographic_focus: project.targetGeography.length
      ? project.targetGeography
      : ['Geography not specified'],
    ideal_downstream_buyers: inferredBuyerSegments,
    excluded_company_types: [
      'Manufacturers and OEM/ODM factories',
      'Raw-material and component suppliers',
      'Competitors',
      'Blogs, news sites, directories, and marketplaces',
      ...project.exclusions,
    ].filter(uniqueString),
  }
}

function normalizeCompanyIntelligence(
  raw: Record<string, unknown>,
  fallback: CompanyIntelligence,
): CompanyIntelligence {
  return {
    business_model: asString(raw.business_model) || fallback.business_model,
    products: nonEmptyArray(raw.products, fallback.products),
    target_market: nonEmptyArray(raw.target_market, fallback.target_market),
    customer_segments: nonEmptyArray(raw.customer_segments, fallback.customer_segments),
    pricing_position: asString(raw.pricing_position) || fallback.pricing_position,
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
      'Manufacturers and OEM/ODM factories',
      'Raw-material and component suppliers',
      'Competitors',
      'Blogs, news sites, directories, and marketplaces',
    ].filter(uniqueString),
  }
}

function fallbackICP(
  project: Project,
  intelligence: CompanyIntelligence,
): IdealCustomerProfile {
  const buyers = intelligence.ideal_downstream_buyers.length
    ? intelligence.ideal_downstream_buyers
    : intelligence.customer_segments
  const tiers = buyers.map((segment, index): BuyerTier => ({
    segment,
    rationale: index === 0
      ? 'Best available downstream segment based on the partner record'
      : 'Potential downstream segment requiring evidence validation',
    purchase_use_case: `Purchase, deploy, specify, or resell ${intelligence.products[0] || project.offer}`,
  }))

  return {
    tier_1_buyers: tiers.slice(0, 3),
    tier_2_buyers: tiers.slice(3, 6).length ? tiers.slice(3, 6) : tiers.slice(0, 2),
    tier_3_buyers: tiers.slice(6, 9).length ? tiers.slice(6, 9) : tiers.slice(0, 1),
    buyer_personas: ['Procurement leader', 'Category buyer', 'Operations leader'],
    purchasing_departments: ['Procurement', 'Operations', 'Facilities'],
    typical_purchase_cycle: 'Not established; validate during outreach',
    estimated_deal_size: {
      currency: 'USD',
      minimum: null,
      maximum: null,
      basis: 'Insufficient verified pricing and volume evidence',
    },
    disqualifiers: [
      ...intelligence.excluded_company_types,
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
    return {
      segment,
      rationale: asString(record.rationale),
      purchase_use_case: asString(record.purchase_use_case),
    }
  }).filter((item): item is BuyerTier => Boolean(item))
  return tiers.length ? tiers.slice(0, 8) : fallback
}

function ensureCompleteSearchPlan(
  generated: Record<string, unknown>,
  project: Project,
  intelligence: CompanyIntelligence,
  icp: IdealCustomerProfile,
): SearchPlan {
  const fallback = buildFallbackQueries(project, intelligence, icp)
  const plan = {} as SearchPlan

  for (const category of SEARCH_CATEGORIES) {
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
  icp: IdealCustomerProfile,
): SearchPlan {
  const product = compactSearchTerm(
    intelligence.products.find((item) => item.length <= 80) || project.offer || 'commercial equipment',
  )
  const secondary = compactSearchTerm(
    intelligence.products.find((item) => item !== product && item.length <= 80) ||
      'commercial wellness equipment',
  )
  const geography = compactSearchTerm(
    intelligence.geographic_focus[0] || project.targetGeography[0] || 'United States',
  )
  const tierOne = compactSearchTerm(
    icp.tier_1_buyers[0]?.segment || intelligence.ideal_downstream_buyers[0] ||
      'commercial buyers',
  )

  return {
    dealers: [
      `"${product}" dealer "${geography}"`,
      `authorized "${product}" dealer "${geography}"`,
      `"${product}" showroom dealer commercial`,
      `"${secondary}" dealer installation`,
      `"${product}" dealer for business customers`,
      `"${product}" dealership multi-location`,
    ],
    distributors: [
      `"${product}" distributor "${geography}"`,
      `commercial "${product}" distribution company`,
      `"${secondary}" distributor dealer network`,
      `"${product}" wholesale distributor to retailers`,
      `"${product}" regional distributor`,
      `"${product}" distribution catalog commercial`,
    ],
    retailers: [
      `"${product}" specialty retailer "${geography}"`,
      `"${product}" retail showroom`,
      `"${secondary}" retailer store locations`,
      `"${product}" furniture retailer commercial`,
      `"${product}" retail chain`,
      `"${product}" online retailer official company`,
    ],
    hospitality: [
      `"${product}" hotel wellness amenity`,
      `"${product}" resort spa procurement`,
      `"${secondary}" hotel renovation wellness`,
      `hotel group spa equipment "${geography}"`,
      `resort opening wellness facilities "${geography}"`,
      `hospitality procurement company wellness equipment`,
    ],
    healthcare: [
      `"${product}" physical therapy clinic equipment`,
      `"${product}" rehabilitation center`,
      `"${secondary}" senior living procurement`,
      `senior living group wellness equipment "${geography}"`,
      `physical therapy equipment dealer "${geography}"`,
      `healthcare facility wellness procurement`,
    ],
    education: [
      `"${product}" university wellness center`,
      `"${secondary}" campus recreation procurement`,
      `college athletic recovery room equipment`,
      `university employee wellness facility "${geography}"`,
      `school district wellness facility procurement`,
      `campus recreation center renovation wellness`,
    ],
    government: [
      `"${product}" government procurement`,
      `"${secondary}" municipal wellness facility`,
      `public employee wellness equipment procurement`,
      `government recreation center equipment "${geography}"`,
      `public safety employee recovery room equipment`,
      `municipal senior center wellness equipment`,
    ],
    enterprise: [
      `"${product}" corporate wellness office`,
      `"${secondary}" workplace amenities procurement`,
      `company headquarters wellness room "${geography}"`,
      `enterprise employee wellness facilities`,
      `office furniture dealer wellness equipment`,
      `corporate campus renovation wellness amenities`,
    ],
    commercial_buyers: [
      `"${product}" "${tierOne}"`,
      `"${product}" commercial procurement "${geography}"`,
      `"${secondary}" multi-location operator`,
      `"${product}" bulk purchase business`,
      `commercial facilities buying "${product}"`,
      `"${product}" procurement manager`,
    ],
    channel_partners: [
      `"${product}" commercial installer dealer`,
      `"${secondary}" systems integrator wellness`,
      `spa equipment dealer distributor "${geography}"`,
      `hospitality procurement partner wellness equipment`,
      `office furniture dealer "${product}"`,
      `physical therapy equipment dealer "${product}"`,
    ],
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
      category: 'commercial_buyers',
      query: `site:${domain} products services industries customers`,
    },
    {
      category: 'commercial_buyers',
      query: `site:${domain} about pricing dealers distribution`,
    },
    {
      category: 'commercial_buyers',
      query: `site:${domain} warranty commercial use specifications`,
    },
  ]
  const results = await Promise.all(
    queries.map((entry) =>
      tavilySearch(entry, config, {
        includeDomains: [domain],
        maxResults: 5,
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
        max_results: options.maxResults || 5,
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
  const payload = await fetchJsonWithRetry<OpenAIResponse>(
    'https://api.openai.com/v1/responses',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openAI.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openAI.model,
        input: prompt,
        reasoning: { effort: config.openAI.reasoningEffort },
        text: { format: { type: 'json_object' } },
      }),
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
  intelligence: CompanyIntelligence,
): Opportunity[] {
  if (!Array.isArray(value)) return []
  const candidateMap = new Map(candidates.map((candidate) => [candidate.domain, candidate]))

  return value.flatMap((item): Opportunity[] => {
    const judgement = asRecord(item) as JudgeRecord
    const domain = registrableDomain(safeHostname(asString(judgement.domain)))
    const candidate = candidateMap.get(domain)
    if (!candidate || asString(judgement.decision).toLowerCase() !== 'accept') return []

    const relationship = asString(judgement.relationship).toLowerCase()
    if (!relationship || relationship === 'reject') return []

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

    const whyRecommended = asString(judgement.why_recommended) ||
      `The supplied evidence supports ${relationshipLabel(relationship)} status and a downstream use for the finished offer.`
    const whyNow = asString(judgement.why_now) ||
      'No time-specific trigger was found; the evidence supports recurring structural demand.'
    const likelyBuyerRole = asString(judgement.likely_buyer_role) ||
      'Procurement or category owner; exact title not established'
    const likelyNeed = asString(judgement.likely_need) ||
      `Potential need for ${intelligence.products[0] || 'the finished offer'}`
    const outreachAngle = asString(judgement.outreach_angle) ||
      'Validate current product mix, buying cadence, and decision ownership.'

    return [{
      company_name: asString(judgement.company_name) || candidate.company_name,
      website: candidate.website,
      location: asString(judgement.location) || 'Not established from supplied evidence',
      company_type: asString(judgement.company_type) || relationshipLabel(relationship),
      opportunity_type: relationshipLabel(relationship),
      why_recommended: whyRecommended,
      why_now: whyNow,
      likely_buyer_role: likelyBuyerRole,
      outreach_angle: outreachAngle,
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
  const leftSignal = left.matched_categories.length * 5 + left.evidence.length
  const rightSignal = right.matched_categories.length * 5 + right.evidence.length
  return rightSignal - leftSignal || left.domain.localeCompare(right.domain)
}

function companyNameFromResult(title: string, domain: string): string {
  const candidate = cleanText(title, 140)
    .split(/\s[|–—-]\s/)[0]
    .replace(/\b(home|homepage|official site|welcome to)\b/gi, '')
    .trim()
  return candidate.length >= 2 && candidate.length <= 80 ? candidate : domainLabel(domain)
}

function chooseBetterCompanyName(current: string, title: string, domain: string): string {
  const next = companyNameFromResult(title, domain)
  const domainName = domainLabel(domain).toLowerCase()
  if (current.toLowerCase() === domainName && next.toLowerCase() !== domainName) return next
  return current
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

function relationshipLabel(value: string): string {
  const labels: Record<string, string> = {
    direct_buyer: 'Direct Commercial Buyer',
    dealer: 'Dealer',
    distributor: 'Distributor',
    retailer: 'Retailer',
    procurement_partner: 'Procurement Partner',
    channel_partner: 'Channel Partner',
  }
  return labels[value] || 'Downstream Commercial Buyer'
}

function cleanText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trim()}…`
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
