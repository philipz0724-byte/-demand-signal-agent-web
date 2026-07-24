import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  analyzeCompany,
  buildICP,
  executeSearch,
  flattenSearchPlan,
  generateSearchPlan,
  normalizeProject,
  normalizeResults,
  scoreCompanies,
} from './engine.ts'
import type {
  EngineConfig,
  FindOpportunitiesResponse,
  ProjectRecord,
} from './types.ts'
import { asRecord } from './json.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  let projectId = ''
  let projectSettings: Record<string, unknown> = {}
  let supabase: ReturnType<typeof createClient> | null = null

  try {
    const authHeader = request.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing authorization header')

    const supabaseUrl = requiredEnvironmentVariable('SUPABASE_URL')
    const serviceRoleKey = requiredEnvironmentVariable('SUPABASE_SERVICE_ROLE_KEY')
    supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    })

    const requestBody = await request.json() as {
      project_id?: unknown
      target_count?: unknown
    }
    projectId = typeof requestBody.project_id === 'string'
      ? requestBody.project_id.trim()
      : ''
    if (!projectId) throw new Error('project_id is required')

    const { data, error } = await supabase
      .from('prospecting_projects')
      .select('*')
      .eq('id', projectId)
      .single()
    if (error || !data) throw new Error(error?.message || 'Project not found')

    const project = normalizeProject(data as ProjectRecord)
    if (!project.website) throw new Error('Project website is required')
    projectSettings = asRecord((data as Record<string, unknown>).settings)
    const { error: statusError } = await supabase
      .from('prospecting_projects')
      .update({ status: 'analyzing' })
      .eq('id', projectId)
    if (statusError) throw new Error(statusError.message)

    const config: EngineConfig = {
      openAI: {
        apiKey: requiredEnvironmentVariable('OPENAI_API_KEY'),
        model: Deno.env.get('OPENAI_MODEL') || 'gpt-5-mini',
        reasoningEffort: Deno.env.get('OPENAI_REASONING_EFFORT') || 'low',
      },
      tavily: {
        apiKey: requiredEnvironmentVariable('TAVILY_API_KEY'),
        concurrency: boundedInteger(Deno.env.get('SEARCH_CONCURRENCY'), 12, 1, 20),
      },
    }
    const targetCount = boundedInteger(requestBody.target_count, 15, 1, 25)

    // Each stage owns one commercial-intelligence responsibility and has a safe fallback.
    const intelligence = await analyzeCompany(project, config)
    const icp = await buildICP(project, intelligence, config)
    const searchPlan = await generateSearchPlan(project, intelligence, icp, config)
    const planEntries = flattenSearchPlan(searchPlan)
    const rawResults = await executeSearch(searchPlan, config)
    const normalizedCompanies = normalizeResults(rawResults, project.website)
    const opportunities = await scoreCompanies(
      project,
      intelligence,
      icp,
      normalizedCompanies,
      targetCount,
      config,
    )

    const profile = {
      partner_name: project.partnerName,
      offer_description: intelligence.products.join(', ') || project.offer,
      target_customer: icp.tier_1_buyers.map((buyer) => buyer.segment).join(', ') ||
        project.targetCustomer,
      key_advantages: project.advantages,
      industries: intelligence.target_market,
      buyer_roles: icp.buyer_personas,
      opportunity_types: [...new Set(
        opportunities.map((opportunity) => opportunity.opportunity_type),
      )],
    }
    const { error: updateError } = await supabase
      .from('prospecting_projects')
      .update({
        partner_name: profile.partner_name,
        offer_description: profile.offer_description,
        target_customer: profile.target_customer,
        exclusion_criteria: intelligence.excluded_company_types,
        status: 'ready',
        settings: {
          ...projectSettings,
          profile,
          company_intelligence: intelligence,
          icp,
          search_plan_summary: Object.fromEntries(
            Object.entries(searchPlan).map(([category, queries]) => [
              category,
              queries.length,
            ]),
          ),
          searched_sources: rawResults.length,
          profile_source: 'commercial_intelligence_v2',
        },
      })
      .eq('id', projectId)
    if (updateError) throw new Error(updateError.message)

    // Keep the existing frontend API unchanged; richer scoring fields are additive.
    const response: FindOpportunitiesResponse = {
      project_id: projectId,
      queries: planEntries.map((entry) => entry.query),
      searched_sources: rawResults.length,
      opportunities,
    }
    return json(response)
  } catch (error) {
    console.error('find-opportunities failed:', error)
    if (supabase && projectId) {
      await supabase
        .from('prospecting_projects')
        .update({
          status: 'failed',
          settings: {
            ...projectSettings,
            last_error: error instanceof Error ? error.message : 'Unknown error',
          },
        })
        .eq('id', projectId)
    }
    return json({ error: error instanceof Error ? error.message : 'Unknown error' }, 400)
  }
})

function requiredEnvironmentVariable(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not configured in Supabase Edge Function secrets`)
  return value
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
