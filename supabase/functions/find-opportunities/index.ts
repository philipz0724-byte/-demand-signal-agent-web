import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type SearchResult = { title: string; url: string; content: string; published_date?: string }

type Project = {
  id: string
  partner_name: string
  website: string
  offer: string
  target_geography: string
  target_customer: string
  advantages: string
  competitors: string
  exclusions: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing authorization header')

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const supabase = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })

    const { project_id, target_count = 15 } = await req.json()
    if (!project_id) throw new Error('project_id is required')

    const { data: project, error } = await supabase.from('prospecting_projects').select('*').eq('id', project_id).single()
    if (error || !project) throw new Error(error?.message || 'Project not found')

    const tavilyKey = Deno.env.get('TAVILY_API_KEY')
    const openAIKey = Deno.env.get('OPENAI_API_KEY')
    const model = Deno.env.get('OPENAI_MODEL') || 'gpt-5-mini'
    if (!tavilyKey) throw new Error('TAVILY_API_KEY is not configured in Supabase Edge Function secrets')
    if (!openAIKey) throw new Error('OPENAI_API_KEY is not configured in Supabase Edge Function secrets')

    const queries = await createSearchQueries(project as Project, openAIKey, model)
    const searchResults = await runSearch(queries, tavilyKey)
    const opportunities = await rankOpportunities(project as Project, searchResults, Math.min(Number(target_count) || 15, 25), openAIKey, model)

    return json({ project_id, queries, searched_sources: searchResults.length, opportunities })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Unknown error' }, 400)
  }
})

async function createSearchQueries(project: Project, apiKey: string, model: string): Promise<string[]> {
  const prompt = `You are a B2B commercial opportunity research strategist.
Create 10 precise web search queries that can discover companies worth contacting for the partner below.
Do not focus only on explicit purchasing. Cover:
1. active purchasing or supplier searches
2. expansion, funding, hiring, new facilities or product launches
3. businesses with recurring structural need
4. supplier replacement or second-source potential
5. distributor, reseller or channel partnerships

Partner: ${project.partner_name}
Website: ${project.website}
Offer: ${project.offer}
Target geography: ${project.target_geography}
Target customer: ${project.target_customer}
Advantages: ${project.advantages}
Competitors: ${project.competitors}
Exclusions: ${project.exclusions}

Return JSON only: {"queries":["..."]}`

  const output = await callOpenAI(prompt, apiKey, model)
  const parsed = safeJson(output)
  return Array.isArray(parsed?.queries) ? parsed.queries.slice(0, 12) : [
    `companies expanding ${project.target_customer} ${project.target_geography}`,
    `new product launch ${project.target_customer} ${project.target_geography}`,
    `hiring supply chain manager ${project.target_customer} ${project.target_geography}`,
    `looking for supplier ${project.offer} ${project.target_geography}`,
  ]
}

async function runSearch(queries: string[], apiKey: string): Promise<SearchResult[]> {
  const batches = await Promise.all(queries.map(async (query) => {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, search_depth: 'advanced', max_results: 6, include_answer: false, include_raw_content: false }),
    })
    if (!response.ok) return []
    const data = await response.json()
    return (data.results || []).map((item: Record<string, string>) => ({ title: item.title, url: item.url, content: item.content, published_date: item.published_date }))
  }))

  const unique = new Map<string, SearchResult>()
  for (const item of batches.flat()) {
    try {
      const host = new URL(item.url).hostname.replace(/^www\./, '')
      const key = `${host}|${item.title}`
      if (!unique.has(key)) unique.set(key, item)
    } catch { /* ignore invalid URLs */ }
  }
  return [...unique.values()].slice(0, 60)
}

async function rankOpportunities(project: Project, results: SearchResult[], targetCount: number, apiKey: string, model: string) {
  const sourceText = results.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\nDate: ${r.published_date || 'unknown'}\n${r.content}`).join('\n\n')
  const prompt = `You are a rigorous B2B commercial opportunity analyst. Rank real companies that are worth contacting for this partner.

PARTNER
Name: ${project.partner_name}
Offer: ${project.offer}
Target geography: ${project.target_geography}
Target customer: ${project.target_customer}
Advantages: ${project.advantages}
Exclusions: ${project.exclusions}

PUBLIC SEARCH EVIDENCE
${sourceText}

RULES
- Return at most ${targetCount} companies.
- A company may qualify through explicit demand, a trigger event, recurring structural need, replacement potential, channel partnership, or strong strategic fit.
- Do not invent companies, events, URLs, dates, facts or evidence.
- The evidence URL must come from the supplied sources.
- Separate observed facts from inference.
- Exclude directories, news publishers, consultants and irrelevant vendors unless they are genuine channel partners.
- opportunity_score is 0-100 and combines strategic fit, trigger strength, timing, commercial value and evidence quality.
- confidence is 0-100 and reflects how strongly the supplied evidence supports the conclusion.
- Prefer fewer credible results over weak filler.

Return JSON only with this shape:
{"opportunities":[{"company_name":"","website":"","location":"","company_type":"","opportunity_type":"Active Purchase|Expansion Trigger|Recurring Buyer|Supplier Replacement|Channel Partner|Strategic Fit","fit_reason":"","current_trigger":"","likely_need":"","evidence_title":"","evidence_url":"","evidence_snippet":"","buyer_role":"","outreach_angle":"","opportunity_score":0,"confidence":0}]}`

The evidence snippet must be a concise paraphrase, not a long quote.`

  const output = await callOpenAI(prompt, apiKey, model)
  const parsed = safeJson(output)
  return Array.isArray(parsed?.opportunities) ? parsed.opportunities : []
}

async function callOpenAI(input: string, apiKey: string, model: string): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input, reasoning: { effort: Deno.env.get('OPENAI_REASONING_EFFORT') || 'low' }, text: { format: { type: 'json_object' } } }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error?.message || 'OpenAI request failed')
  return data.output_text || data.output?.flatMap((x: { content?: { text?: string }[] }) => x.content || []).map((x: { text?: string }) => x.text || '').join('') || '{}'
}

function safeJson(text: string) {
  try { return JSON.parse(text) } catch {
    const match = text.match(/\{[\s\S]*\}/)
    return match ? JSON.parse(match[0]) : {}
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}
