import { Router } from 'express';
import type { Db } from '../db/pool.js';
import { requirePermission } from '../auth/middleware.js';

/**
 * Read-only reference catalogue shared by the rental and tyre/oil workflows.
 * URLs are inert source metadata only: the server never visits, proxies or previews them.
 * Vehicle fitments are advisory and are never an automatic authorization to fit a part or oil.
 */
export function vehicleCatalogRouter(db: Db): Router {
  const r = Router();

  r.get('/', requirePermission(db, 'vehicles.read'), async (_req, res) => {
    const [
      brands, models, generations, engines,
      tireBrands, tireModels, tireSizes, tireFitments,
      oilBrands, oilProducts, oilFitments,
      maintenance, marketPriority, sources, statusReference,
    ] = await Promise.all([
      db.query(
        'SELECT id, name, segment, market_note AS "marketNote", verification_status AS "verificationStatus" FROM vehicle_catalog_brands ORDER BY name',
      ),
      db.query(
        `SELECT m.id, m.brand_id AS "brandId", b.name AS "brandName", m.name,
                m.data_status AS "dataStatus", m.notes, m.source_note AS "sourceNote",
                m.start_year AS "startYear", m.end_year AS "endYear", m.body_type AS "bodyType",
                m.engine_descriptions AS "engineDescriptions", m.generation_label AS "generationLabel",
                m.engine_code AS "engineCode", m.fuel_type AS "fuelType", m.transmission,
                m.power_kw AS "powerKw", m.displacement_cm3 AS "displacementCm3", m.checked_on AS "checkedOn"
           FROM vehicle_catalog_models m JOIN vehicle_catalog_brands b ON b.id = m.brand_id
          ORDER BY b.name, m.name`,
      ),
      db.query(
        `SELECT g.id, g.model_id AS "modelId", g.brand_id AS "brandId", g.label,
                g.generation_code AS "generationCode", g.production_start_year AS "productionStartYear",
                g.production_end_year AS "productionEndYear", g.reference_year AS "referenceYear",
                g.body_type AS "bodyType", g.market, g.source_id AS "sourceId",
                g.source_url AS "sourceUrl", g.verification_status AS "verificationStatus", g.notes
           FROM vehicle_catalog_generations g ORDER BY g.label`,
      ),
      db.query(
        `SELECT e.id, e.generation_id AS "generationId", e.commercial_version AS "commercialVersion",
                e.engine_designation AS "engineDesignation", e.engine_code AS "engineCode",
                e.displacement_cm3 AS "displacementCm3", e.cylinders, e.fuel_type AS "fuelType",
                e.power_hp AS "powerHp", e.power_kw AS "powerKw", e.torque_nm AS "torqueNm",
                e.gearbox, e.gears, e.source_id AS "sourceId",
                e.verification_status AS "verificationStatus", e.notes
           FROM vehicle_catalog_engines e ORDER BY e.commercial_version`,
      ),
      db.query(
        'SELECT id, name, origin, positioning, availability FROM vehicle_catalog_tire_brands ORDER BY name',
      ),
      db.query(
        `SELECT m.id, m.brand_id AS "brandId", b.name AS "brandName", m.name,
                m.vehicle_type AS "vehicleType", m.season, m.usage, m.verification
           FROM vehicle_catalog_tire_models m JOIN vehicle_catalog_tire_brands b ON b.id = m.brand_id
          ORDER BY b.name, m.name`,
      ),
      db.query(
        `SELECT size, width_mm AS "widthMm", aspect_ratio AS "aspectRatio", rim_inches AS "rimInches",
                load_index AS "loadIndex", speed_index AS "speedIndex", reinforced, run_flat AS "runFlat",
                compatibility_status AS "compatibilityStatus", note
           FROM vehicle_catalog_tire_sizes ORDER BY width_mm NULLS LAST, aspect_ratio NULLS LAST, rim_inches NULLS LAST`,
      ),
      db.query(
        `SELECT f.id, f.generation_id AS "generationId", f.engine_id AS "engineId",
                g.label AS "generationLabel", e.commercial_version AS "engineVersion",
                f.trim, f.position, f.dimension, f.load_index AS "loadIndex", f.speed_index AS "speedIndex",
                f.reinforced, f.run_flat AS "runFlat", f.compatibility_type AS "compatibilityType",
                f.source_id AS "sourceId", f.source_url AS "sourceUrl", f.checked_on AS "checkedOn",
                f.verification_status AS "verificationStatus", f.notes
           FROM vehicle_catalog_tire_fitments f
           JOIN vehicle_catalog_generations g ON g.id = f.generation_id
           LEFT JOIN vehicle_catalog_engines e ON e.id = f.engine_id
          ORDER BY g.label, f.trim`,
      ),
      db.query(
        'SELECT id, name, origin, availability FROM vehicle_catalog_oil_brands ORDER BY name',
      ),
      db.query(
        `SELECT p.id, p.brand_id AS "brandId", b.name AS "brandName", p.name,
                p.indicative_viscosity AS "indicativeViscosity", p.technology, p.usage, p.verification,
                p.acea, p.api, p.oem_approval AS "oemApproval", p.packaging,
                p.item_reference AS "itemReference", p.technical_sheet_source AS "technicalSheetSource",
                p.final_status AS "finalStatus"
           FROM vehicle_catalog_oil_products p JOIN vehicle_catalog_oil_brands b ON b.id = p.brand_id
          ORDER BY b.name, p.name, p.indicative_viscosity`,
      ),
      db.query(
        `SELECT f.id, f.generation_id AS "generationId", f.engine_id AS "engineId",
                g.label AS "generationLabel", e.commercial_version AS "engineVersion",
                f.engine_version AS "fitmentEngineVersion", f.sae_viscosity AS "saeViscosity",
                f.acea, f.api, f.oem_approval AS "oemApproval", f.capacity_l AS "capacityL",
                f.oil_filter_ref AS "oilFilterRef", f.source_id AS "sourceId",
                f.verification_status AS "verificationStatus", f.notes
           FROM vehicle_catalog_oil_fitments f
           JOIN vehicle_catalog_generations g ON g.id = f.generation_id
           JOIN vehicle_catalog_engines e ON e.id = f.engine_id
          ORDER BY g.label, e.commercial_version`,
      ),
      db.query(
        'SELECT id, name, examples, interval_guidance AS "intervalGuidance", source_status AS "sourceStatus" FROM vehicle_catalog_maintenance ORDER BY name',
      ),
      db.query(
        `SELECT p.priority_rank AS rank, b.name AS "brandName", m.name AS "modelName",
                p.registrations, p.market_share_pct AS "marketSharePct", p.period,
                p.source_id AS "sourceId", p.notes
           FROM vehicle_catalog_market_priority p
           JOIN vehicle_catalog_brands b ON b.id = p.brand_id
           JOIN vehicle_catalog_models m ON m.id = p.model_id
          ORDER BY p.period DESC, p.priority_rank`,
      ),
      db.query(
        `SELECT id, publisher, title, source_type AS "sourceType", url, source_date AS "sourceDate",
                scope, reliability, notes
           FROM vehicle_catalog_sources ORDER BY publisher, title`,
      ),
      db.query(
        'SELECT code, label, trigger_description AS "triggerDescription", blocks_rental AS "blocksRental", expected_action AS "expectedAction", exit_rule AS "exitRule" FROM vehicle_catalog_status_reference ORDER BY code',
      ),
    ]);

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      brands: brands.rows,
      models: models.rows,
      generations: generations.rows,
      engines: engines.rows,
      tireBrands: tireBrands.rows,
      tireModels: tireModels.rows,
      tireSizes: tireSizes.rows,
      tireFitments: tireFitments.rows,
      oilBrands: oilBrands.rows,
      oilProducts: oilProducts.rows,
      oilFitments: oilFitments.rows,
      maintenance: maintenance.rows,
      marketPriority: marketPriority.rows,
      sources: sources.rows,
      statusReference: statusReference.rows,
      compatibilityIsAdvisory: true,
    });
  });

  return r;
}
