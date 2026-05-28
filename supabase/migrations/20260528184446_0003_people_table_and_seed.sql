-- ════════════════════════════════════════════════════════════════════
-- 0003 · people: contacts the rule engine cares about.
-- Each row is one email address. Same human at multiple addresses
-- gets multiple rows (e.g. Melinda Fleming at UBB AND AireBeam).
-- Seeded from Chris's writeup (May 2026).
-- ════════════════════════════════════════════════════════════════════

create table public.people (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  org text,
  role text,
  role_category text not null check (role_category in (
    'internal','vendor','utility','partner_isp','government','contractor',
    'engineering','legal','automated','sales','family','applicant','customer','other'
  )),
  priority_tier text not null default 'normal' check (priority_tier in (
    'critical','high','normal','low','noise'
  )),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index people_priority_idx on public.people (priority_tier)
  where priority_tier in ('critical','high');
create index people_role_category_idx on public.people (role_category);
create index people_org_idx on public.people (org);

create trigger people_set_updated_at
  before update on public.people
  for each row execute function public.set_updated_at();

alter table public.people enable row level security;
create policy people_authenticated_all on public.people
  for all to authenticated
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

-- find_person(): used by the rule matcher to look up sender priority/role.
-- (Switched to SECURITY INVOKER in 0005.)
create or replace function public.find_person(p_sender text)
returns table (id uuid, priority_tier text, role_category text, org text, name text)
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.priority_tier, p.role_category, p.org, p.name
  from public.people p
  where lower(p.email) = lower(p_sender)
  limit 1;
$$;

revoke execute on function public.find_person(text) from public, anon;
grant execute on function public.find_person(text) to authenticated;

-- ─── seed: SESD (utility) ───────────────────────────────────────────
insert into public.people (email, name, org, role, role_category, priority_tier, notes) values
  ('ryan@sesdofutah.org',   'Ryan Bagley',       'SESD', 'System Planner',   'utility','critical','Phase planning + pole attachment'),
  ('brook@sesdofutah.org',  'Brook Christensen', 'SESD', 'Pole Attachments', 'utility','critical',null),
  ('greg@sesdofutah.org',   'Greg',              'SESD', null,               'utility','critical',null);

-- ─── seed: UBB internal staff ───────────────────────────────────────
insert into public.people (email, name, org, role, role_category, priority_tier, notes) values
  ('belkins@utahbroadband.com',    'Ben Elkins',       'Utah Broadband','CEO',                   'internal','high',null),
  ('avonalmen@utahbroadband.com',  'Amber Von Almen',  'Utah Broadband','Accounting',            'internal','high',null),
  ('gvonalmen@utahbroadband.com',  'Grady Von Almen',  'Utah Broadband','Fiber Infrastructure',  'internal','high',null),
  ('csperry@utahbroadband.com',    'Chad Sperry',      'Utah Broadband','Infrastructure Lead',   'internal','high',null),
  ('tjeffreys@utahbroadband.com',  'Trevor Jeffreys',  'Utah Broadband','Field Tech Manager',    'internal','high',null),
  ('smiller@utahbroadband.com',    'Sharon Miller',    'Utah Broadband','HR Manager',            'internal','high',null),
  ('msimmons@utahbroadband.com',   'Mike Simmons',     'Utah Broadband',null,                    'internal','high',null),
  ('steve@utahbroadband.com',      'Steve McGhie',     'Utah Broadband',null,                    'internal','high',null),
  ('dhall@utahbroadband.com',      'Danny Hall',       'Utah Broadband','OSP Engineer',          'internal','high',null),
  ('canderson@utahbroadband.com',  'Clint Anderson',   'Utah Broadband','Quartermaster',         'internal','high',null),
  ('mfleming@utahbroadband.com',   'Melinda Fleming',  'Utah Broadband',null,                    'internal','critical','Reconnect lead'),
  ('mfilleman@utahbroadband.com',  'Michelle Filleman','Utah Broadband',null,                    'internal','high','Always flag (per Chris)'),
  ('mchisam@utahbroadband.com',    'Maura Chisam',     'Utah Broadband',null,                    'internal','normal',null),
  ('lee@utahbroadband.com',        'Lee Olsen',        'Utah Broadband',null,                    'internal','normal',null),
  ('svalentine@utahbroadband.com', 'Shem Valentine',   'Utah Broadband',null,                    'internal','normal',null),
  ('bcox@utahbroadband.com',       'Braden Cox',       'Utah Broadband','Field',                 'internal','normal',null),
  ('jmckenna@utahbroadband.com',   'J. McKenna',       'Utah Broadband',null,                    'internal','normal',null),
  ('acasper@utahbroadband.com',    'Austin Casper',    'Utah Broadband','Field/Locating',        'internal','normal',null),
  ('kriding@utahbroadband.com',    'Karl Riding',      'Utah Broadband',null,                    'internal','normal',null),
  ('bclarke@utahbroadband.com',    'B. Clarke',        'Utah Broadband',null,                    'internal','normal',null),
  ('btyler@utahbroadband.com',     'Brian Tyler',      'Utah Broadband',null,                    'internal','normal',null),
  ('jward@utahbroadband.com',      'Jacob Ward',       'Utah Broadband','Infrastructure',        'internal','normal',null),
  ('jpienaar@utahbroadband.com',   'Jaco Pienaar',     'Utah Broadband','Field',                 'internal','normal',null),
  ('trandall@utahbroadband.com',   'Taryn Randall',    'Utah Broadband','Field',                 'internal','normal',null),
  ('abreur@utahbroadband.com',     'A. Breur',         'Utah Broadband',null,                    'internal','normal',null),
  ('lspier@utahbroadband.com',     'L. Spier',         'Utah Broadband',null,                    'internal','normal',null),
  ('awiddison@utahbroadband.com',  'Anthony Widdison', 'Utah Broadband','Field',                 'internal','normal',null),
  ('fcarmona@utahbroadband.com',   'Francisco Carmona','Utah Broadband','Field',                 'internal','normal',null),
  ('mike@utahbroadband.com',       'Mike (general)',   'Utah Broadband',null,                    'internal','normal','Alias / catchall'),
  ('gcabrera@utahbroadband.com',   'Gabe Cabrera',     'Utah Broadband',null,                    'internal','normal',null),
  ('langford@utahbroadband.com',   'Langford Lloyd',   'Utah Broadband',null,                    'internal','normal',null),
  ('ariddell@utahbroadband.com',   'Athina Riddell',   'Utah Broadband',null,                    'family','normal','Sister; works at UBB'),
  ('purchasing@utahbroadband.com', 'Purchasing alias', 'Utah Broadband','Alias',                 'internal','high',null),
  ('accounting@utahbroadband.com', 'Accounting alias', 'Utah Broadband','Alias',                 'internal','high',null),
  ('hr@utahbroadband.com',         'HR alias',         'Utah Broadband','Alias',                 'internal','normal',null),
  ('engineering@utahbroadband.com','Engineering alias','Utah Broadband','Alias',                 'internal','high',null),
  ('jobs@utahbroadband.com',       'Jobs alias',       'Utah Broadband','Alias',                 'internal','normal','Inbound applications'),
  ('bluestakes@utahbroadband.com', 'Bluestakes alias', 'Utah Broadband','Alias',                 'internal','normal','Locate-ticket forwarding');

-- ─── seed: Power & Tel (vendor) ─────────────────────────────────────
insert into public.people (email, name, org, role, role_category, priority_tier, notes) values
  ('brandon.skinner@ptsupply.com','Brandon Skinner','Power & Tel','Account Manager',              'vendor','high',null),
  ('travis.stewart@ptsupply.com', 'Travis Stewart', 'Power & Tel','District Sales Manager UT/WY','vendor','high',null);

-- ─── seed: Heber Power (utility) ────────────────────────────────────
insert into public.people (email, name, org, role, role_category, priority_tier, notes) values
  ('cbethers@heberpower.com','Cathie Bethers','Heber Power','Project Coordinator','utility','high',null),
  ('rwright@heberpower.com', 'Riley Wright',  'Heber Power',null,                  'utility','high',null);

-- ─── seed: Millennium Telecom (partner ISP) ─────────────────────────
insert into public.people (email, name, org, role, role_category, priority_tier, notes) values
  ('clint@mtpllc.us',         'Clint',          'Millennium Telecom Partners',null,            'partner_isp','normal',null),
  ('rose.hewitt@mtpllc.us',   'Rose Hewitt',    'Millennium Telecom Partners','Client Success','partner_isp','normal',null),
  ('tyler.rosh@mtpllc.us',    'Tyler Rosh',     'Millennium Telecom Partners',null,            'partner_isp','normal',null),
  ('anne.hotchkiss@mtpllc.us','Anne Hotchkiss', 'Millennium Telecom Partners',null,            'partner_isp','normal',null),
  ('lesa.paulson@mtpllc.us',  'Lesa Paulson',   'Millennium Telecom Partners',null,            'partner_isp','normal',null);

-- ─── seed: Infowest (partner ISP) ───────────────────────────────────
insert into public.people (email, name, org, role, role_category, priority_tier, notes) values
  ('adam.leonard@infowest.com',  'Adam Leonard',     'Infowest',null,'partner_isp','normal',null),
  ('darrell@infowest.com',       'Darrell',          'Infowest',null,'partner_isp','normal',null),
  ('cbl@infowest.com',           'Cassidy B. Larson','Infowest',null,'partner_isp','normal',null),
  ('jacob@infowest.com',         'Jacob B.',         'Infowest',null,'partner_isp','normal',null),
  ('haylee.whitney@infowest.com','Haylee Whitney',   'Infowest',null,'partner_isp','normal',null),
  ('sarah.lanter@infowest.com',  'Sarah Lanter',     'Infowest',null,'partner_isp','normal',null),
  ('sarah.lanter@infowestinc.onmicrosoft.com','Sarah Lanter (alt)','Infowest',null,'partner_isp','normal','Alt address');

-- ─── seed: Calix (vendor) ───────────────────────────────────────────
insert into public.people (email, name, org, role, role_category, priority_tier, notes) values
  ('kateylyn.metcalf@calix.com','Kateylyn Metcalf','Calix','Sales Engineer',               'vendor','normal',null),
  ('jason.hughes@calix.com',    'Jason Hughes',    'Calix','Senior SmartLife Delivery Mgr','vendor','normal',null),
  ('dan.martin@calix.com',      'Dan Martin',      'Calix',null,                            'vendor','normal',null),
  ('cory.drees@calix.com',      'Cory Drees',      'Calix',null,                            'vendor','normal',null),
  ('michael.finnerty@calix.com','Michael Finnerty','Calix','Senior Project Manager',        'vendor','normal',null),
  ('leif.fallang@calix.com',    'Leif Fallang',    'Calix','SmartLife Delivery Mgr',        'vendor','normal',null),
  ('victor.carrillo@calix.com', 'Victor Carrillo', 'Calix',null,                            'vendor','normal',null),
  ('angie.heisler@calix.com',   'Angie Heisler',   'Calix',null,                            'vendor','normal',null),
  ('liz.christie@calix.com',    'Liz Christie',    'Calix',null,                            'vendor','normal',null);

-- ─── seed: Core Telecom (partner) ───────────────────────────────────
insert into public.people (email, name, org, role, role_category, priority_tier, notes) values
  ('jshell@coretelecom.net','James Shell','Core Telecom Systems','Sales','partner_isp','normal',null),
  ('ksager@coretelecom.net','Karra Sager','Core Telecom Systems',null,   'partner_isp','normal',null);

-- ─── seed: BOB Fiber / AireBeam ─────────────────────────────────────
insert into public.people (email, name, org, role, role_category, priority_tier, notes) values
  ('frank@bobfiber.com',       'Frank DeJoy',     'BOB Fiber','CTO / VP Govt Affairs','partner_isp','high',    null),
  ('melinda@airebeam.net',     'Melinda Fleming', 'AireBeam', 'Finance Director',     'partner_isp','critical','Same person as mfleming@utahbroadband.com — Reconnect lead'),
  ('maura.chisam@airebeam.net','Maura Chisam',    'AireBeam', null,                   'partner_isp','normal',  'Also at UBB');

-- ─── seed: Non Typical Supply (vendor) ──────────────────────────────
insert into public.people (email, name, org, role, role_category, priority_tier, notes) values
  ('kendee@non-typicalsupply.com','Kendee',      'Non Typical Supply',null,'vendor','normal',null),
  ('nontypicalsupply@gmail.com',  'Dallas Gallo','Non Typical Supply',null,'vendor','normal',null);

-- ─── seed: Graybar (vendor) ─────────────────────────────────────────
insert into public.people (email, name, org, role, role_category, priority_tier, notes) values
  ('noah.austin@graybar.com',     'Noah Austin',     'Graybar','Outside Sales','vendor','normal',null),
  ('jack.fitzgibbons@graybar.com','Jack Fitzgibbons','Graybar','Sales Trainee','vendor','normal',null);

-- ─── seed: other vendors ────────────────────────────────────────────
insert into public.people (email, name, org, role, role_category, priority_tier, notes) values
  ('ryan.vansickle@plp.com',  'Ryan VanSickle', 'PLP',    'Field Sales Mgr','vendor','normal',null),
  ('marianne.boring@pano.ai', 'Marianne Boring','Pano AI',null,             'vendor','normal',null),
  ('jonathan.carr@altec.com', 'Jonathan Carr',  'Altec',  null,             'vendor','normal',null);

-- ─── seed: contractors ──────────────────────────────────────────────
insert into public.people (email, name, org, role, role_category, priority_tier, notes) values
  ('randsdrilling@gmail.com',          'Joseph',     'R&S Directional Drilling',null,                  'contractor','high','Always flag (per Chris)'),
  ('pronghorn.communications@gmail.com','Garrett',   'Pronghorn Communications','Splicer',             'contractor','normal',null),
  ('classicjackdev@gmail.com',         'Tyrell Gray','Heber Project (Mill Road)',null,                 'contractor','normal',null),
  ('kelly.morgan@stakerparson.com',    'Kelly Morgan','Staker Parson','Project Mgr / Estimator',       'contractor','normal',null),
  ('mvasil@cticonnect.com',            'Mike Vasil', 'CTI Connect',null,                               'contractor','normal',null),
  ('mkahle@cticonnect.com',            'M. Kahle',   'CTI Connect',null,                               'contractor','normal',null),
  ('nshah@cticonnect.com',             'N. Shah',    'CTI Connect',null,                               'contractor','normal',null),
  ('raquel.ellis@taec.net',            'Raquel Ellis','TAEC','Verizon coordination',                    'contractor','normal',null);

-- ─── seed: engineering / legal / government / water ─────────────────
insert into public.people (email, name, org, role, role_category, priority_tier, notes) values
  ('chandler.sobisky@horrocks.com','Chandler Sobisky','Horrocks Engineering',null,'engineering','high',null),
  ('shelley.mortimer@horrocks.com','Shelley Mortimer','Horrocks Engineering',null,'engineering','high',null),
  ('bpeck@bpecklaw.net',           'Beatrice Peck',   'BPeck Law',           null,'legal',      'high',null),
  ('mshively@usbr.gov',            'Melissa Shively','Bureau of Reclamation',          null,'government','high',null),
  ('rshelley@cuwcd.gov',           'Rob Shelley',    'Central Utah Water Conservancy', null,'government','high',null),
  ('dales@paysonutah.gov',         'Dale Shaw',      'Payson City',                    null,'government','high',null),
  ('contact@highvalleywater.com',  'Justin Rametta', 'High Valley Water',              null,'government','high',null),
  ('mlarson@shlcco.com',           'Marty Larson',   'Strawberry Highline Canal Co',   null,'government','high',null);

-- ─── seed: customer / other ─────────────────────────────────────────
insert into public.people (email, name, org, role, role_category, priority_tier, notes) values
  ('christina@wickedfastinternet.com','Christina',                     'Wickedfast Internet',null,'other',    'normal',null),
  ('riley.jensen98@gmail.com',         'Riley Jensen',                  null,                 'Tower tech applicant','applicant','normal',null),
  ('craptaculous55@gmail.com',         'Personal contact (Dekaround?)', null,                 null,'other',    'normal',null);

-- ─── seed: noise / auto-senders ─────────────────────────────────────
insert into public.people (email, name, org, role, role_category, priority_tier, notes) values
  ('drive-shares-noreply@google.com',  'Google Drive (auto)',null,    'Auto',       'automated','noise',null),
  ('quickbooks@notification.intuit.com','QuickBooks (auto)', null,    'Auto',       'automated','noise',null),
  ('noreply@ksl.com',                  'KSL Jobs (auto)',    null,    'Auto',       'automated','noise',null),
  ('noreply@lookermail.com',           'Looker (auto)',      null,    'Auto',       'automated','noise',null),
  ('scoleman@clickup.com',             'Scott Coleman',      'ClickUp',null,        'sales',    'low','ClickUp marketing/onboarding'),
  ('gabriella.faubert@topgolf.com',    'Gabriella Faubert',  'Topgolf','Inside Sales','sales',  'low',null);
