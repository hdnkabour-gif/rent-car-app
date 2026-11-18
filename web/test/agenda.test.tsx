import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../src/auth';
import { BrandingProvider } from '../src/branding';
import { I18nProvider } from '../src/i18n';
import { AgendaBoard } from '../src/components/AgendaBoard';
import { moroccoDate, changeDay } from '../src/agenda';

const person = {
  user: { id:'u-test', email:'manager@example.test', fullName:'Gérant Démo', role:'manager',preferredLanguage:'fr' },
  permissions:['dashboard.view','reservations.manage','reservations.read','vehicles.read','cash.read'],
};
const json=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
const date = moroccoDate();
const dayData = {
  date, today:date,generatedAt:new Date().toISOString(),truncated:false,
  totals:{reservations:1,pickups:0,returns:0,attention:0,outstandingCents:21000},
  items:[
    {id:'reservation:demo',kind:'reservation',time:new Date().toISOString(),title:'reservation',
      vehicle:{id:'car-demo',plate:'45678-أ-1',make:'Dacia',model:'Logan',photoFileId:null},branch:'Casablanca',
      customer:'Client fictif',reference:'17',detail:'agency',link:'/reservations/demo',overdue:false,urgent:false,amountCents:null,provisional:false},
  ],
};
const mount=(lang:'fr'|'ar'='fr')=>render(
  <I18nProvider initial={lang}><AuthProvider><BrandingProvider>
    <MemoryRouter><AgendaBoard/></MemoryRouter>
  </BrandingProvider></AuthProvider></I18nProvider>,
);
afterEach(()=>vi.unstubAllGlobals());

describe('Moroccan agenda-first home',()=>{
  it('uses real Casablanca-local dates and correct Gregorian next/previous days',()=>{
    expect(changeDay('2026-12-31',1)).toBe('2027-01-01');
    expect(changeDay('2026-03-01',-1)).toBe('2026-02-28');
    expect(moroccoDate(new Date('2026-11-18T23:40:00Z'))).toMatch(/^2026-11-(18|19)$/);
  });

  it('renders an actual event with MAD and a clear link, never inventing an image',async()=>{
    const requests:string[]=[];
    vi.stubGlobal('fetch',vi.fn((url:string)=>{
      requests.push(url);
      if(url==='/api/auth/me')return json(person);
      if(url==='/api/branding')return json({name:'JMR LUXE CAR',color:'#111827',city:'Casablanca',logo:null});
      if(url.startsWith('/api/dashboard/agenda?'))return json(dayData);
      return json({error:{code:'not_found'}},404);
    }));
    const {container}=mount();
    expect(await screen.findByText('Réservation prévue')).toBeInTheDocument();
    expect(screen.getByText('Dacia Logan')).toBeInTheDocument();
    expect(screen.getByText('Client fictif')).toBeInTheDocument();
    expect(screen.getByRole('link',{name:/Réservation prévue/})).toHaveAttribute('href','/reservations/demo');
    expect(container.querySelector('.agenda-event__visual img')).toBeNull();
    expect(container.querySelectorAll('.agenda-event')).toHaveLength(1);
    expect(requests.filter(url=>url.includes('dashboard/agenda'))).toHaveLength(1);
    expect(requests.some(url=>/narsa|payments\/|external/i.test(url))).toBe(false);
    const user=userEvent.setup();
    await user.click(screen.getByRole('button',{name:'Semaine suivante'}));
    await waitFor(()=>expect(requests.filter(url=>url.includes('dashboard/agenda')).length).toBe(2));
  });

  it('renders Arabic labels and keeps empty data genuinely empty',async()=>{
    vi.stubGlobal('fetch',vi.fn((url:string)=>{
      if(url==='/api/auth/me')return json({...person,user:{...person.user,preferredLanguage:'ar'}});
      if(url==='/api/branding')return json({name:'JMR LUXE CAR',color:'#111827',city:'Casablanca',logo:null});
      if(url.startsWith('/api/dashboard/agenda?'))return json({...dayData,items:[],totals:{reservations:0,pickups:0,returns:0,attention:0,outstandingCents:0}});
      return json({},404);
    }));
    mount('ar');
    expect(await screen.findByText('لا توجد عمليات في هذا اليوم')).toBeInTheDocument();
    expect(screen.getByRole('heading',{name:'جدول الكراء'})).toBeInTheDocument();
    expect(screen.queryByText('Dacia Logan')).not.toBeInTheDocument();
  });
});
