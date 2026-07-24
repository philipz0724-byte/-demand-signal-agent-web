import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  analyzeCompany,
  buildICP,
  executeSearch,
  flattenSearchPlan,
  generateSearchPlan,
  mapValueChain,
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
  let stage = 'request_validation'
  let projectSettings: Record<string, unknown> = {}
  let supabase: ReturnType<typeof createClient> | null = null

  try {
    // The Supabase gateway verifies the publishable key/JWT before this handler runs.
    // Do not require an Authorization header here: new publishable keys may arrive via `apikey`.
    const supabaseUrl = requiredEnvironmentVariable('SUPABASE_URL')
    const serviceRoleKey = requiredEnvironmentVariable('SUPABASE_SERVICE_ROLE_KEY')
    supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    })

    const requestBody = await readRequestBody(request) as {
      project_id?: unknown
      target_count?: unknown
    }
    projectId = typeof requestBody.project_id === 'string'
      ? requestBody.project_id.trim()
      : ''
    if (!projectId) throw new HttpError(400, 'project_id is required', 'INVALID_PROJECT_ID')

    stage = 'project_lookup'
    const { data, error } = await supabase
      .from('prospecting_projects')
      .select('*')
      .eq('id', projectId)
      .single()
    if (error?.code === 'PGRST116' || !data) {
      throw new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND')
    }
    if (error) throw new HttpError(500, error.message, error.code || 'PROJECT_LOOKUP_FAILED')

    const project = normalizeProject(data as ProjectRecord)
    if (!project.website) {
      throw new HttpError(400, 'Project website is required', 'WEBSITE_REQUIRED')
    }
    projectSettings = asRecord((data as Record<string, unknown>).settings)
    stage = 'status_update'
    const { error: statusError } = await supabase
      .from('prospecting_projects')
      .update({ status: 'analyzing' })
      .eq('id', projectId)
    if (statusError) {
      throw new HttpError(500, statusError.message, statusError.code || 'STATUS_UPDATE_FAILED')
    }

    stage = 'configuration'
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
      diagnostics: [],
    }
    const targetCount = boundedInteger(requestBody.target_count, 15, 1, 25)

    // Each stage owns one factory-export responsibility and has a safe fallback.
    stage = 'factory_intelligence'
    const intelligence = await analyzeCompany(project, config)
    stage = 'value_chain_mapping'
    const valueChain = await mapValueChain(project, intelligence, config)
    stage = 'buyer_profile_and_search_planning'
    const [icp, searchPlan] = await Promise.all([
      buildICP(project, intelligence, valueChain, config),
      generateSearchPlan(project, intelligence, valueChain, null, config),
    ])
    const planEntries = flattenSearchPlan(searchPlan)
    stage = 'buyer_search'
    const rawResults = await executeSearch(searchPlan, config)
    const normalizedCompanies = normalizeResults(rawResults, project.website)
    stage = 'commercial_judgement'
    const opportunities = await scoreCompanies(
      project,
      intelligence,
      valueChain,
      icp,
      normalizedCompanies,
      targetCount,
      config,
    )
    const warnings = [
      ...(config.diagnostics || []).map((diagnostic) => `Stage fallback: ${diagnostic}`),
      ...intelligence.evidence_gaps.map((gap) => `Factory data gap: ${gap}`),
      ...(rawResults.length === 0 ? ['No search results were returned; check search credentials or factory inputs.'] : []),
      ...(normalizedCompanies.length === 0 && rawResults.length > 0
        ? ['Search results were found, but none passed company normalization.']
        : []),
      ...(opportunities.length === 0 && normalizedCompanies.length > 0
        ? ['Candidates were found, but none had enough evidence to pass the Commercial Judge.']
        : []),
    ].filter(uniqueWarning).slice(0, 12)

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
    stage = 'result_persistence'
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
          factory_intelligence: intelligence,
          company_intelligence: intelligence,
          value_chain: valueChain,
          icp,
          search_plan_summary: Object.fromEntries(
            Object.entries(searchPlan).map(([category, queries]) => [
              category,
              queries.length,
            ]),
          ),
          searched_sources: rawResults.length,
          last_run_warnings: warnings,
          last_error: null,
          profile_source: 'factory_export_agent_v3',
        },
      })
      .eq('id', projectId)
    if (updateError) {
      throw new HttpError(500, updateError.message, updateError.code || 'RESULT_SAVE_FAILED')
    }

    // Keep the existing frontend API unchanged; richer scoring fields are additive.
    const response: FindOpportunitiesResponse = {
      project_id: projectId,
      queries: planEntries.map((entry) => entry.query),
      searched_sources: rawResults.length,
      opportunities,
      factory_profile: intelligence,
      value_chain: valueChain,
      icp,
      warnings,
    }
    return json(response)
  } catch (error) {
    const failure = normalizeFailure(error)
    console.error('find-opportunities failed:', {
      stage,
      code: failure.code,
      message: failure.message,
    })
    if (supabase && projectId) {
      await supabase
        .from('prospecting_projects')
        .update({
          status: 'failed',
          settings: {
            ...projectSettings,
            last_error: failure.message,
            last_error_code: failure.code,
            last_error_stage: stage,
            last_error_at: new Date().toISOString(),
          },
        })
        .eq('id', projectId)
    }
    return json({
      error: failure.message,
      code: failure.code,
      stage,
      retryable: failure.retryable,
    }, failure.status)
  }
})

function requiredEnvironmentVariable(name: string): string {
  const value = Deno.env.get(name)
  if (!value) {
    throw new HttpError(
      500,
      `${name} is not configured in Supabase Edge Function secrets`,
      'MISSING_SERVER_CONFIGURATION',
    )
  }
  return value
}

async function readRequestBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON', 'INVALID_JSON')
  }
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly retryable = status >= 500,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

function normalizeFailure(error: unknown): {
  status: number
  code: string
  message: string
  retryable: boolean
} {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    }
  }
  return {
    status: 500,
    code: 'UNEXPECTED_ERROR',
    message: error instanceof Error ? error.message : 'Unknown error',
    retryable: true,
  }
}

function uniqueWarning(value: string, index: number, values: string[]): boolean {
  return Boolean(value) &&
    values.findIndex((item) => item.toLowerCase() === value.toLowerCase()) === index
}

