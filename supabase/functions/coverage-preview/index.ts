const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders })

  try {
    const { task, current_results = [] } = await req.json()
    if (typeof task !== 'string' || task.trim().length < 8) {
      return new Response(JSON.stringify({ error: 'task must be at least 8 characters' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const apiKey = Deno.env.get('OPENAI_API_KEY')
    if (!apiKey) {
      return new Response(JSON.stringify({
        supplied_count: Array.isArray(current_results) ? current_results.length : 0,
        new_entities_found: 0,
        verified_new_entities: 0,
        search_passes: 0,
        saturation: 'not_reached',
        known_gaps: ['OPENAI_API_KEY is not configured on the Edge Function.'],
        sample_new_entities: [],
        full_price_usd: 0.25,
        note: 'Live web coverage preview is not configured yet.',
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const supplied = Array.isArray(current_results) ? current_results.map(String).slice(0, 100) : []
    const model = Deno.env.get('OPENAI_MODEL') || 'gpt-5.5'
    const prompt = `You are the preview engine for AgentCoverage, a research-coverage service for AI agents.\n\nTASK:\n${task.trim()}\n\nCURRENT ENTITIES (${supplied.length}):\n${supplied.join('\n') || '(none)'}\n\nRun a deliberately shallow but useful web search preview. Search from at least two meaningfully different query/source angles when possible. Find candidate entities relevant to the task that are not already in CURRENT ENTITIES. Do not claim exhaustive or mathematical completeness. Prefer entities you can support with a public web source.\n\nReturn ONLY valid JSON with this shape:\n{\n  "new_entities_found": number,\n  "verified_new_entities": number,\n  "search_passes": 2,\n  "saturation": "not_reached" | "approaching" | "reached",\n  "known_gaps": [string, ...],\n  "sample_new_entities": [{"name": string, "url": string, "reason": string}, ... up to 8],\n  "note": string\n}\n\nFor a two-pass preview, normally use saturation=not_reached unless the search space is clearly bounded. The note must explicitly state that this is a preview and not a completeness guarantee.`

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        tools: [{ type: 'web_search', search_context_size: 'medium' }],
        tool_choice: 'required',
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
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
