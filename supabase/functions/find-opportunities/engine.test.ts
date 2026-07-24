import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  flattenSearchPlan,
  generateSearchPlan,
  mapValueChain,
  normalizeProject,
  normalizeResults,
  scoreCompanies,
} from './engine.ts'
import { parseJsonObject } from './json.ts'
import {
  SEARCH_CATEGORIES,
  type CompanyIntelligence,
  type EngineConfig,
  type IdealCustomerProfile,
  type NormalizedCompany,
  type Project,
  type RawSearchResult,
  type SearchPlan,
  type ValueChainMap,
} from './types.ts'

test('parseJsonObject extracts fenced JSON and ignores surrounding prose', () => {
  const parsed = parseJsonObject('Answer:\n```json\n{"queries":["a"]}\n```\nDone', { queries: [] })
  assert.deepEqual(parsed, { queries: ['a'] })
})

test('normalizeProject supports both legacy and current database column names', () => {
  const project = normalizeProject({
    id: 'p1',
    partner_name: 'Real Relax',
    website_url: 'realrelaxmassage.com',
    offer_description: 'Massage chairs',
    target_geography: ['United States'],
    target_customer: 'Commercial wellness buyers',
    key_advantages: ['Value positioning'],
    exclusion_criteria: ['Residential-only buyers'],
  })

  assert.equal(project.website, 'https://realrelaxmassage.com/')
  assert.deepEqual(project.targetGeography, ['United States'])
  assert.deepEqual(project.advantages, ['Value positioning'])
  assert.deepEqual(project.exclusions, ['Residential-only buyers'])
})

test('normalizeResults rejects content sites and deduplicates by registrable company domain', () => {
  const results: RawSearchResult[] = [
    searchResult('Hotel Procurement', 'https://www.example.com/hospitality', 'commercial_institutional_buyers'),
    searchResult('Example Wellness', 'https://shop.example.com/chairs', 'dealers_resellers'),
    searchResult('Industry report', 'https://marketsandmarkets.com/report/123', 'industrial_end_users'),
    searchResult('Wikipedia', 'https://en.wikipedia.org/wiki/Massage_chair', 'retailers'),
    searchResult('Buyer guide', 'https://fliphtml5.com/catalog/guide', 'distributors'),
    searchResult('Partner', 'https://realrelaxmassage.com/dealers', 'dealers_resellers'),
  ]

  const companies = normalizeResults(results, 'https://realrelaxmassage.com')
  assert.equal(companies.length, 1)
  assert.equal(companies[0].domain, 'example.com')
  assert.deepEqual(
    companies[0].matched_categories.sort(),
    ['commercial_institutional_buyers', 'dealers_resellers'],
  )
  assert.equal(companies[0].evidence.length, 2)
})

test('normalizeResults uses the company brand instead of a generic page title', () => {
  const companies = normalizeResults([
    searchResult(
      'Become a Retail Partner | Floridian Brand USA',
      'https://floridianbrandusa.com/pages/become-a-retail-partner',
      'distributors',
    ),
  ], 'https://factory.example')

  assert.equal(companies[0].company_name, 'Floridian Brand USA')
})

test('search plans flatten to 40-80 grouped queries', () => {
  const plan = Object.fromEntries(
    SEARCH_CATEGORIES.map((category) => [
      category,
      Array.from({ length: 6 }, (_, index) => `${category} query ${index}`),
    ]),
  ) as SearchPlan

  const entries = flattenSearchPlan(plan)
  assert.equal(entries.length, 60)
  assert.deepEqual(new Set(entries.map((entry) => entry.category)), new Set(SEARCH_CATEGORIES))
})

test('generateSearchPlan gracefully creates 40-80 downstream queries when OpenAI is unavailable', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('offline')
  }

  try {
    const plan = await generateSearchPlan(
      projectFixture,
      intelligenceFixture,
      valueChainFixture,
      icpFixture,
      config,
    )
    const entries = flattenSearchPlan(plan)
    const queryText = entries.map((entry) => entry.query).join('\n').toLowerCase()
    assert.equal(entries.length, 42)
    assert.equal(entries.some((entry) => /\b(directory|market report|top \d+)\b/i.test(entry.query)), false)
    assert.match(queryText, /importer/)
    assert.match(queryText, /distributor/)
    assert.match(queryText, /dealer/)
    assert.match(queryText, /commercial/)
    assert.match(queryText, /procurement/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('value-chain fallback treats manufacturers as buyers only for a valid consumption path', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('offline')
  }

  const componentIntelligence: CompanyIntelligence = {
    ...intelligenceFixture,
    factory_archetype: 'components',
    products: ['Precision motor assemblies'],
    product_applications: ['Industrial automation equipment'],
  }

  try {
    const map = await mapValueChain(projectFixture, componentIntelligence, config)
    assert.equal(map.valid_buyer_relationships.includes('oem_buyer'), true)
    assert.equal(map.search_categories.includes('oem_component_buyers'), true)
    assert.match(map.decision_rule, /candidate to this factory/i)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scoreCompanies emits explainability fields and a server-calculated commercial score', async () => {
  const originalFetch = globalThis.fetch
  let requestBody: Record<string, unknown> = {}
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
    return new Response(JSON.stringify({
    output_text: JSON.stringify({
      judgements: [{
        domain: 'wellness-dealer.com',
        decision: 'accept',
        relationship: 'dealer_reseller',
        company_name: 'Wellness Dealer',
        location: 'California, United States',
        company_type: 'Commercial wellness equipment dealer',
        why_recommended: 'It sells finished wellness equipment to commercial facilities.',
        why_now: 'Its commercial catalog shows an active, recurring category need.',
        likely_need: 'Affordable massage chairs for its commercial catalog.',
        likely_buyer_role: 'Category Buyer',
        outreach_angle: 'Offer a dealer assortment and volume pricing discussion.',
        outreach_subject: 'Dealer supply discussion',
        outreach_message: 'Would you be open to reviewing a factory-direct dealer assortment?',
        next_action: 'Verify the category buyer and send the approved message.',
        evidence_url: 'https://wellness-dealer.com/commercial',
        buying_probability: 80,
        downstream_fit: 90,
        commercial_value: 70,
        estimated_purchasing_power: 60,
        timing: 50,
        evidence_quality: 75,
      }],
    }),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  const candidates: NormalizedCompany[] = [{
    company_name: 'Wellness Dealer',
    domain: 'wellness-dealer.com',
    website: 'https://wellness-dealer.com',
    matched_categories: ['dealers_resellers'],
    matched_queries: ['massage chair dealer'],
    evidence: [{
      title: 'Commercial Wellness Equipment',
      url: 'https://wellness-dealer.com/commercial',
      snippet: 'Shop by brand in our official multi-brand catalog for commercial wellness equipment and facility projects.',
    }],
  }]

  try {
    const opportunities = await scoreCompanies(
      projectFixture,
      intelligenceFixture,
      valueChainFixture,
      icpFixture,
      candidates,
      10,
      config,
    )
    assert.equal(opportunities.length, 1)
    assert.equal(opportunities[0].opportunity_score, 74)
    assert.equal(opportunities[0].fit_reason, opportunities[0].why_recommended)
    assert.equal(opportunities[0].current_trigger, opportunities[0].why_now)
    assert.equal(opportunities[0].buyer_role, opportunities[0].likely_buyer_role)
    assert.equal(opportunities[0].relationship_to_factory, 'dealer_reseller')
    assert.match(opportunities[0].outreach_message, /factory-direct/)
    assert.equal('reasoning' in requestBody, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scoreCompanies rejects the factory own brand alias even when the judge accepts it', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      output_text: JSON.stringify({
        judgements: [{
          domain: 'realrelaxmall.com',
          decision: 'accept',
          relationship: 'distributor',
          company_name: 'Real Relax Wholesale',
          evidence_url: 'https://realrelaxmall.com/pages/wholesale',
          buying_probability: 90,
          downstream_fit: 95,
          commercial_value: 80,
          estimated_purchasing_power: 80,
          timing: 70,
          evidence_quality: 90,
        }],
      }),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  const ownChannel: NormalizedCompany[] = [{
    company_name: 'Real Relax Wholesale',
    domain: 'realrelaxmall.com',
    website: 'https://realrelaxmall.com',
    matched_categories: ['distributors'],
    matched_queries: ['massage chair distributor'],
    evidence: [{
      title: 'Real Relax Wholesale',
      url: 'https://realrelaxmall.com/pages/wholesale',
      snippet: 'Real Relax wholesale and dropshipping program for massage chairs.',
    }],
  }]

  try {
    const opportunities = await scoreCompanies(
      projectFixture,
      intelligenceFixture,
      valueChainFixture,
      icpFixture,
      ownChannel,
      10,
      config,
    )
    assert.equal(opportunities.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scoreCompanies rejects own-brand dealer recruitment without third-party buying evidence', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      output_text: JSON.stringify({
        judgements: [{
          domain: 'single-brand.example',
          decision: 'accept',
          relationship: 'dealer_reseller',
          company_name: 'Single Brand',
          evidence_url: 'https://single-brand.example/become-a-dealer',
          buying_probability: 75,
          downstream_fit: 80,
          commercial_value: 70,
          estimated_purchasing_power: 65,
          timing: 60,
          evidence_quality: 75,
        }],
      }),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  const recruiter: NormalizedCompany[] = [{
    company_name: 'Single Brand',
    domain: 'single-brand.example',
    website: 'https://single-brand.example',
    matched_categories: ['dealers_resellers'],
    matched_queries: ['massage chair dealer'],
    evidence: [{
      title: 'Become a Dealer | Single Brand',
      url: 'https://single-brand.example/become-a-dealer',
      snippet: 'Become an authorized dealer and sell our own premium massage chair collection.',
    }],
  }]

  try {
    const opportunities = await scoreCompanies(
      projectFixture,
      intelligenceFixture,
      valueChainFixture,
      icpFixture,
      recruiter,
      10,
      config,
    )
    assert.equal(opportunities.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

function searchResult(
  title: string,
  url: string,
  category: RawSearchResult['category'],
): RawSearchResult {
  return {
    query: `${category} massage chair`,
    category,
    title,
    url,
    content: 'Official company page describing commercial purchasing and installation services.',
  }
}

const projectFixture: Project = {
  id: 'p1',
  partnerName: 'Real Relax',
  website: 'https://realrelaxmassage.com',
  offer: 'Affordable massage chairs',
  targetGeography: ['United States'],
  targetCustomer: 'Downstream commercial wellness buyers',
  minimumDealRequirements: '',
  advantages: ['Value positioning'],
  competitors: [],
  exclusions: [],
  factoryInput: {
    product_summary: 'Massage chairs',
    cooperation_mode: ['OEM', 'Wholesale'],
    certifications: [],
    commercial_terms: '',
    notes: '',
  },
}

const intelligenceFixture: CompanyIntelligence = {
  company_role: 'Brand-owning factory',
  factory_archetype: 'finished_goods_brand',
  business_model: 'Direct-to-consumer massage-chair brand',
  products: ['Massage chairs'],
  product_applications: ['Home and commercial wellness'],
  manufacturing_capabilities: ['Finished product supply'],
  target_market: ['Home wellness'],
  customer_segments: ['Consumers'],
  pricing_position: 'Affordable',
  commercial_terms: {
    moq: 'Not established',
    pricing: 'Not established',
    lead_time: 'Not established',
    incoterms: [],
  },
  certifications: [],
  distribution_channels: ['Direct ecommerce'],
  geographic_focus: ['United States'],
  ideal_downstream_buyers: [
    'Massage chair dealers',
    'Commercial wellness equipment distributors',
  ],
  excluded_company_types: ['Manufacturers', 'Competitors'],
  export_readiness: {
    score: 50,
    signals: ['English website'],
    gaps: ['MOQ not verified'],
  },
  evidence_gaps: ['MOQ not verified'],
}

const valueChainFixture: ValueChainMap = {
  seller_position: 'Finished-goods factory supplying overseas buyers',
  product_role: 'finished_good',
  downstream_paths: [{
    buyer_segment: 'Massage chair dealers',
    relationship: 'dealer_reseller',
    buyer_uses_product_as: 'Resell finished chairs',
    purchase_motion: 'Dealer buys finished chairs from the factory',
    priority: 1,
    required_evidence: 'Matching product catalog',
  }],
  valid_buyer_relationships: ['importer', 'distributor', 'dealer_reseller', 'retailer'],
  conditional_buyer_types: ['Brands qualify when they source finished chairs'],
  excluded_relationships: ['Upstream suppliers', 'Peer competitors'],
  search_categories: [
    'importers',
    'distributors',
    'dealers_resellers',
    'retailers',
    'brand_owners_private_label',
    'oem_component_buyers',
    'commercial_institutional_buyers',
    'procurement_channel_partners',
  ],
  decision_rule: 'Accept only when payment flows from the candidate to this factory.',
}

const icpFixture: IdealCustomerProfile = {
  tier_1_buyers: [{
    segment: 'Massage chair dealers',
    relationship: 'dealer_reseller',
    rationale: 'They buy finished chairs for resale',
    purchase_use_case: 'Dealer catalog',
    required_evidence: 'Matching product catalog',
  }],
  tier_2_buyers: [],
  tier_3_buyers: [],
  buyer_personas: ['Category Buyer'],
  purchasing_departments: ['Procurement'],
  typical_purchase_cycle: 'One to three months',
  estimated_deal_size: {
    currency: 'USD',
    minimum: 5_000,
    maximum: 50_000,
    basis: 'Estimated dealer order',
  },
  qualification_questions: ['Do they currently stock massage chairs?'],
  disqualifiers: ['Manufacturers'],
}

const config: EngineConfig = {
  openAI: {
    apiKey: 'test-key',
    model: 'test-model',
    reasoningEffort: 'low',
  },
  tavily: {
    apiKey: 'test-key',
    concurrency: 4,
  },
}

