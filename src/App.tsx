import { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  Clipboard,
  Download,
  ExternalLink,
  Factory,
  Loader2,
  Mail,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Sparkles,
  Target,
  X,
} from 'lucide-react'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { hasSupabaseConfig, supabase } from './lib/supabase'

type Status = 'draft' | 'analyzing' | 'ready' | 'failed'

type Opportunity = {
  company_name: string
  website: string
  location: string
  company_type: string
  opportunity_type: string
  relationship_to_factory?: string
  product_match?: string
  purchase_use_case?: string
  likely_order_type?: string
  why_recommended?: string
  why_now?: string
  likely_buyer_role?: string
  outreach_angle?: string
  outreach_subject?: string
  outreach_message?: string
  next_action?: string
  risk_flags?: string[]
  fit_reason: string
  current_trigger: string
  likely_need: string
  evidence_title: string
  evidence_url: string
  evidence_snippet: string
  buyer_role: string
  opportunity_score: number
  confidence: number
}

type FactoryIntelligence = {
  company_role?: string
  factory_archetype?: string
  products?: string[]
  manufacturing_capabilities?: string[]
  certifications?: string[]
  ideal_downstream_buyers?: string[]
  evidence_gaps?: string[]
  export_readiness?: { score?: number; signals?: string[]; gaps?: string[] }
}

type ValueChain = {
  seller_position?: string
  product_role?: string
  valid_buyer_relationships?: string[]
  decision_rule?: string
}

type Profile = {
  industries?: string[]
  buyer_roles?: string[]
  opportunity_types?: string[]
}

type FactoryInput = {
  product_summary?: string
  cooperation_mode?: string[]
  certifications?: string[]
  commercial_terms?: string
}

type ProjectSettings = {
  profile?: Profile
  factory_input?: FactoryInput
  factory_intelligence?: FactoryIntelligence
  company_intelligence?: FactoryIntelligence
  value_chain?: ValueChain
  last_error?: string | null
  last_error_stage?: string | null
  last_run_warnings?: string[]
}

type DbProject = {
  id: string
  partner_name: string
  website_url: string
  offer_description: string
  target_geography: string[]
  target_customer: string
  minimum_deal_requirements: string
  key_advantages: string[]
  exclusion_criteria: string[]
  status: Status
  created_at: string
  settings?: ProjectSettings
}

type Project = {
  id: string
  name: string
  website: string
  product: string
  geography: string
  targetCustomer: string
  commercialTerms: string
  advantages: string
  status: Status
  createdAt: string
  settings: ProjectSettings
}

type RunResult = {
  project_id: string
  queries: string[]
  searched_sources: number
  opportunities: Opportunity[]
  factory_profile?: FactoryIntelligence
  value_chain?: ValueChain
  warnings?: string[]
}

type ApiFailure = {
  error?: string
  code?: string
  stage?: string
}

const statusLabel: Record<Status, string> = {
  draft: '待分析',
  analyzing: '分析中',
  ready: '已就绪',
  failed: '失败',
}

const relationshipLabel: Record<string, string> = {
  importer: '进口商',
  distributor: '分销商',
  dealer_reseller: '经销商',
  retailer: '零售商',
  brand_owner: '品牌方',
  private_label_buyer: '贴牌买家',
  oem_buyer: 'OEM / 零部件买家',
  industrial_end_user: '工业终端',
  commercial_end_user: '商业机构买家',
  system_integrator: '系统集成商',
  contractor_specifier: '承包商 / 规格制定方',
  procurement_partner: '采购合作伙伴',
}

const factoryTypeLabel: Record<string, string> = {
  finished_goods_brand: '成品品牌工厂',
  oem_odm_finished_goods: 'OEM / ODM 成品工厂',
  commercial_equipment: '商用设备工厂',
  industrial_equipment: '工业设备工厂',
  components: '零部件工厂',
  materials: '材料工厂',
  packaging: '包装工厂',
  custom_manufacturing: '定制制造工厂',
  mixed: '综合型工厂',
  unknown: '待确认',
}

const mapProject = (project: DbProject): Project => ({
  id: project.id,
  name: project.partner_name,
  website: project.website_url,
  product: project.offer_description,
  geography: (project.target_geography || []).join(', '),
  targetCustomer: project.target_customer,
  commercialTerms: project.minimum_deal_requirements,
  advantages: (project.key_advantages || []).join(', '),
  status: project.status,
  createdAt: project.created_at,
  settings: project.settings || {},
})

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [selected, setSelected] = useState<Project | null>(null)
  const [runResult, setRunResult] = useState<RunResult | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    void loadProjects()
  }, [])

  async function loadProjects(preferredId?: string) {
    setLoading(true)
    if (!supabase) {
      setProjects([])
      setSelected(null)
      setLoading(false)
      return
    }
    const { data, error } = await supabase
      .from('prospecting_projects')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) setNotice(error.hint || error.message)
    const rows = ((data || []) as DbProject[]).map(mapProject)
    setProjects(rows)
    setSelected(rows.find((item) => item.id === preferredId) ?? rows[0] ?? null)
    setLoading(false)
  }

  async function createFactory(input: FactoryFormState) {
    setRunning(true)
    setNotice('')
    setRunResult(null)
    if (!supabase) {
      setNotice('Supabase 尚未配置。')
      setRunning(false)
      return
    }

    let normalizedWebsite = input.website.trim()
    if (!/^https?:\/\//i.test(normalizedWebsite)) {
      normalizedWebsite = `https://${normalizedWebsite}`
    }
    let hostname = ''
    try {
      hostname = new URL(normalizedWebsite).hostname.replace(/^www\./, '')
    } catch {
      setNotice('请输入有效的工厂网站。')
      setRunning(false)
      return
    }

    const payload = {
      partner_name: input.factoryName.trim() || hostname,
      website_url: normalizedWebsite,
      offer_description: input.productSummary.trim(),
      target_geography: splitList(input.geography),
      target_customer: '由 Agent 根据产品供应链动态推断',
      minimum_deal_requirements: input.commercialTerms.trim(),
      key_advantages: splitList(input.advantages),
      competitors: [],
      exclusion_criteria: splitList(input.exclusions),
      status: 'draft',
      settings: {
        factory_input: {
          product_summary: input.productSummary.trim(),
          cooperation_mode: splitList(input.cooperationMode),
          certifications: splitList(input.certifications),
          commercial_terms: input.commercialTerms.trim(),
          notes: input.notes.trim(),
        },
      },
    }
    const { data, error } = await supabase
      .from('prospecting_projects')
      .insert(payload)
      .select()
      .single()
    if (error) {
      setNotice(error.hint || error.message)
      setRunning(false)
      return
    }

    setShowForm(false)
    await research(mapProject(data as DbProject))
  }

  async function research(project: Project) {
    setRunning(true)
    setNotice('')
    setRunResult(null)
    const researching = { ...project, status: 'analyzing' as Status }
    setSelected(researching)
    setProjects((all) => all.map((item) => item.id === project.id ? researching : item))

    if (!supabase) {
      setRunning(false)
      return
    }

    const { data, error } = await supabase.functions.invoke('research-opportunities-v2', {
      body: { project_id: project.id, target_count: 15 },
    })
    if (error || data?.error) {
      setNotice(await describeFunctionError(error, data))
      await loadProjects(project.id)
      setRunning(false)
      return
    }

    setRunResult(data as RunResult)
    await loadProjects(project.id)
    setRunning(false)
  }

  const stats = useMemo(() => ({
    factories: projects.length,
    ready: projects.filter((project) => project.status === 'ready').length,
    buyers: runResult?.opportunities.length || 0,
  }), [projects, runResult])

  const intelligence = runResult?.factory_profile ||
    selected?.settings.factory_intelligence ||
    selected?.settings.company_intelligence
  const valueChain = runResult?.value_chain || selected?.settings.value_chain
  const warnings = runResult?.warnings || selected?.settings.last_run_warnings || []

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Factory size={21} /></div>
          <div><strong>Factory Growth Agent</strong><span>私人海外客户开发助手</span></div>
        </div>
        <nav>
          <button className="nav-item active"><Building2 size={18} /> 合作工厂</button>
          <button className="nav-item"><Search size={18} /> 潜在买家</button>
          <button className="nav-item"><Mail size={18} /> 开发任务</button>
          <button className="nav-item"><Target size={18} /> 商机管道</button>
        </nav>
        <div className="sidebar-note">
          <Sparkles size={18} />
          <p>判断交易方向，而不是简单排除某类公司。只保留会采购、使用、集成、贴牌或转售工厂产品的下游客户。</p>
        </div>
      </aside>

      <main>
        <header>
          <div>
            <p className="eyebrow">PRIVATE EXPORT SALES WORKSPACE</p>
            <h1>海外客户开发工作台</h1>
            <p className="subtitle">录入一家工厂，Agent 自动理解产品供应链并寻找真正的海外买家。</p>
          </div>
          <button className="primary" onClick={() => setShowForm(true)}>
            <Plus size={18} /> 添加合作工厂
          </button>
        </header>

        {!hasSupabaseConfig && <div className="demo-banner">请先配置 Supabase 连接。</div>}
        {notice && <div className="error-banner"><strong>运行失败：</strong>{notice}</div>}

        <section className="stats">
          <Stat label="合作工厂" value={stats.factories} />
          <Stat label="已完成分析" value={stats.ready} />
          <Stat label="本次验证买家" value={stats.buyers} />
        </section>

        <section className="workspace">
          <div className="project-list panel">
            <div className="panel-head">
              <div><p className="eyebrow">FACTORIES</p><h2>工厂项目</h2></div>
              <button className="icon" title="刷新" onClick={() => void loadProjects(selected?.id)}>
                <RefreshCw size={17} />
              </button>
            </div>
            {loading ? (
              <div className="empty"><Loader2 className="spin" /> 正在读取</div>
            ) : projects.length === 0 ? (
              <div className="empty">先添加一家合作工厂。</div>
            ) : projects.map((project) => (
              <button
                key={project.id}
                className={`project-row ${selected?.id === project.id ? 'selected' : ''}`}
                onClick={() => {
                  setSelected(project)
                  setRunResult(null)
                  setNotice('')
                }}
              >
                <div>
                  <strong>{project.name}</strong>
                  <span>{project.product || '等待产品资料'}</span>
                </div>
                <i className={`status ${project.status}`}>{statusLabel[project.status]}</i>
              </button>
            ))}
          </div>

          <div className="detail panel">
            {!selected ? (
              <div className="empty large">
                <Radar size={42} />
                <h2>添加第一家工厂</h2>
                <p>网站、产品和目标市场越清楚，客户判断越可靠。</p>
              </div>
            ) : (
              <>
                <div className="detail-top">
                  <div>
                    <div className="title-line">
                      <h2>{selected.name}</h2>
                      <i className={`status ${selected.status}`}>{statusLabel[selected.status]}</i>
                    </div>
                    <a href={selected.website} target="_blank" rel="noreferrer">
                      {selected.website} <ExternalLink size={13} />
                    </a>
                  </div>
                  <div className="action-row">
                    {runResult?.opportunities.length ? (
                      <button className="secondary" onClick={() => exportOpportunities(runResult.opportunities)}>
                        <Download size={17} /> 导出客户
                      </button>
                    ) : null}
                    <button className="primary" disabled={running} onClick={() => void research(selected)}>
                      {running ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
                      {running ? 'Agent 正在工作…' : '寻找海外买家'}
                    </button>
                  </div>
                </div>

                <div className="info-grid">
                  <Info label="产品 / 服务" value={selected.product} />
                  <Info label="目标地区" value={selected.geography} />
                  <Info label="合作与商务条件" value={selected.commercialTerms} />
                  <Info label="工厂优势" value={selected.advantages} />
                </div>

                {(intelligence || valueChain) && (
                  <section className="agent-snapshot">
                    <div className="results-head">
                      <div><p className="eyebrow">AGENT ANALYSIS</p><h3>工厂与供应链判断</h3></div>
                      {intelligence?.export_readiness?.score !== undefined && (
                        <span>出口资料完整度 {intelligence.export_readiness.score}/100</span>
                      )}
                    </div>
                    <div className="snapshot-grid">
                      <ProfileCard
                        title="工厂类型"
                        value={factoryTypeLabel[intelligence?.factory_archetype || 'unknown'] ||
                          intelligence?.factory_archetype || '待确认'}
                      />
                      <ProfileCard
                        title="产品角色"
                        value={valueChain?.product_role || '待确认'}
                      />
                      <ProfileCard
                        title="有效买家关系"
                        value={(valueChain?.valid_buyer_relationships || [])
                          .map((value) => relationshipLabel[value] || value)
                          .join('、')}
                      />
                    </div>
                    {valueChain?.decision_rule && <p className="decision-rule">{valueChain.decision_rule}</p>}
                    {warnings.length > 0 && (
                      <div className="warning-list">
                        <strong>需要补充或验证</strong>
                        {warnings.map((warning) => <span key={warning}>• {warning}</span>)}
                      </div>
                    )}
                  </section>
                )}

                <section className="results">
                  <div className="results-head">
                    <div>
                      <p className="eyebrow">VERIFIED DOWNSTREAM BUYERS</p>
                      <h3>经过商业判断的海外客户</h3>
                    </div>
                    {runResult && (
                      <span>{runResult.searched_sources} 条证据 · {runResult.queries.length} 个搜索</span>
                    )}
                  </div>
                  {running ? (
                    <div className="result-placeholder">
                      <Loader2 className="spin" size={22} />
                      <div><strong>Agent 正在执行完整流程</strong><span>工厂分析 → 供应链定位 → 买家搜索 → 商业验证 → 开发话术</span></div>
                    </div>
                  ) : !runResult?.opportunities.length ? (
                    <div className="result-placeholder">
                      <CheckCircle2 size={22} />
                      <span>点击“寻找海外买家”生成本次客户开发清单。</span>
                    </div>
                  ) : (
                    <div className="opportunity-list">
                      {[...runResult.opportunities]
                        .sort((left, right) => right.opportunity_score - left.opportunity_score)
                        .map((item, index) => (
                          <OpportunityCard key={`${item.website}-${index}`} item={item} rank={index + 1} />
                        ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        </section>
      </main>

      {showForm && (
        <FactoryModal
          busy={running}
          onClose={() => setShowForm(false)}
          onSubmit={createFactory}
        />
      )}
    </div>
  )
}

type FactoryFormState = {
  factoryName: string
  website: string
  productSummary: string
  geography: string
  cooperationMode: string
  certifications: string
  commercialTerms: string
  advantages: string
  exclusions: string
  notes: string
}

const initialFactoryForm: FactoryFormState = {
  factoryName: '',
  website: '',
  productSummary: '',
  geography: 'United States',
  cooperationMode: 'OEM, ODM, Wholesale',
  certifications: '',
  commercialTerms: '',
  advantages: '',
  exclusions: '',
  notes: '',
}

function FactoryModal({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean
  onClose: () => void
  onSubmit: (input: FactoryFormState) => Promise<void>
}) {
  const [form, setForm] = useState(initialFactoryForm)
  const update = (key: keyof FactoryFormState) => (value: string) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    await onSubmit(form)
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-head">
          <div>
            <p className="eyebrow">NEW FACTORY PROJECT</p>
            <h2>录入合作工厂资料</h2>
            <p className="subtitle">不知道的字段可以留空，Agent 会明确标记资料缺口。</p>
          </div>
          <button className="icon" onClick={onClose}><X /></button>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <div className="form-grid">
            <Field label="工厂名称" value={form.factoryName} onChange={update('factoryName')} />
            <Field label="工厂网站" required value={form.website} onChange={update('website')} />
            <Field label="核心产品或制造服务" wide required value={form.productSummary} onChange={update('productSummary')} />
            <Field label="目标国家或地区" required value={form.geography} onChange={update('geography')} />
            <Field label="合作模式" value={form.cooperationMode} onChange={update('cooperationMode')} />
            <Field label="认证" value={form.certifications} onChange={update('certifications')} placeholder="如 CE, FDA, ISO；没有证据不要填写" />
            <Field label="MOQ、价格、交期、贸易条款" value={form.commercialTerms} onChange={update('commercialTerms')} />
            <Field label="核心优势" value={form.advantages} onChange={update('advantages')} />
            <Field label="排除地区或客户" value={form.exclusions} onChange={update('exclusions')} />
            <Field label="其他说明" value={form.notes} onChange={update('notes')} />
          </div>
          <div className="form-actions">
            <button type="button" className="secondary" onClick={onClose}>取消</button>
            <button className="primary" disabled={busy}>
              {busy && <Loader2 className="spin" size={18} />}
              创建并寻找客户 <ArrowRight size={18} />
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function OpportunityCard({ item, rank }: { item: Opportunity; rank: number }) {
  const relationship = relationshipLabel[item.relationship_to_factory || ''] ||
    item.opportunity_type ||
    item.company_type
  const whyRecommended = item.why_recommended || item.fit_reason
  const whyNow = item.why_now || item.current_trigger
  const buyerRole = item.likely_buyer_role || item.buyer_role
  const outreach = [
    item.outreach_subject ? `Subject: ${item.outreach_subject}` : '',
    item.outreach_message || '',
  ].filter(Boolean).join('\n\n')

  return (
    <article className="opportunity-card">
      <div className="rank">#{rank}</div>
      <div className="opportunity-main">
        <div className="opportunity-title">
          <div>
            <h4>{item.company_name}</h4>
            <p>{item.company_type} · {item.location}</p>
          </div>
          <span className="opportunity-type">{relationship}</span>
        </div>

        <p className="fit-reason">{whyRecommended}</p>
        <div className="opportunity-grid">
          <Info label="产品匹配" value={item.product_match || item.likely_need} />
          <Info label="采购用途" value={item.purchase_use_case || item.likely_need} />
          <Info label="为什么现在" value={whyNow} />
          <Info label="可能负责人" value={buyerRole} />
          <Info label="订单类型" value={item.likely_order_type || '需要进一步确认'} />
          <Info label="建议下一步" value={item.next_action || item.outreach_angle} />
        </div>

        {(item.outreach_message || item.outreach_subject) && (
          <div className="outreach-box">
            <div>
              <strong>{item.outreach_subject || '建议开发内容'}</strong>
              <p>{item.outreach_message}</p>
            </div>
            <button
              className="icon"
              title="复制开发信"
              onClick={() => void navigator.clipboard.writeText(outreach)}
            >
              <Clipboard size={16} />
            </button>
          </div>
        )}

        {item.risk_flags?.length ? (
          <div className="risk-flags">{item.risk_flags.map((flag) => <span key={flag}>{flag}</span>)}</div>
        ) : null}

        <div className="evidence">
          <div><strong>{item.evidence_title}</strong><p>{item.evidence_snippet}</p></div>
          <a href={item.evidence_url || item.website} target="_blank" rel="noreferrer">
            查看证据 <ExternalLink size={14} />
          </a>
        </div>
      </div>
      <div className="score-box">
        <strong>{item.opportunity_score}</strong>
        <span>商业机会</span>
        <small>{item.confidence}% 置信度</small>
      </div>
    </article>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

function Info({ label, value }: { label: string; value?: string }) {
  return <div className="info"><span>{label}</span><p>{value || '待确认'}</p></div>
}

function ProfileCard({ title, value }: { title: string; value?: string }) {
  return (
    <article>
      <span className="result-icon"><Sparkles size={16} /></span>
      <div><h4>{title}</h4><p>{value || '待确认'}</p></div>
    </article>
  )
}

function Field({
  label,
  value,
  onChange,
  required,
  wide,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
  wide?: boolean
  placeholder?: string
}) {
  return (
    <label className={wide ? 'wide' : ''}>
      <span>{label}{required && ' *'}</span>
      <input
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

async function describeFunctionError(
  error: Error | null,
  data: unknown,
): Promise<string> {
  const direct = asRecord(data) as ApiFailure
  if (direct.error) {
    return formatApiFailure(direct)
  }
  if (error instanceof FunctionsHttpError) {
    try {
      const payload = asRecord(await error.context.json()) as ApiFailure
      if (payload.error) return formatApiFailure(payload)
    } catch {
      // Fall through to the SDK message.
    }
  }
  return error?.message || 'Agent 运行失败，请稍后重试。'
}

function formatApiFailure(failure: ApiFailure): string {
  const details = [failure.code, failure.stage].filter(Boolean).join(' / ')
  return `${failure.error || 'Agent 运行失败'}${details ? `（${details}）` : ''}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function splitList(value: string): string[] {
  return [...new Set(value.split(/[,，;\n]/).map((item) => item.trim()).filter(Boolean))]
}

function exportOpportunities(opportunities: Opportunity[]) {
  const rows = opportunities.map((item) => [
    item.company_name,
    item.website,
    item.location,
    relationshipLabel[item.relationship_to_factory || ''] || item.opportunity_type,
    item.product_match || item.likely_need,
    item.why_recommended || item.fit_reason,
    item.likely_buyer_role || item.buyer_role,
    item.outreach_subject || '',
    item.outreach_message || '',
    item.next_action || item.outreach_angle || '',
    item.opportunity_score,
    item.evidence_url,
  ])
  const header = [
    'Company',
    'Website',
    'Location',
    'Buyer relationship',
    'Product match',
    'Why recommended',
    'Likely buyer role',
    'Outreach subject',
    'Outreach message',
    'Next action',
    'Score',
    'Evidence',
  ]
  const csv = [header, ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n')
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `factory-buyers-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`
}

