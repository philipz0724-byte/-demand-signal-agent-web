const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
}

type Entity = { name: string; url?: string; reason?: string }

function extractOutputText(payload: any): string {
  if (typeof payload?.output_text === 'string') return payload.output_text
  const parts: string[] = []
  for (const item of payload?.output || []) {
    if (item?.type !== 'message') continue
    for (const c of item?.content || []) if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text)
  }
  return parts.join('\n')
}

function parseJson(text: string) {
  const clean = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('Model did not return JSON')
  return JSON.parse(clean.slice(start, end + 1))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method === 'GET') return new Response(JSON.stringify({
    service: 'AgentCoverage', capability: 'coverage_check', status: 'online', preview: 'free',
    use_when: 'Use when comprehensive research may have stopped too early and missing entities matter.',
    input: { task: 'string', current_results: 'string[] optional' }
  }), { headers: corsHeaders })
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders })

  try {
    const { task, current_results = [] } = await req.json()
    if (typeof task !== 'string' || task.trim().length < 8 || task.length > 2000) {
      return new Response(JSON.stringify({ error: 'task must be 8-2000 characters' }), { status: 400, headers: corsHeaders })
    }

    const supplied = Array.isArray(current_results) ? current_results.map(String).slice(0, 100) : []
    const apiKey = Deno.env.get('OPENAI_API_KEY')
    if (!apiKey) {
      return new Response(JSON.stringify({
        error: 'live_search_not_configured',
        supplied_count: supplied.length,
        note: 'The endpoint is online, but OPENAI_API_KEY must be configured in this Supabase project before live search can run.'
      }), { status: 503, headers: corsHeaders })
    }

    const model = Deno.env.get('OPENAI_MODEL') || 'gpt-5.6-luna'
    const prompt = `You are AgentCoverage, a preview engine that checks whether an AI research result likely missed relevant entities.\n\nTASK:\n${task.trim()}\n\nCURRENT ENTITIES (${supplied.length}):\n${supplied.join('\n') || '(none)'}\n\nUse web search from at least two meaningfully different query/source angles. Find relevant candidate entities not already in CURRENT ENTITIES. Prefer primary or authoritative sources when practical. This is deliberately a shallow preview: never claim mathematical completeness of the open web.\n\nReturn ONLY valid JSON:\n{\n  "new_entities_found": number,\n  "verified_new_entities": number,\n  "search_passes": 2,\n  "saturation": "not_reached" | "approaching" | "reached",\n  "known_gaps": [string],\n  "sample_new_entities": [{"name": string, "url": string, "reason": string}],\n  "note": string\n}\nReturn at most 8 sample_new_entities. Normally use saturation=not_reached for this preview. The note must say this is a preview, not a completeness guarantee.`

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        tools: [{ type: 'web_search', search_context_size: 'medium' }],
        input: prompt,
      }),
    })
    if (!response.ok) throw new Error(`OpenAI error ${response.status}: ${(await response.text()).slice(0, 500)}`)
    const payload = await response.json()
    const parsed = parseJson(extractOutputText(payload))
    const entities: Entity[] = Array.isArray(parsed.sample_new_entities) ? parsed.sample_new_entities.slice(0, 8) : []

    return new Response(JSON.stringify({
      supplied_count: supplied.length,
      new_entities_found: Number(parsed.new_entities_found || entities.length),
      verified_new_entities: Number(parsed.verified_new_entities || 0),
      search_passes: Number(parsed.search_passes || 2),
      saturation: ['not_reached', 'approaching', 'reached'].includes(parsed.saturation) ? parsed.saturation : 'not_reached',
      known_gaps: Array.isArray(parsed.known_gaps) ? parsed.known_gaps.slice(0, 8) : ['Open-web coverage is not mathematically bounded.'],
      sample_new_entities: entities,
      full_price_usd: 0.25,
      note: String(parsed.note || 'Experimental two-pass preview; not a completeness guarantee.'),
      service: 'AgentCoverage',
      capability: 'coverage_check'
    }), { headers: corsHeaders })
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'unknown error' }), { status: 500, headers: corsHeaders })
  }
})
