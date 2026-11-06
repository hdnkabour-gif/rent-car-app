import { useState } from 'react';
import { BookOpen, CarFront, Droplets, Gauge, Wrench } from 'lucide-react';
import { useI18n } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import type { VehicleCatalog } from '../vehicles';

type Tab = 'vehicles' | 'tires' | 'oils' | 'maintenance' | 'market' | 'sources';

function text(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="catalog-table-wrap">
      <table className="catalog-table">
        <thead><tr>{headers.map((header, i) => <th key={i}>{header}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 ? <tr><td colSpan={headers.length}>—</td></tr> :
            rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

export function VehicleCatalogPage() {
  const { t } = useI18n();
  const { data, error, reload } = useApi<VehicleCatalog>('/vehicle-catalog');
  const [tab, setTab] = useState<Tab>('vehicles');
  const [search, setSearch] = useState('');

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  const query = search.trim().toLocaleLowerCase();
  const matches = (values: Array<string | number | null | undefined>) =>
    !query || values.some((value) => String(value ?? '').toLocaleLowerCase().includes(query));

  const brands = data.brands;
  const models = data.models.filter((m) => matches([m.brandName,m.name,m.dataStatus,m.generationLabel,m.engineDescriptions,m.engineCode,m.notes]));
  const tireBrands = data.tireBrands.filter((b) => matches([b.name,b.origin,b.positioning,b.availability]));
  const tireModels = data.tireModels.filter((m) => matches([m.brandName,m.name,m.vehicleType,m.season,m.usage,m.verification]));
  const tireSizes = data.tireSizes.filter((s) => matches([s.size,s.compatibilityStatus,s.note,s.loadIndex,s.speedIndex]));
  const tireFitments = data.tireFitments.filter((f) => matches([f.generationLabel,f.engineVersion,f.trim,f.dimension,f.verificationStatus,f.notes]));
  const oilBrands = data.oilBrands.filter((b) => matches([b.name,b.origin,b.availability]));
  const oilProducts = data.oilProducts.filter((p) => matches([p.brandName,p.name,p.indicativeViscosity,p.technology,p.usage,p.verification,p.acea,p.api,p.oemApproval]));
  const oilFitments = data.oilFitments.filter((f) => matches([f.generationLabel,f.engineVersion,f.saeViscosity,f.acea,f.api,f.oemApproval,f.verificationStatus,f.notes]));
  const maintenance = data.maintenance.filter((m) => matches([m.name,m.examples,m.intervalGuidance,m.sourceStatus]));
  const market = data.marketPriority.filter((m) => matches([m.brandName,m.modelName,m.period,m.notes]));
  const sources = data.sources.filter((s) => matches([s.publisher,s.title,s.sourceType,s.scope,s.reliability,s.notes,s.id]));

  const tabs: Array<{id:Tab; label:string; icon:typeof CarFront}> = [
    {id:'vehicles',label:t('catalog.tabVehicles'),icon:CarFront},
    {id:'tires',label:t('catalog.tabTires'),icon:Gauge},
    {id:'oils',label:t('catalog.tabOils'),icon:Droplets},
    {id:'maintenance',label:t('catalog.tabMaintenance'),icon:Wrench},
    {id:'market',label:t('catalog.tabMarket'),icon:BookOpen},
    {id:'sources',label:t('catalog.tabSources'),icon:BookOpen}
  ];

  return (
    <section className="vehicle-catalog-page">
      <PageHeader title={t('catalog.title')} subtitle={t('catalog.subtitle')} />
      <div className="catalog-summary-grid">
        <div className="card catalog-stat"><span>{t('catalog.carBrands')}</span><strong>{brands.length}</strong></div>
        <div className="card catalog-stat"><span>{t('catalog.carModels')}</span><strong>{data.models.length}</strong></div>
        <div className="card catalog-stat"><span>{t('catalog.engines')}</span><strong>{data.engines.length}</strong></div>
        <div className="card catalog-stat"><span>{t('catalog.tireSizes')}</span><strong>{data.tireSizes.length}</strong></div>
        <div className="card catalog-stat"><span>{t('catalog.oilProducts')}</span><strong>{data.oilProducts.length}</strong></div>
      </div>

      <div className="alert alert-info catalog-advisory" role="note">
        <strong>{t('catalog.advisoryTitle')}</strong>
        <span>{t('catalog.advisoryText')}</span>
      </div>

      <div className="catalog-toolbar">
        <div className="catalog-tabs" role="tablist" aria-label={t('catalog.title')}>
          {tabs.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
              className={tab === item.id ? 'catalog-tab active' : 'catalog-tab'}
              onClick={() => {setTab(item.id);setSearch('');}}>
              <Icon size={17} aria-hidden="true" />{item.label}
            </button>;
          })}
        </div>
        <input className="catalog-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('catalog.search')} />
      </div>

      {tab === 'vehicles' && <>
        <div className="card catalog-section">
          <div className="catalog-section-head"><h2>{t('catalog.vehicleReference')}</h2><span>{models.length} / {data.models.length}</span></div>
          <Table headers={[t('vehicles.make'),t('vehicles.model'),t('catalog.years'),t('catalog.engineFamily'),t('catalog.dataStatus'),t('catalog.notes')]}
            rows={models.map((m) => [m.brandName,m.name,(m.startYear ? String(m.startYear) : '—') + (m.endYear ? ' – ' + m.endYear : m.startYear ? ' – …' : ''),m.engineDescriptions || m.generationLabel || '—',m.dataStatus,m.notes || m.sourceNote || '—'])} />
          <p className="muted small">{t('catalog.vehicleCountHint')}</p>
        </div>
        <div className="catalog-subgrid">
          <div className="card catalog-section"><h2>{t('catalog.documentedGenerations')}</h2>
            {data.generations.map((g) => <div className="catalog-mini-row" key={g.id}><strong>{g.label}</strong><span>{g.verificationStatus}</span><small>{g.notes || '—'}</small></div>)}
          </div>
          <div className="card catalog-section"><h2>{t('catalog.documentedEngines')}</h2>
            {data.engines.map((e) => <div className="catalog-mini-row" key={e.id}><strong>{e.commercialVersion}</strong><span>{e.verificationStatus}</span>
              <small>{[e.engineDesignation,e.fuelType,e.displacementCm3 ? String(e.displacementCm3) + ' cm³' : null,e.powerHp ? String(e.powerHp) + ' ch' : null,e.gearbox].filter(Boolean).join(' · ') || '—'}</small></div>)}
          </div>
        </div>
      </>}

      {tab === 'tires' && <>
        <div className="card catalog-section"><h2>{t('catalog.tireBrands')}</h2>
          <Table headers={[t('catalog.brand'),t('catalog.origin'),t('catalog.positioning'),t('catalog.availability')]}
            rows={tireBrands.map((b) => [b.name,text(b.origin),text(b.positioning),text(b.availability)])} />
        </div>
        <div className="card catalog-section"><h2>{t('catalog.tireRanges')}</h2>
          <Table headers={[t('catalog.brand'),t('catalog.range'),t('catalog.vehicleType'),t('catalog.season'),t('catalog.use'),t('catalog.verification')]}
            rows={tireModels.map((m) => [m.brandName,m.name,text(m.vehicleType),text(m.season),text(m.usage),text(m.verification)])} />
        </div>
        <div className="card catalog-section"><h2>{t('catalog.tireSizes')}</h2>
          <Table headers={[t('catalog.dimension'),t('catalog.loadIndex'),t('catalog.speedIndex'),t('catalog.compatibility'),t('catalog.notes')]}
            rows={tireSizes.map((s) => [s.size,text(s.loadIndex),text(s.speedIndex),s.compatibilityStatus,text(s.note)])} />
        </div>
        <div className="card catalog-section"><h2>{t('catalog.documentedTireFitments')}</h2>
          <Table headers={[t('catalog.vehicle'),t('catalog.trim'),t('catalog.dimension'),t('catalog.verification'),t('catalog.notes')]}
            rows={tireFitments.map((f) => [f.generationLabel + (f.engineVersion ? ' · ' + f.engineVersion : ''),text(f.trim),f.dimension,f.verificationStatus,text(f.notes)])} />
        </div>
      </>}

      {tab === 'oils' && <>
        <div className="card catalog-section"><h2>{t('catalog.oilBrands')}</h2>
          <Table headers={[t('catalog.brand'),t('catalog.origin'),t('catalog.availability')]}
            rows={oilBrands.map((b) => [b.name,text(b.origin),text(b.availability)])} />
        </div>
        <div className="card catalog-section"><h2>{t('catalog.oilProducts')}</h2>
          <Table headers={[t('catalog.brand'),t('catalog.range'),t('catalog.indicativeViscosity'),t('catalog.technology'),t('catalog.usage'),t('catalog.verification')]}
            rows={oilProducts.map((p) => [p.brandName,p.name,text(p.indicativeViscosity),text(p.technology),text(p.usage),text(p.finalStatus || p.verification)])} />
        </div>
        <div className="card catalog-section"><h2>{t('catalog.oilFitments')}</h2>
          <Table headers={[t('catalog.vehicle'),t('catalog.engine'),t('catalog.sae'),t('catalog.aceaApiOem'),t('catalog.status'),t('catalog.notes')]}
            rows={oilFitments.map((f) => [f.generationLabel,f.engineVersion,text(f.saeViscosity),[f.acea,f.api,f.oemApproval].filter(Boolean).join(' · ') || '—',f.verificationStatus,text(f.notes)])} />
        </div>
      </>}

      {tab === 'maintenance' && <div className="card catalog-section"><h2>{t('catalog.maintenanceReference')}</h2>
        <Table headers={[t('catalog.category'),t('catalog.examples'),t('catalog.interval'),t('catalog.verification')]}
          rows={maintenance.map((m) => [m.name,text(m.examples),text(m.intervalGuidance),text(m.sourceStatus)])} />
        <p className="muted small">{t('catalog.maintenanceHint')}</p>
      </div>}

      {tab === 'market' && <div className="card catalog-section"><h2>{t('catalog.marketPriority')}</h2>
        <Table headers={[t('catalog.rank'),t('catalog.brand'),t('catalog.model'),t('catalog.registrations'),t('catalog.marketShare'),t('catalog.period'),t('catalog.notes')]}
          rows={market.map((m) => [String(m.rank),m.brandName,m.modelName,text(m.registrations),m.marketSharePct === null ? '—' : String(m.marketSharePct) + '%',m.period,text(m.notes)])} />
        <p className="muted small">{t('catalog.marketHint')}</p>
      </div>}

      {tab === 'sources' && <div className="card catalog-section"><h2>{t('catalog.sourceRegister')}</h2>
        <Table headers={[t('catalog.publisher'),t('catalog.sourceTitle'),t('catalog.sourceType'),t('catalog.reliability'),t('catalog.sourceDetails'),t('catalog.sourceId')]}
          rows={sources.map((s) => [s.publisher,s.title,text(s.sourceType),text(s.reliability),text(s.notes || s.scope) + (s.url ? ' · ' + s.url : ''),s.id])} />
        <p className="muted small">{t('catalog.sourcesHint')}</p>
      </div>}
    </section>
  );
}
