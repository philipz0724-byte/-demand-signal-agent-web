# Factory Export Buyer Agent

Private commercial-intelligence pipeline for representing factories and finding overseas buyers.

## Pipeline

1. `analyzeCompany()` builds a verified factory and export profile.
2. `mapValueChain()` determines the product's role and valid downstream transaction paths.
3. `buildICP()` creates buyer tiers, personas, qualification rules, and cautious deal estimates.
4. `generateSearchPlan()` creates 40-80 relationship-specific searches.
5. `executeSearch()` runs searches concurrently.
6. `normalizeResults()` deduplicates official company domains and removes content/marketplace noise.
7. `scoreCompanies()` verifies the transaction direction, scores commercial value, and drafts outreach.

The engine judges the transaction relationship rather than rejecting a company by label. A
manufacturer can be a valid buyer when it consumes a component, material, package, machine, or
manufacturing service. Upstream vendors, peer competitors, publishers, directories, and
marketplaces are rejected.

## API compatibility

The legacy response fields remain unchanged:

```json
{
  "project_id": "...",
  "queries": [],
  "searched_sources": 0,
  "opportunities": []
}
```

Factory profile, value-chain, ICP, warnings, and outreach fields are additive.

