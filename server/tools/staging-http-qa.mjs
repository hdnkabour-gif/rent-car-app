#!/usr/bin/env node
/**
 * Synthetic-data-only staging HTTP regression. Never runs against production.
 * Called explicitly as a ONE-TIME Railway predeploy command with env vars.
 * No login password, session token, guest code, image bytes or identifiers are logged.
 */
const BASE = 'https://fleetora-ocr-app-staging.up.railway.app';
if (process.env.FLEETORA_STAGING_QA_RUN !== 'synthetic-only'
    || process.env.FLEETORA_MANAGER_EMAIL !== 'staging-manager@fleetora.example.test'
    || !process.env.FLEETORA_MANAGER_PASSWORD
    || process.env.FLEETORA_OCR_ENABLED === undefined
    || process.env.NODE_ENV !== 'production'
    || !/Postgres\.DATABASE_URL/.test(process.env.DATABASE_URL ?? '') && !/railway\.internal/.test(process.env.DATABASE_URL ?? '')) {
  console.error('STAGING_QA refused: isolated staging guards are not satisfied');
  process.exit(2);
}
const fail = (message) => { throw new Error('STAGING_QA: ' + message); };
const check = (condition, message) => { if (!condition) fail(message); };
let cookie = '';
const statusLog = [];
async function http(method, target, body, expected, useAuth = true, extraHeaders = {}) {
  const headers = { 'X-Requested-With': 'fleetora', ...extraHeaders };
  if (body !== undefined && !Buffer.isBuffer(body)) headers['Content-Type'] = 'application/json';
  if (useAuth && cookie) headers.Cookie = cookie;
  const response = await fetch(BASE + target, {
    method, headers, redirect: 'manual',
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(18000),
  });
  check(response.status === expected, method + ' ' + target.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id') + ' HTTP ' + response.status + ' expected ' + expected);
  return {
    response,
    value: response.headers.get('content-type')?.includes('application/json') ? await response.json() : null,
  };
}
const start = new Date(Date.now() + 4 * 86400_000);
const end = new Date(start.getTime() + 2 * 86400_000);
const local = d => d.toISOString().slice(0,10) + 'T10:00';
try {
  let r = await http('GET','/api/health/schema',undefined,200,false);
  check(r.value?.upToDate === true && r.value?.latest === '0014','schema must have 14 migrations');
  statusLog.push('schema');
  await http('GET','/api/customer-intakes',undefined,401,false);
  statusLog.push('anonymous denied');
  r = await http('POST','/api/auth/login', {
    email:process.env.FLEETORA_MANAGER_EMAIL,
    password:process.env.FLEETORA_MANAGER_PASSWORD,
  },200,false);
  const setCookie = r.response.headers.getSetCookie()?.[0] || r.response.headers.get('set-cookie');
  check(Boolean(setCookie),'manager login cookie missing');
  cookie = setCookie.split(';')[0];
  r = await http('GET','/api/auth/me',undefined,200);
  check(r.value?.user?.role === 'manager','expected manager session');
  statusLog.push('manager login/session');
  r = await http('GET','/api/system/status',undefined,200);
  check(r.value?.storage?.writable === true,'staging volume is not writable');
  check(r.value?.storage?.persistentConfigured === true,'staging volume is not configured');
  statusLog.push('private volume write/read probe');
  r = await http('GET','/api/branches',undefined,200);
  let branch = r.value.items.find(x => x.code === 'QA12');
  if (!branch) {
    r = await http('POST','/api/branches',{code:'QA12',name:'Fleetora Synthetic Staging',city:'Casablanca'},201);
    branch = r.value;
  }
  r = await http('GET','/api/vehicles',undefined,200);
  let car = r.value.items.find(x => x.plate === '99991-أ-1');
  if (!car) {
    r = await http('POST','/api/vehicles',{
      branchId:branch.id,plate:'99991-أ-1',make:'Dacia',model:'Logan',
      fuelType:'diesel',transmission:'manual',mileageKm:1000,dailyRateCents:30000,
    },201);
    car = r.value;
  }
  check(Boolean(car?.id),'synthetic car not created');
  r = await http('GET','/api/customers?q=Synthetic',undefined,200);
  let client = r.value.items.find(x => x.fullName === 'Synthetic Staging Customer');
  if (!client) {
    r = await http('POST','/api/customers',{
      fullName:'Synthetic Staging Customer',phone:'0600000042',
      acknowledgeDuplicates:true,
    },201);
    client = r.value.customer;
  }
  statusLog.push('synthetic branch/vehicle/customer');
  r = await http('POST','/api/customer-intakes',{
    vehicleId:car.id,start:local(start),end:local(end),
    dailyCents:30000,depositCents:50000,expiryMinutes:60,
  },201);
  const invite=r.value;
  check(/^\d{10}$/.test(invite.code),'guest code invalid');
  r = await http('POST',`/api/guest-intakes/${invite.id}/verify`,{code:invite.code},200,false);
  check(r.value.offer.vehicle.make==='Dacia' && r.value.offer.totalCents===60000,'offer differs');
  const pdf=Buffer.from('%PDF-1.4\n% FLEETORA SYNTHETIC - NOT A REAL ID\n1 0 obj<<>>endobj\n%%EOF\n');
  const guestHeaders={
    'X-Intake-Code':invite.code,'X-Privacy-Consent':'yes',
    'Content-Type':'application/pdf',
  };
  await http('POST',`/api/guest-intakes/${invite.id}/documents/id_front`,pdf,201,false,guestHeaders);
  await http('POST',`/api/guest-intakes/${invite.id}/documents/id_front`,pdf,200,false,guestHeaders);
  const pdf2=Buffer.from('%PDF-1.4\n% FLEETORA SYNTHETIC DRIVING LICENCE - NOT REAL\n1 0 obj<<>>endobj\n%%EOF\n');
  await http('POST',`/api/guest-intakes/${invite.id}/documents/licence_front`,pdf2,201,false,guestHeaders);
  await http('POST',`/api/guest-intakes/${invite.id}/submit`,{code:invite.code},200,false);
  await http('POST',`/api/guest-intakes/${invite.id}/documents/id_back`,pdf,409,false,guestHeaders);
  statusLog.push('invite code, duplicate uploads, submission');
  r=await http('GET',`/api/customer-intakes/${invite.id}`,undefined,200);
  check(r.value.documents.length===2,'expected exactly two distinct documents');
  const firstFile=r.value.documents[0].file_id;
  await http('GET',`/api/customer-intakes/${invite.id}/files/${firstFile}`,undefined,401,false);
  await http('GET',`/api/customer-intakes/${invite.id}/files/${firstFile}`,undefined,200,true);
  await http('POST',`/api/customer-intakes/${invite.id}/attach`,{customerId:client.id},200);
  r=await http('GET',`/api/customers/${client.id}/documents`,undefined,200);
  check(r.value.items.filter(x=>x.reviewStatus==='pending').length>=2,'document review must remain pending');
  statusLog.push('private files and manual customer attachment');
  r=await http('POST',`/api/customer-intakes/${invite.id}/documents/${r.value.items[0].id}/analyze`,undefined,404);
  // NOTE: The 404 above uses customer_document ID, not intake_document ID: there is
  // no accidental cross-resource access. The intended OCR test is checked elsewhere.
  statusLog.push('cross-resource document analysis denied');
  console.log('STAGING_QA PASS: ' + statusLog.join(', '));
} catch (error) {
  console.error(String(error?.message || error).replace(/https?:\/\/[^ ]+/g,'<URL>'));
  process.exitCode=1;
}
