import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  flattenSearchPlan,
  generateSearchPlan,
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
    searchResult('Hotel Procurement', 'https://www.example.com/hospitality', 'hospitality'),
    searchResult('Example Wellness', 'https://shop.example.com/chairs', 'dealers'),
    searchResult('Industry report', 'https://marketsandmarkets.com/report/123', 'enterprise'),
    searchResult('Wikipedia', 'https://en.wikipedia.org/wiki/Massage_chair', 'retailers'),
    searchResult('Partner', 'https://realrelaxmassage.com/dealers', 'dealers'),
  ]

  const companies = normalizeResults(results, 'https://realrelaxmassage.com')
  assert.equal(companies.length, 1)
  assert.equal(companies[0].domain, 'example.com')
  assert.deepEqual(companies[0].matched_categories.sort(), ['dealers', 'hospitality'])
  assert.equal(companies[0].evidence.length, 2)
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

test('generateSearchPlan gracefully creates 60 downstream queries when OpenAI is unavailable', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('offline')
  }

  try {
    const plan = await generateSearchPlan(projectFixture, intelligenceFixture, icpFixture, config)
    const entries = flattenSearchPlan(plan)
    const queryText = entries.map((entry) => entry.query).join('\n').toLowerCase()
    assert.equal(entries.length, 60)
    assert.equal(entries.some((entry) => /\b(oem|factory|raw material)\b/i.test(entry.query)), false)
    assert.match(queryText, /hotel/)
    assert.match(queryText, /physical therapy equipment dealer/)
    assert.match(queryText, /senior living/)
    assert.match(queryText, /spa equipment dealer/)
    assert.match(queryText, /office furniture dealer/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scoreCompanies emits explainability fields and a server-calculated commercial score', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    output_text: JSON.stringify({
      judgements: [{
        domain: 'wellness-dealer.com',
        decision: 'accept',
        relationship: 'dealer',
        company_name: 'Wellness Dealer',
        location: 'California, United States',
        company_type: 'Commercial wellness equipment dealer',
        why_recommended: 'It sells finished wellness equipment to commercial facilities.',
        why_now: 'Its commercial catalog shows an active, recurring category need.',
        likely_need: 'Affordable massage chairs for its commercial catalog.',
        likely_buyer_role: 'Category Buyer',
        outreach_angle: 'Offer a dealer assortment and volume pricing discussion.',
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

  const candidates: NormalizedCompany[] = [{
    company_name: 'Wellness Dealer',
    domain: 'wellness-dealer.com',
    website: 'https://wellness-dealer.com',
    matched_categories: ['dealers'],
    matched_queries: ['massage chair dealer'],
    evidence: [{
      title: 'Commercial Wellness Equipment',
      url: 'https://wellness-dealer.com/commercial',
      snippet: 'Official catalog for commercial wellness equipment and facility projects.',
    }],
  }]

  try {
    const opportunities = await scoreCompanies(
      projectFixture,
      intelligenceFixture,
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
  advantages: ['Value positioning'],
  competitors: [],
  exclusions: [],
}

const intelligenceFixture: CompanyIntelligence = {
  business_model: 'Direct-to-consumer massage-chair brand',
  products: ['Massage chairs'],
  target_market: ['Home wellness'],
  customer_segments: ['Consumers'],
  pricing_position: 'Affordable',
  distribution_channels: ['Direct ecommerce'],
  geographic_focus: ['United States'],
  ideal_downstream_buyers: [
    'Massage chair dealers',
    'Commercial wellness equipment distributors',
  ],
  excluded_company_types: ['Manufacturers', 'Competitors'],
}

const icpFixture: IdealCustomerProfile = {
  tier_1_buyers: [{
    segment: 'Massage chair dealers',
    rationale: 'They buy finished chairs for resale',
    purchase_use_case: 'Dealer catalog',
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
